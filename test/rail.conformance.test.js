// Conformance tests for the consequence-rail module. Verifies that the
// public ActionProposal fixture is accepted and that runtime artifacts
// satisfy every JSON-Schema required field.
// Split from test/rail.test.js.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createDemoRuntime, runRefundDemo } from "../src/demo.js";
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
