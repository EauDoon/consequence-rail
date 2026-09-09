import { deepClone, digest } from "./canonical.js";
import { verifyRecoveryPreflight } from "./recovery-preflight.js";

/** Diagnose a verified drill using only bound metadata, never raw fixture states. */
export function reviewRecovery(input, options = {}) {
  const bundle = deepClone(input), result = verifyRecoveryPreflight(bundle, options);
  const { recovery_contract: contract, trace, drill_attestation: attestation } = bundle;
  const checks = {
    synthetic_fixture: contract.fixture.fidelity === "synthetic",
    locally_testable: trace.local_testable,
    checkpoint_intact: trace.baseline_state !== null && trace.checkpoint_state !== null &&
      trace.checkpoint_reference_digest === contract.fixture.checkpoint_digest &&
      digest(trace.baseline_state) === contract.fixture.checkpoint_digest && digest(trace.checkpoint_state) === contract.fixture.checkpoint_digest,
    fault_observed: trace.fault_observed && trace.baseline_state !== null && trace.damaged_state !== null && digest(trace.baseline_state) !== digest(trace.damaged_state),
    recovery_attempted: trace.recovery_attempted,
    oracle_satisfied: trace.oracle_satisfied,
    exact_state_restored: trace.baseline_state !== null && trace.recovered_state !== null && digest(trace.baseline_state) === digest(trace.recovered_state),
  };
  return { ...result, bundle_digest: digest(bundle), action_digest: contract.action_digest,
    recovery_class: contract.recovery_class, fixture_fidelity: contract.fixture.fidelity,
    drilled_at: attestation.drilled_at,
    checked_at: options.requireCurrent ? options.now : null,
    remaining_validity_ms: options.requireCurrent ? Date.parse(result.expires_at) - Date.parse(options.now) : null,
    checks, failed_checks: Object.keys(checks).filter(key => !checks[key]),
    limitations: ["Diagnostics replay the signed declared evidence surface, not production recovery.",
      "No permit, live qualification update, or execution authority is granted.",
      ...(result.freshness_checked ? [] : ["Freshness was not checked; supply an explicit verification instant."])] };
}
