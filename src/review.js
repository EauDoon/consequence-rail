import { deepClone, digest } from "./canonical.js";
import { verifyBundle } from "./verify.js";

/** Verify first, then produce a metadata-only review with explicit assurance limits. */
export function reviewBundle(input, options = {}) {
  const bundle = deepClone(input);
  const verification = verifyBundle(bundle, {
    trustedKeys: options.trustedKeys,
    trustedConnectorKeys: options.trustedConnectorKeys,
    requireSemantics: bundle.profile === "audit",
  });
  const transitions = bundle.events.filter((event) => event.event_type === "STATE_TRANSITION");
  return {
    valid: true,
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
    state_path: transitions.map((event) => event.payload.to_state),
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
  const left = reviewBundle(leftInput, options);
  const right = reviewBundle(rightInput, options);
  const fields = ["profile", "verification_scope", "action_digest", "outcome", "assurance_mode",
    "bypass_possible", "recourse_final_status", "closed_at", "event_count", "evidence_count", "event_chain_head"];
  const sameReceipt = digest(leftInput.settlement_receipt) === digest(rightInput.settlement_receipt);
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
