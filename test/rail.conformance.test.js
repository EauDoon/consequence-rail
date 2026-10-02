// Conformance tests for the consequence-rail module. Verifies that the
// public ActionProposal fixture is accepted and that runtime artifacts
// satisfy every JSON-Schema required field.
// Split from test/rail.test.js.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createDemoRuntime, runRefundDemo } from "../src/demo.js";
import { validateSettlementBundle } from "../src/bundle-validation.js";
import { ALLOWED_TRANSITIONS } from "../src/rail-state.js";
import {
  assertCanonicalEncodings,
  assertRequiredFields,
} from "../src/rail-test-helpers.js";

/** Read the normative transition table out of spec/state-machine.md. */
function documentedTransitions() {
  const spec = readFileSync(join(process.cwd(), "spec", "state-machine.md"), "utf8");
  const table = spec.split("```text")[1]?.split("```")[0];
  assert.ok(table, "spec/state-machine.md must declare a fenced transition table");
  const edges = [];
  let from;
  for (const line of table.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const source = trimmed.match(/^([A-Z_]+)(\(.*\))?$/);
    if (source) {
      from = source[1];
      continue;
    }
    const target = trimmed.match(/^->\s+([A-Z_]+)/);
    if (target && from) edges.push(`${from} -> ${target[1]}`);
  }
  return edges;
}

test("the normative state machine table matches the implemented transitions", () => {
  const implemented = [];
  for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
    for (const to of targets) implemented.push(`${from} -> ${to}`);
  }
  const documented = documentedTransitions();

  const undocumented = implemented.filter((edge) => !documented.includes(edge));
  const unimplemented = documented.filter((edge) => !implemented.includes(edge));
  assert.deepEqual(
    { undocumented, unimplemented },
    { undocumented: [], unimplemented: [] },
    "spec/state-machine.md is the normative transition table and must list exactly the transitions the rail permits",
  );
  assert.equal(documented.length, new Set(documented).size, "the table lists a transition twice");
  assert.equal(documented.length, implemented.length);
});

test("conformance ActionProposal fixture is accepted", () => {
  const runtime = createDemoRuntime();
  const fixture = JSON.parse(
    readFileSync(join(process.cwd(), "conformance", "refund-action.json"), "utf8"),
  );
  const result = runtime.rail.propose(fixture);
  assert.equal(result.state, "PROPOSED");
  assert.equal(result.action_type, "demo.refund.issue/v1");
});

test("portable proposal vectors agree at live and offline shape boundaries", async () => {
  const vectors = JSON.parse(readFileSync("conformance/proposal-validation.json", "utf8"));
  const { bundle } = await runRefundDemo();
  for (const version of ["v0.1", "v0.2"]) {
    for (const vector of vectors) {
      const runtime = createDemoRuntime();
      const candidate = structuredClone(bundle);
      candidate.schema_version = `consequence-rail/settlement-bundle/${version}`;
      candidate.settlement_receipt.schema_version = `consequence-rail/settlement-receipt/${version}`;
      const proposal = candidate.action.proposal;
      proposal.schema_version = `consequence-rail/action-proposal/${version}`;
      if (version === "v0.2") {
        candidate.settlement_receipt.proposal_schema_version = proposal.schema_version;
      }
      const parent = vector.path.slice(0, -1).reduce((value, key) => value[key], proposal);
      parent[vector.path.at(-1)] = vector.value;
      const label = `${version}: ${vector.name}`;
      if (vector.accepted) {
        assert.equal(runtime.rail.propose(proposal).state, "PROPOSED", label);
        // Shape validation only: changing the proposal does not re-sign a bundle.
        assert.doesNotThrow(() => validateSettlementBundle(candidate), label);
      } else {
        assert.throws(() => runtime.rail.propose(proposal), { code: "SCHEMA_INVALID" }, label);
        assert.equal(runtime.rail.actions.size, 0, label);
        assert.throws(() => validateSettlementBundle(candidate), { code: "BUNDLE_TAMPERED" }, label);
      }
    }
  }
});

test("runtime artifacts contain every schema-required field", async () => {
  const result = await runRefundDemo({ fault: "duplicate" });
  assertRequiredFields(
    "spec/schemas/recourse-reservation.schema.json",
    result.bundle.recourse_reservation,
  );
  assertRequiredFields(
    "spec/schemas/connector-recourse-commitment.schema.json",
    result.bundle.recourse_reservation.connector_commitment,
  );
  assertRequiredFields(
    "spec/schemas/action-permit.schema.json",
    result.bundle.action_permit,
  );
  for (const evidence of result.bundle.outcome_evidence) {
    assertRequiredFields("spec/schemas/outcome-evidence.schema.json", evidence);
  }
  assertRequiredFields(
    "spec/schemas/settlement-receipt.schema.json",
    result.bundle.settlement_receipt,
  );
  assertRequiredFields(
    "spec/schemas/settlement-bundle.schema.json",
    result.bundle,
  );
  assertCanonicalEncodings(result.bundle);
});
