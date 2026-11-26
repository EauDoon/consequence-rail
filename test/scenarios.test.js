import assert from "node:assert/strict";
import test from "node:test";
import { findExercises, scenarioCatalog } from "../src/scenarios.js";
import { runRefundDemo, runIrreversibleDemo } from "../src/demo.js";
import { runInventoryDemo } from "../src/inventory-demo.js";

test("every advertised execution assurance mode completes its synthetic demo", async () => {
  for (const scenario of scenarioCatalog().scenarios.filter((item) => ["refund", "inventory"].includes(item.name))) {
    const run = scenario.name === "refund" ? runRefundDemo : runInventoryDemo;
    for (const assurance of scenario.assurance_modes) {
      const { summary } = await run({ assuranceMode: assurance });
      assert.equal(summary.state, "CLOSED");
      assert.equal(summary.assurance_mode, assurance);
    }
    await assert.rejects(() => run({ assuranceMode: "observed" }), { code: "MODE_NOT_EXECUTABLE" });
  }
});

test("the irreversible scenario is refused by the connector capability gate", () => {
  const result = runIrreversibleDemo();
  assert.equal(result.admitted, false);
  assert.equal(result.code, "RECOURSE_INVALID");
  // The stated reason is only true if the request was complete and the rail
  // refused it for the capability the connector does not advertise.
  assert.match(result.detail, /does not advertise the reserved remedy capability/);
  assert.doesNotMatch(result.detail, /unknown fields|missing required fields/);
});

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
import { checkScenarioResult, runScenarioMatrix, summarizeScenarioMatrix } from "../src/scenario-matrix.js";

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

test("exercise search combines terms and retains runnable commands", () => {
  const matches = findExercises("COMPENSATED   inventory").matches;
  assert.ok(matches.length);
  assert.ok(matches.every((row) => row.scenario === "inventory" && row.expected.outcome === "compensated"));
  const refusal = findExercises("irreversible refused").matches;
  assert.equal(refusal.length, 1);
  assert.equal(refusal[0].command, "node ./cmd/crctl.js demo irreversible");
  assert.equal(findExercises("outside-catalog").case_count, 0);
});

test("a different refusal is not a successful irreversible control", () => {
  const result = checkScenarioResult("irreversible", "none", { admitted: false },
    { admitted: false, code: "UNRELATED_FAILURE" });
  assert.equal(result.passed, false);
  assert.equal(result.checks.recourse_refusal, false);
});

test("compact matrix retains failed controls and exceptions without raw summaries", () => {
  const report = summarizeScenarioMatrix({
    valid: false, case_count: 3, passed: 1, failed: 2,
    rows: [
      { scenario: "refund", fault: "none", passed: true, summary: {} },
      { scenario: "refund", fault: "duplicate", passed: false, checks: { bundle: false, execution_count: true } },
      { scenario: "inventory", fault: "none", passed: false, code: "SCENARIO_FAILED" },
    ],
  });
  assert.deepEqual(report.scenarios, [
    { scenario: "refund", passed: 1, failed: 1 },
    { scenario: "inventory", passed: 0, failed: 1 },
  ]);
  assert.deepEqual(report.failures, [
    { scenario: "refund", fault: "duplicate", checks: ["bundle"] },
    { scenario: "inventory", fault: "none", code: "SCENARIO_FAILED" },
  ]);
  assert.equal(Object.hasOwn(report, "rows"), false);
});
