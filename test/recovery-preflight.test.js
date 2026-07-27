import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { deepClone, digest } from "../src/canonical.js";
import {
  buildRefundProposal,
  buildRefundReservation,
  createDemoRuntime,
} from "../src/demo.js";
import { createReferenceServer } from "../src/http-server.js";
import { MockRefundRecoveryAdapter } from "../src/mock-refund-recovery-adapter.js";
import {
  buildRefundRecoveryContract,
  runRecoveryPreflightDemo,
} from "../src/recovery-demo.js";
import {
  runRecoveryPreflight,
  validateRecoveryContract,
  verifyRecoveryPreflight,
} from "../src/recovery-preflight.js";
import {
  createDemoRecoverySigner,
  demoRecoveryTrustedKeys,
} from "../src/signing.js";

test("recovery preflight qualifies exact restoration on an isolated fixture", async () => {
  const result = await runRecoveryPreflightDemo();
  assert.equal(result.summary.qualification, "QUALIFIED_EXACT");
  assert.equal(result.summary.fixture_fidelity, "synthetic");
  assert.equal(result.summary.production_recovery_claimed, false);
  assert.equal(result.summary.permit_without_preflight, "refused");
  assert.equal(result.summary.permit_after_preflight, "issued");
  assert.equal(result.summary.live_connector_execute_calls, 0);
  assert.equal(result.summary.live_connector_remedy_calls, 0);
  assert.equal(result.verification.valid, true);
  assert.notEqual(
    digest(result.bundle.trace.baseline_state),
    digest(result.bundle.trace.damaged_state),
  );
  assert.equal(
    digest(result.bundle.trace.baseline_state),
    digest(result.bundle.trace.recovered_state),
  );
});

test("recovery preflight output is deterministic for pinned inputs", async () => {
  const first = await runRecoveryPreflightDemo();
  const second = await runRecoveryPreflightDemo();
  assert.deepEqual(first.bundle, second.bundle);
});

test("non-synthetic fidelity never invokes the recovery adapter", async () => {
  const runtime = createDemoRuntime();
  const contract = deepClone(buildRefundRecoveryContract(runtime.clock));
  contract.fixture.fidelity = "staging";
  let adapterCalls = 0;
  const adapter = new MockRefundRecoveryAdapter(runtime.clock);
  adapter.run = async () => {
    adapterCalls += 1;
    throw new Error("adapter must not run");
  };

  const bundle = await runRecoveryPreflight({
    contract,
    adapter,
    signer: createDemoRecoverySigner(),
    clock: runtime.clock,
  });

  assert.equal(adapterCalls, 0);
  assert.equal(bundle.trace.recovery_attempted, false);
  assert.deepEqual(bundle.trace.notes, ["NON_SYNTHETIC_FIXTURE_NOT_EXECUTED"]);
  assert.equal(bundle.drill_attestation.qualification, "NOT_TESTABLE_LOCAL");
});

for (const [fault, qualification] of [
  ["missing-checkpoint", "NOT_QUALIFIED"],
  ["corrupt-checkpoint", "NOT_QUALIFIED"],
  ["fault-not-observed", "NOT_QUALIFIED"],
  ["remedy-failure", "NOT_QUALIFIED"],
  ["not-testable-local", "NOT_TESTABLE_LOCAL"],
  ["out-of-scope", "NOT_TESTABLE_LOCAL"],
]) {
  test(`recovery preflight classifies ${fault} without overclaiming`, async () => {
    const result = await runRecoveryPreflightDemo({ fault });
    assert.equal(result.summary.qualification, qualification);
    assert.equal(result.verification.valid, true);
  });
}

for (const [label, mutate] of [
  ["undeclared fault version", (contract) => { contract.fault.version = "999"; }],
  ["different procedure", (contract) => {
    contract.procedure.parameters.capability = "nonexistent-remedy";
  }],
  ["different oracle surface", (contract) => {
    contract.oracle.parameters.paths = ["facts.active_refund_count"];
  }],
]) {
  test(`standard adapter refuses ${label}`, async () => {
    const runtime = createDemoRuntime();
    const contract = deepClone(buildRefundRecoveryContract(runtime.clock));
    mutate(contract);
    const bundle = await runRecoveryPreflight({
      contract,
      adapter: new MockRefundRecoveryAdapter(runtime.clock),
      signer: createDemoRecoverySigner(),
      clock: runtime.clock,
    });
    assert.equal(bundle.drill_attestation.qualification, "NOT_TESTABLE_LOCAL");
  });
}

test("recovery preflight verification rejects an untrusted signer", async () => {
  const result = await runRecoveryPreflightDemo();
  assert.throws(
    () => verifyRecoveryPreflight(result.bundle),
    (error) => error.code === "UNTRUSTED_KEY",
  );
});

test("recovery preflight verification rejects a tampered replay trace", async () => {
  const result = await runRecoveryPreflightDemo();
  const tampered = deepClone(result.bundle);
  tampered.trace.recovered_state["facts.active_refund_count"] = 999;
  assert.throws(
    () =>
      verifyRecoveryPreflight(tampered, {
        trustedKeys: demoRecoveryTrustedKeys(),
      }),
    (error) => error.code === "RECOVERY_BUNDLE_INVALID",
  );
});

test("recovery preflight attestation binds non-state trace metadata", async () => {
  const result = await runRecoveryPreflightDemo();
  const tampered = deepClone(result.bundle);
  tampered.trace.oracle_satisfied = false;
  tampered.trace.notes.push("UNSIGNED_NOTE");
  assert.throws(
    () =>
      verifyRecoveryPreflight(tampered, {
        trustedKeys: demoRecoveryTrustedKeys(),
      }),
    (error) => error.code === "RECOVERY_BUNDLE_INVALID",
  );
});

test("recovery preflight verification rejects undeclared bundle fields", async () => {
  const result = await runRecoveryPreflightDemo();
  const extended = deepClone(result.bundle);
  extended.unreviewed_field = true;
  assert.throws(
    () =>
      verifyRecoveryPreflight(extended, {
        trustedKeys: demoRecoveryTrustedKeys(),
      }),
    (error) => error.code === "RECOVERY_BUNDLE_INVALID",
  );
});

test("recovery bundle requires its complete trust hint and digest formats", async () => {
  const result = await runRecoveryPreflightDemo();
  const missingTrustHint = deepClone(result.bundle);
  delete missingTrustHint.trust_hint;
  assert.throws(
    () => verifyRecoveryPreflight(missingTrustHint, {
      trustedKeys: demoRecoveryTrustedKeys(),
    }),
    (error) => error.code === "RECOVERY_BUNDLE_INVALID",
  );

  const shortDigest = deepClone(
    buildRefundRecoveryContract(result.runtime.clock),
  );
  shortDigest.action_digest = "x";
  assert.throws(
    () => validateRecoveryContract(shortDigest),
    (error) => error.code === "RECOVERY_CONTRACT_INVALID",
  );
});

test("recovery preflight freshness fails closed at expiry", async () => {
  const result = await runRecoveryPreflightDemo();
  const expiry = result.bundle.drill_attestation.expires_at;
  assert.throws(
    () =>
      verifyRecoveryPreflight(result.bundle, {
        trustedKeys: demoRecoveryTrustedKeys(),
        now: expiry,
        requireCurrent: true,
      }),
    (error) => error.code === "RECOVERY_ATTESTATION_EXPIRED",
  );
});

test("a gated rail refuses a permit until exact recovery is qualified", async () => {
  const runtime = createDemoRuntime({ requireRecoveryPreflight: true });
  const { actionId } = prepareRefundWithoutPermit(runtime);
  assert.throws(
    () => runtime.rail.issuePermit(actionId),
    (error) => error.code === "RECOVERY_PREFLIGHT_REQUIRED",
  );
  assert.equal(runtime.connector.executeCalls, 0);
  assert.equal(runtime.connector.remedyCalls, 0);

  const drill = await runRecoveryPreflightDemo({ clock: runtime.clock });
  const accepted = runtime.rail.acceptRecoveryQualification(
    actionId,
    drill.bundle,
  );
  assert.equal(accepted.recovery_preflight_qualification, "QUALIFIED_EXACT");
  const permitted = runtime.rail.issuePermit(actionId);
  assert.equal(permitted.state, "PERMITTED");
  assert.equal(runtime.connector.executeCalls, 0);
  assert.equal(runtime.connector.remedyCalls, 0);
});

test("a global recovery gate cannot be downgraded by authorization", () => {
  const runtime = createDemoRuntime({ requireRecoveryPreflight: true });
  const proposal = buildRefundProposal(runtime.clock);
  const proposed = runtime.rail.propose(proposal);
  runtime.rail.authorize(proposed.action_id, {
    allow: true,
    policy_id: "attempted-downgrade/v1",
    policy_digest: digest({ allow: true }),
    require_recovery_preflight: false,
  });
  runtime.rail.reserveRecourse(
    proposed.action_id,
    buildRefundReservation(
      proposed.action_digest,
      proposal,
      runtime.clock,
    ),
  );

  assert.throws(
    () => runtime.rail.issuePermit(proposed.action_id),
    (error) => error.code === "RECOVERY_PREFLIGHT_REQUIRED",
  );
  assert.equal(runtime.connector.executeCalls, 0);
});

test("a qualified drill cannot unlock a different capability reference", async () => {
  const runtime = createDemoRuntime({ requireRecoveryPreflight: true });
  const proposal = buildRefundProposal(runtime.clock);
  const proposed = runtime.rail.propose(proposal);
  runtime.rail.authorize(proposed.action_id, {
    allow: true,
    policy_id: "demo-refund-policy/v1",
    policy_digest: digest({ allow: true }),
  });
  const request = buildRefundReservation(
    proposed.action_digest,
    proposal,
    runtime.clock,
  );
  request.capability_reference = "different-capability-reference";
  runtime.rail.reserveRecourse(proposed.action_id, request);
  const drill = await runRecoveryPreflightDemo({ clock: runtime.clock });

  assert.throws(
    () => runtime.rail.acceptRecoveryQualification(
      proposed.action_id,
      drill.bundle,
    ),
    (error) => error.code === "RECOVERY_COVERAGE_MISMATCH",
  );
  assert.equal(runtime.connector.executeCalls, 0);
});

test("reservation substitution after qualification fails before permit issuance", async () => {
  const runtime = createDemoRuntime({ requireRecoveryPreflight: true });
  const { actionId } = prepareRefundWithoutPermit(runtime);
  const drill = await runRecoveryPreflightDemo({ clock: runtime.clock });
  runtime.rail.acceptRecoveryQualification(actionId, drill.bundle);

  const alternate = createDemoRuntime({ clock: runtime.clock });
  const proposal = buildRefundProposal(alternate.clock);
  const proposed = alternate.rail.propose(proposal);
  alternate.rail.authorize(proposed.action_id, {
    allow: true,
    policy_id: "alternate-policy/v1",
    policy_digest: digest({ allow: true }),
  });
  const request = buildRefundReservation(
    proposed.action_digest,
    proposal,
    alternate.clock,
  );
  request.capability_reference = "substituted-capability-reference";
  alternate.rail.reserveRecourse(proposed.action_id, request);

  const record = runtime.rail.get(actionId);
  const substitute = alternate.rail.get(proposed.action_id);
  record.reservation = substitute.reservation;
  record.reservation_digest = substitute.reservation_digest;

  assert.throws(
    () => runtime.rail.issuePermit(actionId),
    (error) => error.code === "RECOVERY_PREFLIGHT_NOT_QUALIFIED",
  );
  assert.equal(runtime.connector.executeCalls, 0);
});

test("recovery implementation substitution after permit fails before remedy", async () => {
  const runtime = createDemoRuntime({ requireRecoveryPreflight: true });
  const { actionId } = prepareRefundWithoutPermit(runtime);
  const drill = await runRecoveryPreflightDemo({ clock: runtime.clock });
  runtime.rail.acceptRecoveryQualification(actionId, drill.bundle);
  runtime.rail.issuePermit(actionId);
  await runtime.rail.execute(actionId, { fault: "duplicate" });
  await runtime.rail.verifyOutcome(actionId);
  runtime.connector.remediate = async () => ({
    status: "remediated",
    idempotency_key: "substituted",
  });

  await assert.rejects(
    () => runtime.rail.remediate(actionId),
    (error) => error.code === "RECOVERY_PREFLIGHT_NOT_QUALIFIED",
  );
  assert.equal(runtime.connector.remedyCalls, 0);
  assert.equal(runtime.rail.inspect(actionId).state, "REMEDY_DUE");
});

test("a self-consistent invented checkpoint cannot qualify exact recovery", async () => {
  const runtime = createDemoRuntime();
  const contract = buildRefundRecoveryContract(runtime.clock);
  const adapter = new MockRefundRecoveryAdapter(runtime.clock);
  const invented = {
    source: "invented-source",
    "resource.type": "order",
    "resource.id": "invented-resource",
    "facts.active_refund_count": 99,
    "facts.net_refunded_minor": 99,
    "facts.currency": "USD",
  };
  contract.fixture.checkpoint_digest = digest(invented);

  const bundle = await runRecoveryPreflight({
    contract,
    adapter,
    signer: createDemoRecoverySigner(),
    clock: runtime.clock,
  });
  assert.equal(bundle.drill_attestation.qualification, "NOT_QUALIFIED");
  assert.equal(
    bundle.drill_attestation.checkpoint_digest,
    contract.fixture.checkpoint_digest,
  );
});

test("a substituted live adapter callable is rejected before invocation", async () => {
  const runtime = createDemoRuntime();
  const contract = buildRefundRecoveryContract(runtime.clock);
  const adapter = new MockRefundRecoveryAdapter(runtime.clock);
  const genuineTrace = await Reflect.apply(adapter.run, adapter, [contract]);
  let substitutedCalls = 0;
  adapter.run = async () => {
    substitutedCalls += 1;
    return genuineTrace;
  };

  await assert.rejects(
    () => runRecoveryPreflight({
      contract,
      adapter,
      signer: createDemoRecoverySigner(),
      clock: runtime.clock,
    }),
    (error) => error.code === "RECOVERY_ADAPTER_MISMATCH",
  );
  assert.equal(substitutedCalls, 0);
});

test("a rail rejects valid recovery evidence outside the action envelope", async () => {
  const runtime = createDemoRuntime({ requireRecoveryPreflight: true });
  const { actionId } = prepareRefundWithoutPermit(runtime);
  const differentProposal = buildRefundProposal(runtime.clock, "cooperative");
  const contract = buildRefundRecoveryContract(runtime.clock, {
    proposal: differentProposal,
  });
  const bundle = await runRecoveryPreflight({
    contract,
    adapter: new MockRefundRecoveryAdapter(runtime.clock),
    signer: createDemoRecoverySigner(),
    clock: runtime.clock,
  });
  assert.equal(bundle.drill_attestation.qualification, "QUALIFIED_EXACT");
  assert.throws(
    () => runtime.rail.acceptRecoveryQualification(actionId, bundle),
    (error) => error.code === "RECOVERY_COVERAGE_MISMATCH",
  );
});

test("a rail rejects qualification drilled for a different complete action", async () => {
  const runtime = createDemoRuntime({ requireRecoveryPreflight: true });
  const { actionId } = prepareRefundWithoutPermit(runtime);
  const drilledProposal = buildRefundProposal(runtime.clock);
  drilledProposal.subject.id = "different-subject";
  drilledProposal.target.resource_id = "ord_different_99";
  drilledProposal.idempotency_key = "refund:ord_different_99:1";
  const contract = buildRefundRecoveryContract(runtime.clock, {
    proposal: drilledProposal,
  });
  const bundle = await runRecoveryPreflight({
    contract,
    adapter: new MockRefundRecoveryAdapter(runtime.clock),
    signer: createDemoRecoverySigner(),
    clock: runtime.clock,
  });
  assert.equal(bundle.drill_attestation.qualification, "QUALIFIED_EXACT");

  assert.throws(
    () => runtime.rail.acceptRecoveryQualification(actionId, bundle),
    (error) => error.code === "RECOVERY_COVERAGE_MISMATCH",
  );
});

test("a rail rejects a signed drill that did not qualify", async () => {
  const runtime = createDemoRuntime({ requireRecoveryPreflight: true });
  const { actionId } = prepareRefundWithoutPermit(runtime);
  const drill = await runRecoveryPreflightDemo({
    fault: "remedy-failure",
    clock: runtime.clock,
  });
  assert.throws(
    () => runtime.rail.acceptRecoveryQualification(actionId, drill.bundle),
    (error) => error.code === "RECOVERY_PREFLIGHT_NOT_QUALIFIED",
  );
});

test("permit issuance remeasures the qualified connector implementation", async () => {
  const runtime = createDemoRuntime({ requireRecoveryPreflight: true });
  const { actionId } = prepareRefundWithoutPermit(runtime);
  const drill = await runRecoveryPreflightDemo({ clock: runtime.clock });
  runtime.rail.acceptRecoveryQualification(actionId, drill.bundle);
  runtime.connector.remediate = async () => ({
    status: "remediated",
    idempotency_key: "mutated",
  });

  assert.throws(
    () => runtime.rail.issuePermit(actionId),
    (error) => error.code === "RECOVERY_PREFLIGHT_NOT_QUALIFIED",
  );
  assert.equal(runtime.connector.executeCalls, 0);
  assert.equal(runtime.connector.remedyCalls, 0);
});

test("HTTP sidecar accepts evidence but never executes the drill plan", async (context) => {
  const runtime = createDemoRuntime({ requireRecoveryPreflight: true });
  const { actionId } = prepareRefundWithoutPermit(runtime);
  const drill = await runRecoveryPreflightDemo({ clock: runtime.clock });
  const server = createReferenceServer({ runtime });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const response = await fetch(
    `${base}/v0/actions/${actionId}/recovery-preflight`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(drill.bundle),
    },
  );
  assert.equal(response.status, 200);
  const accepted = await response.json();
  assert.equal(accepted.recovery_preflight_qualification, "QUALIFIED_EXACT");
  assert.equal(runtime.connector.executeCalls, 0);
  assert.equal(runtime.connector.remedyCalls, 0);
});

test("RecoveryContract rejects unknown fields", () => {
  const runtime = createDemoRuntime();
  const contract = buildRefundRecoveryContract(runtime.clock);
  contract.unreviewed_field = true;
  assert.throws(
    () => validateRecoveryContract(contract),
    (error) => error.code === "RECOVERY_CONTRACT_INVALID",
  );
});

test("conformance RecoveryContract matches the deterministic demo", () => {
  const fixture = JSON.parse(
    readFileSync(
      join(process.cwd(), "conformance/refund-recovery-contract.json"),
      "utf8",
    ),
  );
  const runtime = createDemoRuntime();
  assert.deepEqual(
    validateRecoveryContract(fixture),
    validateRecoveryContract(buildRefundRecoveryContract(runtime.clock)),
  );
});

test("recovery artifacts contain every schema-required field", async () => {
  const result = await runRecoveryPreflightDemo();
  assertRequiredFields(
    "spec/schemas/recovery-contract.schema.json",
    result.bundle.recovery_contract,
  );
  assertRequiredFields(
    "spec/schemas/recovery-drill-attestation.schema.json",
    result.bundle.drill_attestation,
  );
  assertRequiredFields(
    "spec/schemas/recovery-drill-bundle.schema.json",
    result.bundle,
  );
});

function prepareRefundWithoutPermit(runtime) {
  const proposal = buildRefundProposal(runtime.clock);
  const proposed = runtime.rail.propose(proposal);
  runtime.rail.authorize(proposed.action_id, {
    allow: true,
    policy_id: "demo-refund-policy/v1",
    policy_digest: digest({ allow: true }),
  });
  runtime.rail.reserveRecourse(
    proposed.action_id,
    buildRefundReservation(proposed.action_digest, proposal, runtime.clock),
  );
  return { actionId: proposed.action_id };
}

function assertRequiredFields(schemaPath, artifact) {
  const schema = JSON.parse(readFileSync(join(process.cwd(), schemaPath), "utf8"));
  for (const field of schema.required ?? []) {
    assert.equal(
      Object.hasOwn(artifact, field),
      true,
      `${schema.title} is missing required field ${field}`,
    );
  }
}
