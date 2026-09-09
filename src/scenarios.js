import { deepClone, deepFreeze } from "./canonical.js";
import { DEMO_FAULTS } from "./demo.js";
import { INVENTORY_DEMO_FAULTS } from "./inventory-demo.js";
import { RECOVERY_DEMO_FAULTS } from "./recovery-demo.js";

const OUTCOMES = {
  none: "settled", duplicate: "compensated", "lost-response-after-commit": "settled",
  "lost-response-before-commit": null, "stale-evidence": "disputed", "remedy-failure": "disputed",
  "remedy-lost-response-after-commit": "compensated", "remedy-lost-response-before-commit": "disputed",
  "post-remedy-stale-evidence": "disputed", "post-remedy-false-evidence": "disputed",
  "permit-replay": "settled", "action-mutation": null, "tampered-bundle": "settled",
};
const PURPOSES = {
  none: "Verify a satisfied postcondition.", duplicate: "Detect a duplicate and verify reserved reversal.",
  "lost-response-after-commit": "Resolve ambiguous execution through status without replay.",
  "lost-response-before-commit": "Confirm no effect after an ambiguous response.",
  "stale-evidence": "Refuse settlement from stale observations.",
  "remedy-failure": "Keep a failed remedy disputed.",
  "remedy-lost-response-after-commit": "Reconcile a completed remedy without replay.",
  "remedy-lost-response-before-commit": "Dispute an uncommitted remedy without blind retry.",
  "post-remedy-stale-evidence": "Refuse compensation from stale recovery evidence.",
  "post-remedy-false-evidence": "Refuse compensation when the postcondition still fails.",
  "permit-replay": "Reject a consumed permit.", "action-mutation": "Reject changed parameters before execution.",
  "tampered-bundle": "Detect modified event bytes.", "missing-checkpoint": "Reject a missing checkpoint.",
  "corrupt-checkpoint": "Reject checkpoint digest mismatch.", "fault-not-observed": "Reject a drill that never observed its fault.",
  "not-testable-local": "Disclose that a local exact drill is unavailable.", "out-of-scope": "Reject recovery outside declared scope.",
};
const scenarios = deepFreeze([
  ...[["refund", DEMO_FAULTS], ["inventory", INVENTORY_DEMO_FAULTS]].map(([name, faults]) => ({
    name, assurance_modes: ["enforced", "cooperative", "observed"], expected_assurance: "enforced",
    faults: faults.map((name) => ({ name, purpose: PURPOSES[name], expected: {
      state: name === "action-mutation" ? "PERMITTED" : name === "lost-response-before-commit" ? "FAILED" : "CLOSED",
      outcome: OUTCOMES[name],
      ...(name === "action-mutation" ? { rejection: "DIGEST_MISMATCH" } : name === "permit-replay" ? { rejection: "PERMIT_USED" } : {}),
    } })),
  })),
  { name: "recovery-preflight", assurance_modes: [], faults: RECOVERY_DEMO_FAULTS.map((name) => ({
    name, purpose: name === "remedy-failure" ? "Reject a drill whose remedy fails." : PURPOSES[name], expected: { qualification: name === "none" ? "QUALIFIED_EXACT" :
      ["not-testable-local", "out-of-scope"].includes(name) ? "NOT_TESTABLE_LOCAL" : "NOT_QUALIFIED" },
  })) },
  { name: "irreversible", assurance_modes: [], faults: [], expected: { admitted: false } },
]);

export function scenarioCatalog() {
  return { synthetic_only: true, production_recovery_claimed: false, scenarios: deepClone(scenarios) };
}
