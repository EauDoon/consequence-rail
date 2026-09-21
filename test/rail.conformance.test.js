// Conformance tests for the consequence-rail module. Verifies that the
// public ActionProposal fixture is accepted and that runtime artifacts
// satisfy every JSON-Schema required field.
// Split from test/rail.test.js.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createDemoRuntime, runRefundDemo } from "../src/demo.js";
import {
  assertCanonicalEncodings,
  assertRequiredFields,
} from "../src/rail-test-helpers.js";

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
