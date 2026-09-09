import { deepClone, digest } from "./canonical.js";
import { verifyRecoveryPreflight } from "./recovery-preflight.js";
import { reviewBundle } from "./review.js";

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

/** Compare independently verified coverage without selecting an authoritative drill. */
export function compareRecovery(leftInput, rightInput, options = {}) {
  const left = deepClone(leftInput), right = deepClone(rightInput);
  const leftReview = reviewRecovery(left, options), rightReview = reviewRecovery(right, options);
  const metadata = bundle => {
    const contract = bundle.recovery_contract, attestation = bundle.drill_attestation;
    return { action_digest: contract.action_digest, action_class: contract.action_class,
      recovery_class: contract.recovery_class, scope_digest: digest(contract.scope),
      recourse_digest: digest(contract.recourse), fixture_digest: digest(contract.fixture),
      fault_digest: digest(contract.fault), procedure_digest: digest(contract.procedure), oracle_digest: digest(contract.oracle),
      contract_issued_at: contract.issued_at, contract_expires_at: contract.expires_at,
      max_attestation_age_seconds: contract.max_attestation_age_seconds,
      qualification: attestation.qualification, drilled_at: attestation.drilled_at, expires_at: attestation.expires_at };
  };
  const before = metadata(left), after = metadata(right);
  return { valid: true, same_bundle: leftReview.bundle_digest === rightReview.bundle_digest,
    same_action: before.action_digest === after.action_digest,
    same_coverage: leftReview.coverage_digest === rightReview.coverage_digest,
    left_bundle_digest: leftReview.bundle_digest, right_bundle_digest: rightReview.bundle_digest,
    changes: Object.keys(before).filter(field => before[field] !== after[field])
      .map(field => ({ field, left: before[field], right: after[field] })),
    limitations: ["Different drill outcomes do not establish which artifact is authoritative.",
      "same_coverage compares the protocol coverage digest, not every recovery contract field.",
      "Matching coverage is not a permit or proof of current production recovery."] };
}

/** Offline artifact bindings only: this cannot reproduce live admission checks. */
export function linkRecovery(settlementInput, recoveryInput, options = {}) {
  const settlement = deepClone(settlementInput), recovery = deepClone(recoveryInput);
  const review = reviewBundle(settlement, options);
  const drill = reviewRecovery(recovery, { trustedKeys: options.trustedRecoveryKeys,
    requireCurrent: options.requireCurrent, now: options.now });
  const contract = recovery.recovery_contract, reservation = settlement.recourse_reservation;
  const bindings = {
    action: contract.action_digest === settlement.action.action_digest,
    action_class: contract.action_class === settlement.action.action_type,
    reservation: contract.recourse.reservation_digest === digest(reservation),
    capability_reference: contract.recourse.capability_reference_digest === reservation.capability_reference_digest,
    connector_commitment: contract.recourse.connector_commitment_digest === digest(reservation.connector_commitment),
    remedy_kind: contract.recourse.kind === reservation.kind,
    capability: contract.recourse.capability === reservation.capability,
  };
  const accepted = settlement.events.filter(event => event.event_type === "RECOVERY_PREFLIGHT_ACCEPTED")
    .some(event => event.payload.attestation_digest === drill.attestation_digest && event.payload.coverage_digest === drill.coverage_digest);
  return { valid: true, settlement_bundle_digest: review.bundle_digest, recovery_bundle_digest: drill.bundle_digest,
    settlement_verification_scope: review.verification_scope, qualification: drill.qualification,
    freshness_checked: drill.freshness_checked, bindings, bindings_match: Object.values(bindings).every(Boolean),
    acceptance_event_recorded: accepted,
    limitations: ["Matching artifact bindings do not reproduce live connector status or implementation measurement.",
      "A recorded acceptance event is signed history, not current admission or execution authority.",
      "This report does not establish production recovery or evidence truth."] };
}
