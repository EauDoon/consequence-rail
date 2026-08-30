import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import test from "node:test";
import { deepClone, digest } from "../src/canonical.js";
import {
  buildRefundProposal,
  buildRefundReservation,
  createDemoRuntime,
  runRefundDemo,
} from "../src/demo.js";
import { createReferenceServer } from "../src/http-server.js";
import { evaluatePostcondition } from "../src/postconditions.js";
import { demoConnectorTrustedKeys, demoTrustedKeys } from "../src/signing.js";
import { verifyBundle } from "../src/verify.js";

const ORDERED_OPERATORS = ["gte", "lte"];
const PROPOSAL_VERSIONS = [
  "consequence-rail/action-proposal/v0.1",
  "consequence-rail/action-proposal/v0.2",
];

let coercionCalls = 0;

const INVALID_VALUES = [
  ["numeric string", () => "1"],
  ["non-numeric string", () => "one"],
  ["true", () => true],
  ["false", () => false],
  ["null", () => null],
  ["undefined", () => undefined],
  ["array", () => [1]],
  ["plain object", () => ({ value: 1 })],
  ["boxed number", () => new Number(1)],
  ["date", () => new Date(0)],
  ["bigint", () => 1n],
  ["symbol", () => Symbol("one")],
  ["function", () => () => 1],
  ["NaN", () => Number.NaN],
  ["positive infinity", () => Number.POSITIVE_INFINITY],
  ["negative infinity", () => Number.NEGATIVE_INFINITY],
  ["coercible object", () => ({
    [Symbol.toPrimitive]() {
      coercionCalls += 1;
      return 1;
    },
  })],
];

function orderedPostcondition(operator, value) {
  return {
    op: "all",
    clauses: [{ path: "active_refund_count", op: operator, value }],
  };
}

function orderedProposal(runtime, version, operator, value) {
  const proposal = buildRefundProposal(runtime.clock);
  proposal.schema_version = version;
  proposal.postcondition = orderedPostcondition(operator, value);
  return proposal;
}

function snapshotProposal(proposal) {
  return {
    ...proposal,
    subject: { ...proposal.subject },
    target: { ...proposal.target },
    parameters: { ...proposal.parameters },
    postcondition: {
      ...proposal.postcondition,
      clauses: proposal.postcondition.clauses.map((clause) => ({ ...clause })),
    },
    evidence_plan: { ...proposal.evidence_plan },
  };
}

async function createV2AuditBundle() {
  const runtime = createDemoRuntime();
  const proposal = JSON.parse(readFileSync(
    join(process.cwd(), "conformance", "refund-action-v0.2.json"),
    "utf8",
  ));
  const proposed = runtime.rail.propose(proposal);
  runtime.rail.authorize(proposed.action_id, {
    allow: true,
    policy_id: "demo-refund-policy/v1",
    policy_digest: digest({ allow: true, ordered_postconditions: true }),
  });
  runtime.rail.reserveRecourse(
    proposed.action_id,
    buildRefundReservation(proposed.action_digest, proposal, runtime.clock),
  );
  runtime.rail.issuePermit(proposed.action_id);
  await runtime.rail.execute(proposed.action_id);
  await runtime.rail.verifyOutcome(proposed.action_id);
  return {
    runtime,
    bundle: runtime.rail.exportBundle(proposed.action_id, { profile: "audit" }),
    receiptBundle: runtime.rail.exportBundle(proposed.action_id),
  };
}

test("ordered threshold validation rejects every non-finite or non-number type", () => {
  coercionCalls = 0;
  for (const operator of ORDERED_OPERATORS) {
    for (const [name, makeValue] of INVALID_VALUES) {
      const value = makeValue();
      assert.throws(
        () => evaluatePostcondition(
          orderedPostcondition(operator, value),
          { facts: { active_refund_count: 1 } },
        ),
        (error) => error.code === "POSTCONDITION_INVALID",
        `${operator} must reject threshold type ${name}.`,
      );
    }
  }
  assert.equal(coercionCalls, 0);
});

test("ordered evidence validation never coerces invalid evidence types", () => {
  coercionCalls = 0;
  for (const operator of ORDERED_OPERATORS) {
    for (const [name, makeValue] of INVALID_VALUES) {
      const actual = makeValue();
      const result = evaluatePostcondition(
        orderedPostcondition(operator, 1),
        { facts: { active_refund_count: actual } },
      );
      assert.equal(
        result.satisfied,
        false,
        `${operator} must not satisfy evidence type ${name}.`,
      );
      assert.strictEqual(result.evaluations[0].actual, actual);
    }
  }
  assert.equal(coercionCalls, 0);
});

test("Rail.propose rejects the full threshold matrix without mutation", () => {
  coercionCalls = 0;
  for (const version of PROPOSAL_VERSIONS) {
    for (const operator of ORDERED_OPERATORS) {
      for (const [name, makeValue] of INVALID_VALUES) {
        const runtime = createDemoRuntime();
        const value = makeValue();
        const proposal = orderedProposal(runtime, version, operator, value);
        const before = snapshotProposal(proposal);
        assert.throws(
          () => runtime.rail.propose(proposal),
          (error) => error.code === "POSTCONDITION_INVALID",
          `${version} ${operator} must reject threshold type ${name}.`,
        );
        assert.deepEqual(proposal, before);
        assert.equal(runtime.rail.actions.size, 0);
        assert.equal(runtime.connector.reserveRecourseCalls, 0);
        assert.equal(runtime.connector.executeCalls, 0);
        assert.equal(runtime.connector.refunds.length, 0);
      }
    }
  }
  assert.equal(coercionCalls, 0);
});

test("finite binary64 boundaries are accepted by both ordered operators", () => {
  for (const [operator, threshold, actual] of [
    ["gte", Number.MAX_VALUE, Number.MAX_VALUE],
    ["gte", -Number.MAX_VALUE, -Number.MAX_VALUE],
    ["lte", Number.MAX_VALUE, Number.MAX_VALUE],
    ["lte", -Number.MAX_VALUE, -Number.MAX_VALUE],
  ]) {
    const evaluation = evaluatePostcondition(
      orderedPostcondition(operator, threshold),
      { facts: { active_refund_count: actual } },
    );
    assert.equal(evaluation.satisfied, true);

    for (const version of PROPOSAL_VERSIONS) {
      const runtime = createDemoRuntime();
      const proposal = orderedProposal(runtime, version, operator, threshold);
      const before = snapshotProposal(proposal);
      const admitted = runtime.rail.propose(proposal);
      assert.equal(admitted.state, "PROPOSED");
      assert.deepEqual(proposal, before);
    }
  }
});

test("strict eq behavior remains compatible across proposal versions", () => {
  assert.equal(evaluatePostcondition({
    op: "all",
    clauses: [{ path: "status", op: "eq", value: "complete" }],
  }, { facts: { status: "complete" } }).satisfied, true);
  assert.equal(evaluatePostcondition({
    op: "all",
    clauses: [{ path: "status", op: "eq", value: "1" }],
  }, { facts: { status: 1 } }).satisfied, false);

  for (const version of PROPOSAL_VERSIONS) {
    const runtime = createDemoRuntime();
    const proposal = buildRefundProposal(runtime.clock);
    proposal.schema_version = version;
    proposal.postcondition = {
      op: "all",
      clauses: [{ path: "status", op: "eq", value: "complete" }],
    };
    assert.equal(runtime.rail.propose(proposal).state, "PROPOSED");
  }
});

test("v0.1 remains immutable while v0.2 schemas bind bounds and receipt versions", () => {
  const schemas = join(process.cwd(), "spec", "schemas");
  const v1 = JSON.parse(readFileSync(join(schemas, "action-proposal.schema.json"), "utf8"));
  const v2 = JSON.parse(readFileSync(
    join(schemas, "action-proposal-v0.2.schema.json"),
    "utf8",
  ));
  const bundleV2 = JSON.parse(readFileSync(
    join(schemas, "settlement-bundle-v0.2.schema.json"),
    "utf8",
  ));
  const receiptV1 = JSON.parse(readFileSync(
    join(schemas, "settlement-receipt.schema.json"),
    "utf8",
  ));
  const receiptV2 = JSON.parse(readFileSync(
    join(schemas, "settlement-receipt-v0.2.schema.json"),
    "utf8",
  ));
  const openapi = JSON.parse(readFileSync(join(process.cwd(), "api", "openapi.json"), "utf8"));
  const v1Clause = v1.$defs.postcondition.properties.clauses.items;
  const v2Clause = v2.$defs.postcondition.properties.clauses.items;

  assert.equal(v1.$id, "urn:consequence-rail:schema:action-proposal:v0.1");
  assert.equal(
    v1.properties.schema_version.const,
    "consequence-rail/action-proposal/v0.1",
  );
  assert.deepEqual(v1Clause.properties.value, {});
  assert.equal(Object.hasOwn(v1Clause, "allOf"), false);

  assert.equal(v2.$id, "urn:consequence-rail:schema:action-proposal:v0.2");
  assert.equal(
    v2.properties.schema_version.const,
    "consequence-rail/action-proposal/v0.2",
  );
  assert.deepEqual(v2Clause.allOf, [{
    if: {
      properties: { op: { enum: ["gte", "lte"] } },
      required: ["op"],
    },
    then: {
      properties: {
        value: {
          type: "number",
          minimum: -Number.MAX_VALUE,
          maximum: Number.MAX_VALUE,
        },
      },
    },
  }]);

  assert.equal(bundleV2.$id, "urn:consequence-rail:schema:settlement-bundle:v0.2");
  assert.equal(
    bundleV2.properties.schema_version.const,
    "consequence-rail/settlement-bundle/v0.2",
  );
  assert.equal(
    bundleV2.properties.action.properties.proposal.$ref,
    "action-proposal-v0.2.schema.json",
  );
  assert.equal(
    bundleV2.properties.settlement_receipt.$ref,
    "settlement-receipt-v0.2.schema.json",
  );
  assert.equal(receiptV1.$id, "urn:consequence-rail:schema:settlement-receipt:v0.1");
  assert.equal(
    receiptV1.properties.schema_version.const,
    "consequence-rail/settlement-receipt/v0.1",
  );
  assert.equal(Object.hasOwn(receiptV1.properties, "proposal_schema_version"), false);
  assert.equal(receiptV2.$id, "urn:consequence-rail:schema:settlement-receipt:v0.2");
  assert.equal(
    receiptV2.properties.schema_version.const,
    "consequence-rail/settlement-receipt/v0.2",
  );
  assert.equal(
    receiptV2.properties.proposal_schema_version.const,
    "consequence-rail/action-proposal/v0.2",
  );
  const expectedReceiptV2 = deepClone(receiptV1);
  expectedReceiptV2.$id = "urn:consequence-rail:schema:settlement-receipt:v0.2";
  expectedReceiptV2.required.splice(1, 0, "proposal_schema_version");
  expectedReceiptV2.properties = {
    schema_version: { const: "consequence-rail/settlement-receipt/v0.2" },
    proposal_schema_version: { const: "consequence-rail/action-proposal/v0.2" },
    ...Object.fromEntries(Object.entries(receiptV1.properties).slice(1)),
  };
  assert.deepEqual(receiptV2, expectedReceiptV2);
  assert.deepEqual(
    openapi.paths["/v0/actions"].post.requestBody.content["application/json"].schema.oneOf,
    [
      { $ref: "../spec/schemas/action-proposal.schema.json" },
      { $ref: "../spec/schemas/action-proposal-v0.2.schema.json" },
    ],
  );
  const bundleSchemaReferences = [
    { $ref: "../spec/schemas/settlement-bundle.schema.json" },
    { $ref: "../spec/schemas/settlement-bundle-v0.2.schema.json" },
  ];
  assert.deepEqual(
    openapi.paths["/v0/actions/{action_id}/bundle"].get
      .responses["200"].content["application/json"].schema.oneOf,
    bundleSchemaReferences,
  );
  assert.deepEqual(
    openapi.paths["/v0/bundles/verify"].post
      .requestBody.content["application/json"].schema.oneOf,
    bundleSchemaReferences,
  );
});

test("raw JSON overflow thresholds are rejected before action admission", async (context) => {
  const runtime = createDemoRuntime();
  const server = createReferenceServer({ runtime });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();

  for (const [operator, rawValue, parsedValue] of [
    ["gte", "1e400", Number.POSITIVE_INFINITY],
    ["lte", "-1e400", Number.NEGATIVE_INFINITY],
  ]) {
    assert.strictEqual(JSON.parse(`{"value":${rawValue}}`).value, parsedValue);
    const proposal = orderedProposal(
      runtime,
      "consequence-rail/action-proposal/v0.2",
      operator,
      "RAW_BINARY64_BOUND",
    );
    const body = JSON.stringify(proposal).replace('"RAW_BINARY64_BOUND"', rawValue);
    const response = await fetch(`http://127.0.0.1:${address.port}/v0/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "POSTCONDITION_INVALID");
    assert.equal(runtime.rail.actions.size, 0);
  }
});

test("version-aligned bundle validation accepts v0.2 and rejects the full matrix", async () => {
  coercionCalls = 0;
  const { bundle, receiptBundle } = await createV2AuditBundle();
  const v1 = await runRefundDemo();
  const v1Bundle = v1.bundle;
  const v1ReceiptBundle = v1.runtime.rail.exportBundle(v1.summary.action_id);
  assert.equal(bundle.schema_version, "consequence-rail/settlement-bundle/v0.2");
  assert.equal(
    bundle.action.proposal.schema_version,
    "consequence-rail/action-proposal/v0.2",
  );
  assert.equal(
    bundle.settlement_receipt.schema_version,
    "consequence-rail/settlement-receipt/v0.2",
  );
  assert.equal(
    bundle.settlement_receipt.proposal_schema_version,
    "consequence-rail/action-proposal/v0.2",
  );
  assert.equal(
    receiptBundle.settlement_receipt.proposal_schema_version,
    "consequence-rail/action-proposal/v0.2",
  );
  assert.equal(
    v1ReceiptBundle.settlement_receipt.schema_version,
    "consequence-rail/settlement-receipt/v0.1",
  );
  assert.equal(
    Object.hasOwn(v1ReceiptBundle.settlement_receipt, "proposal_schema_version"),
    false,
  );
  assert.equal(verifyBundle(bundle, {
    trustedKeys: demoTrustedKeys(),
    trustedConnectorKeys: demoConnectorTrustedKeys(),
    requireSemantics: true,
  }).valid, true);
  assert.equal(verifyBundle(receiptBundle, {
    trustedKeys: demoTrustedKeys(),
    trustedConnectorKeys: demoConnectorTrustedKeys(),
    requireSemantics: false,
  }).valid, true);

  for (const [version, sourceBundle] of [
    ["v0.1", v1Bundle],
    ["v0.2", bundle],
  ]) {
    for (const operator of ORDERED_OPERATORS) {
      for (const [name, makeValue] of INVALID_VALUES) {
        const tampered = deepClone(sourceBundle);
        tampered.action.proposal.postcondition.clauses[0].op = operator;
        tampered.action.proposal.postcondition.clauses[0].value = makeValue();
        assert.throws(
          () => verifyBundle(tampered, {
            trustedKeys: demoTrustedKeys(),
            trustedConnectorKeys: demoConnectorTrustedKeys(),
            requireSemantics: true,
          }),
          (error) => error.code === "BUNDLE_TAMPERED",
          `${version} ${operator} bundle threshold type ${name} must be rejected.`,
        );
      }
    }
  }
  assert.equal(coercionCalls, 0);

  for (const [label, source, targetVersion] of [
    ["receipt upgrade", v1ReceiptBundle, "consequence-rail/settlement-bundle/v0.2"],
    ["audit upgrade", v1Bundle, "consequence-rail/settlement-bundle/v0.2"],
    ["receipt downgrade", receiptBundle, "consequence-rail/settlement-bundle/v0.1"],
    ["audit downgrade", bundle, "consequence-rail/settlement-bundle/v0.1"],
  ]) {
    const relabeled = deepClone(source);
    relabeled.schema_version = targetVersion;
    assert.throws(
      () => verifyBundle(relabeled, {
        trustedKeys: demoTrustedKeys(),
        trustedConnectorKeys: demoConnectorTrustedKeys(),
        requireSemantics: false,
      }),
      (error) => error.code === "BUNDLE_TAMPERED",
      `${label} must fail the bundle, receipt, and proposal version map.`,
    );
  }
});

test("signed receipts reject complete receipt and audit version relabeling", async () => {
  const { bundle: v2Audit, receiptBundle: v2Receipt } = await createV2AuditBundle();
  const v1 = await runRefundDemo();
  const v1Audit = v1.bundle;
  const v1Receipt = v1.runtime.rail.exportBundle(v1.summary.action_id);

  for (const [label, source, target] of [
    ["receipt upgrade", v1Receipt, "v0.2"],
    ["audit upgrade", v1Audit, "v0.2"],
    ["receipt downgrade", v2Receipt, "v0.1"],
    ["audit downgrade", v2Audit, "v0.1"],
  ]) {
    const relabeled = deepClone(source);
    relabeled.schema_version = `consequence-rail/settlement-bundle/${target}`;
    relabeled.settlement_receipt.schema_version =
      `consequence-rail/settlement-receipt/${target}`;
    if (target === "v0.2") {
      relabeled.settlement_receipt.proposal_schema_version =
        "consequence-rail/action-proposal/v0.2";
    } else {
      delete relabeled.settlement_receipt.proposal_schema_version;
    }
    if (relabeled.action.proposal) {
      relabeled.action.proposal.schema_version =
        `consequence-rail/action-proposal/${target}`;
    }

    assert.throws(
      () => verifyBundle(relabeled, {
        trustedKeys: demoTrustedKeys(),
        trustedConnectorKeys: demoConnectorTrustedKeys(),
        requireSemantics: false,
      }),
      (error) => error.code === "SIGNATURE_INVALID",
      `${label} must invalidate the signed receipt.`,
    );
  }
});
