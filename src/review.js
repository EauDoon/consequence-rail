import { deepClone, digest } from "./canonical.js";
import { verifyBundle } from "./verify.js";

/** Produce the existing receipt profile, preserving signed artifacts unchanged. */
export function receiptBundle(input, options = {}) {
  const bundle = deepClone(input);
  reviewBundle(bundle, options);
  bundle.profile = "receipt";
  delete bundle.action.proposal;
  bundle.outcome_evidence = [];
  reviewBundle(bundle, options);
  return bundle;
}

/** Inventory bound evidence without disclosing facts, identifiers or raw evaluations. */
export function evidenceInventory(input, options = {}) {
  const bundle = deepClone(input), review = reviewBundle(bundle, options);
  return {
    valid: true, bundle_digest: review.bundle_digest, verification_scope: review.verification_scope,
    evidence_count: review.evidence_count,
    evidence: bundle.evidence_manifest.map((evidenceDigest, index) => {
      const item = bundle.outcome_evidence[index];
      if (!item) return { digest: evidenceDigest, metadata_available: false };
      const accepted = bundle.events.find(event =>
        ["EVIDENCE_ACCEPTED", "REMEDY_EVIDENCE_ACCEPTED"].includes(event.event_type) && event.payload.evidence_digest === evidenceDigest);
      return { digest: evidenceDigest, metadata_available: true, phase: item.phase ?? "initial",
        source: item.source, observed_at: item.observed_at, accepted_at: accepted.recorded_at,
        age_at_acceptance_ms: Date.parse(accepted.recorded_at) - Date.parse(item.observed_at),
        satisfied: item.evaluation.satisfied, signer_key_id: item.signature.key_id,
        clause_count: item.evaluation.evaluations.length,
        failed_clauses: item.evaluation.evaluations.flatMap((clause, index) => clause.satisfied ? [] :
          [{ clause_index: index, operator: clause.operator }]) };
    }),
    limitations: review.limitations,
  };
}

/** Recorded state dwell times, not connector latency or a performance guarantee. */
export function lifecycleTiming(input, options = {}) {
  const bundle = deepClone(input);
  verifyBundle(bundle, { ...options, requireSemantics: true });
  const transitions = bundle.events.filter(event => event.event_type === "STATE_TRANSITION");
  let enteredAt = bundle.events[0].recorded_at;
  const intervals = transitions.map(event => {
    const interval = { state: event.payload.from_state, entered_at: enteredAt,
      left_at: event.recorded_at, duration_ms: Date.parse(event.recorded_at) - Date.parse(enteredAt) };
    enteredAt = event.recorded_at;
    return interval;
  });
  return { valid: true, bundle_digest: digest(bundle), verification_scope: "integrity_and_lifecycle_semantics",
    total_recorded_ms: intervals.reduce((sum, item) => sum + item.duration_ms, 0), intervals,
    ambiguity_observed: intervals.some(item => ["UNKNOWN", "REMEDY_UNKNOWN", "REVIEW_REQUIRED"].includes(item.state)),
    limitations: ["Signed recorded timestamps are not independent clock measurements or connector latency.",
      "Zero-duration intervals may reflect a fixed synthetic clock. No permission or retry is granted."] };
}

/** Verify first, then produce a metadata-only review with explicit assurance limits. */
export function reviewBundle(input, options = {}) {
  const bundle = deepClone(input);
  const verification = verifyBundle(bundle, {
    trustedKeys: options.trustedKeys,
    trustedConnectorKeys: options.trustedConnectorKeys,
    requireSemantics: bundle.profile === "audit",
  });
  const transitions = bundle.events.filter((event) => event.event_type === "STATE_TRANSITION");
  const attentionReasons = [
    ...(verification.outcome === "disputed" ? ["disputed_outcome"] : []),
    ...(verification.outcome === "compensated" ? ["compensation_recorded"] : []),
    ...(verification.bypass_possible ? ["bypass_possible"] : []),
    ...(transitions.some(event => ["UNKNOWN", "REMEDY_UNKNOWN", "REVIEW_REQUIRED"].includes(event.payload.to_state)) ? ["ambiguous_history"] : []),
    ...(bundle.profile === "receipt" ? ["semantics_not_checked"] : []),
  ];
  return {
    valid: true,
    attention_required: attentionReasons.length > 0,
    attention_reasons: attentionReasons,
    bundle_digest: digest(bundle),
    profile: bundle.profile,
    verification_scope: bundle.profile === "audit" ? "integrity_and_lifecycle_semantics" : "integrity_only",
    action_id: verification.action_id,
    action_digest: bundle.action.action_digest,
    outcome: verification.outcome,
    assurance_mode: verification.assurance_mode,
    bypass_possible: verification.bypass_possible,
    recourse_final_status: bundle.settlement_receipt.recourse_final_status,
    closed_at: bundle.settlement_receipt.closed_at,
    event_count: verification.event_count,
    evidence_count: bundle.evidence_manifest.length,
    state_path: transitions.length === 0 ? [] : [
      transitions[0].payload.from_state,
      ...transitions.map((event) => event.payload.to_state),
    ],
    event_chain_head: verification.event_chain_head,
    trusted_key_ids: [verification.trusted_key_id, verification.trusted_connector_key_id],
    limitations: [
      ...(bundle.profile === "receipt" ? ["Raw evidence and proposal are omitted; lifecycle semantics were not verified."] : []),
      "Signatures do not establish evidence truth or production credential custody.",
      "No current recovery qualification or permission to execute is granted by this review.",
    ],
  };
}
/** Compare two independently verified artifacts without exposing their payloads. */
export function compareBundles(leftInput, rightInput, options = {}) {
  const leftBundle = deepClone(leftInput);
  const rightBundle = deepClone(rightInput);
  const left = reviewBundle(leftBundle, options);
  const right = reviewBundle(rightBundle, options);
  const fields = ["profile", "verification_scope", "action_digest", "outcome", "assurance_mode",
    "bypass_possible", "recourse_final_status", "closed_at", "event_count", "evidence_count", "event_chain_head"];
  const sameReceipt = digest(leftBundle.settlement_receipt) === digest(rightBundle.settlement_receipt);
  return {
    valid: true,
    same_bundle: left.bundle_digest === right.bundle_digest,
    same_action: left.action_digest === right.action_digest,
    same_receipt: sameReceipt,
    left_bundle_digest: left.bundle_digest,
    right_bundle_digest: right.bundle_digest,
    changes: fields.filter((field) => left[field] !== right[field]).map((field) => ({ field, left: left[field], right: right[field] })),
    interpretation: sameReceipt ? "Both artifacts bind the same signed settlement receipt." : "The artifacts contain different signed receipts; comparison does not establish which is authoritative.",
  };
}
