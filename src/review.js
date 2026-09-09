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
