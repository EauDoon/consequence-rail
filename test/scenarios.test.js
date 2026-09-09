import assert from "node:assert/strict";
import test from "node:test";
import { scenarioCatalog } from "../src/scenarios.js";

test("catalog documents every runnable synthetic fault with detached expectations", () => {
  const catalog = scenarioCatalog();
  assert.equal(catalog.synthetic_only, true);
  assert.equal(catalog.scenarios.length, 4);
  assert.equal(catalog.scenarios.flatMap((scenario) => scenario.faults).length, 30);
  for (const scenario of catalog.scenarios) for (const fault of scenario.faults) {
    assert.equal(typeof fault.purpose, "string");
    assert.ok(Object.keys(fault.expected).length);
  }
  catalog.scenarios[0].faults[0].expected.outcome = "disputed";
  assert.equal(scenarioCatalog().scenarios[0].faults[0].expected.outcome, "settled");
});
import { checkScenarioResult, runScenarioMatrix } from "../src/scenario-matrix.js";

test("all 31 deterministic fault controls pass in isolated runtimes", async () => {
  const result = await runScenarioMatrix();
  assert.equal(result.case_count, 31);
  assert.equal(result.valid, true, JSON.stringify(result.rows.filter((row) => !row.passed)));
  assert.deepEqual(await runScenarioMatrix("inventory"), await runScenarioMatrix("inventory"));
  await assert.rejects(() => runScenarioMatrix("__proto__"), { code: "SCENARIO_INVALID" });
});

test("matrix verdict fails on replay, failed tamper detection and preflight bypass", () => {
  const refund = checkScenarioResult("refund", "tampered-bundle", { state: "CLOSED", outcome: "settled" }, {
    state: "CLOSED", outcome: "settled", execute_calls: 2, remedy_calls: 0,
    bundle_verification: "pass", tamper_detection: { detected: false },
  });
  assert.equal(refund.passed, false);
  assert.equal(refund.checks.execution_count, false);
  assert.equal(refund.checks.tamper_detected, false);
  assert.equal(checkScenarioResult("recovery-preflight", "none", { qualification: "QUALIFIED_EXACT" }, {
    qualification: "QUALIFIED_EXACT", permit_without_preflight: "issued", live_connector_execute_calls: 1,
  }).passed, false);
});
