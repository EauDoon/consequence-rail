import { runRefundDemo, runIrreversibleDemo } from "./demo.js";
import { runInventoryDemo } from "./inventory-demo.js";
import { runRecoveryPreflightDemo } from "./recovery-demo.js";
import { scenarioCatalog } from "./scenarios.js";
import { RailError } from "./errors.js";

/** Compare actual synthetic results to declared outcomes and no-replay invariants. */
export function checkScenarioResult(scenario, fault, expected, summary) {
  const checks = {};
  for (const [key, value] of Object.entries(expected)) {
    checks[key] = (key === "rejection" ? summary.expected_rejection?.code : summary[key]) === value;
  }
  if (["refund", "inventory"].includes(scenario)) {
    checks.execution_count = summary.execute_calls === (fault === "action-mutation" ? 0 : 1);
    checks.remedy_bounded = Number.isSafeInteger(summary.remedy_calls) && summary.remedy_calls >= 0 && summary.remedy_calls <= 1;
    checks.bundle = summary.bundle_verification === (expected.outcome ? "pass" : "not_available");
    if (fault === "tampered-bundle") checks.tamper_detected = summary.tamper_detection?.detected === true;
  }
  if (scenario === "recovery-preflight") {
    checks.bundle = summary.bundle_verification === "pass";
    checks.preflight_gate = summary.permit_without_preflight === "refused";
    checks.qualification_gate = summary.permit_after_preflight === (expected.qualification === "QUALIFIED_EXACT" ? "issued" : "refused:RECOVERY_PREFLIGHT_NOT_QUALIFIED");
    checks.isolation = summary.live_connector_execute_calls === 0 && summary.live_connector_remedy_calls === 0;
    checks.synthetic_only = summary.production_recovery_claimed === false;
  }
  return { passed: Object.values(checks).every(Boolean), checks };
}

/** Run a fixed, bounded catalog against fresh isolated runtimes, sequentially. */
export async function runScenarioMatrix(selection = "all") {
  const catalog = scenarioCatalog().scenarios;
  if (selection !== "all" && !catalog.some((scenario) => scenario.name === selection)) {
    throw new RailError("SCENARIO_INVALID", "Expected all, refund, inventory, recovery-preflight, or irreversible.");
  }
  const rows = [];
  for (const scenario of catalog.filter((item) => selection === "all" || item.name === selection)) {
    const faults = scenario.name === "irreversible" ? [{ name: "none", expected: scenario.expected }] : scenario.faults;
    for (const fault of faults) {
      try {
        const summary = scenario.name === "irreversible" ? runIrreversibleDemo() :
          (await (scenario.name === "refund" ? runRefundDemo : scenario.name === "inventory" ? runInventoryDemo : runRecoveryPreflightDemo)({ fault: fault.name })).summary;
        rows.push({ scenario: scenario.name, fault: fault.name, ...checkScenarioResult(scenario.name, fault.name, fault.expected, summary), summary });
      } catch (error) {
        rows.push({ scenario: scenario.name, fault: fault.name, passed: false, code: error instanceof RailError ? error.code : "SCENARIO_FAILED" });
      }
    }
  }
  const passed = rows.filter((row) => row.passed).length;
  return { valid: passed === rows.length, synthetic_only: true, case_count: rows.length, passed, failed: rows.length - passed, rows };
}
