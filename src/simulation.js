// Simulation evidence: a connector's signed dry run of one exact action.
// The rail accepts it before the permit, binds its digest into ActionPermit
// v0.2, refuses a permit when the dry run predicts a breach, and after
// execution records which postcondition facts the real effect diverged on.

import { deepClone, digest } from "./canonical.js";
import { RailError } from "./errors.js";
import { unmetBindings } from "./action-classes.js";
import { evaluatePostcondition, missingPostconditionPaths } from "./postconditions.js";
import { verifyArtifact } from "./signing.js";

export const SIMULATION_RESULT_SCHEMA_VERSION = "consequence-rail/simulation-result/v0.1";
export const SIMULATION_RESULT_FIELDS = Object.freeze([
  "schema_version",
  "action_digest",
  "connector",
  "simulated_at",
  "predicted_facts",
  "signature",
]);

function check(condition, code, message) {
  if (!condition) throw new RailError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Check a connector's SimulationResult for one action at one instant and
 * evaluate the action's postcondition against the predicted facts.
 */
export function verifySimulationResult(result, { proposal, actionDigest, trustedKeys, now }) {
  let copy;
  try {
    copy = deepClone(result);
    digest(copy);
  } catch {
    throw new RailError("SIMULATION_INVALID", "SimulationResult must be canonical JSON.");
  }
  check(isPlainObject(copy), "SIMULATION_INVALID", "SimulationResult must be an object.");
  const keys = Object.keys(copy);
  check(
    keys.length === SIMULATION_RESULT_FIELDS.length && SIMULATION_RESULT_FIELDS.every((field) => keys.includes(field)),
    "SIMULATION_INVALID",
    "SimulationResult has missing or unsupported fields.",
  );
  check(copy.schema_version === SIMULATION_RESULT_SCHEMA_VERSION, "SIMULATION_INVALID", "Unsupported SimulationResult schema.");
  check(copy.action_digest === actionDigest, "SIMULATION_ACTION_MISMATCH", "SimulationResult is bound to a different action.");
  check(copy.connector === proposal.target.connector, "SIMULATION_INVALID", "SimulationResult names a different connector.");
  check(isPlainObject(copy.predicted_facts), "SIMULATION_INVALID", "SimulationResult.predicted_facts must be an object.");
  const simulatedAt = Date.parse(copy.simulated_at);
  check(
    typeof copy.simulated_at === "string" && Number.isFinite(simulatedAt) && new Date(simulatedAt).toISOString() === copy.simulated_at,
    "SIMULATION_INVALID",
    "SimulationResult.simulated_at must be an ISO timestamp.",
  );
  const verified = verifyArtifact(copy, trustedKeys);
  const age = new Date(now).getTime() - simulatedAt;
  check(age >= 0, "SIMULATION_FROM_FUTURE", "SimulationResult is dated in the future.");
  check(age <= proposal.evidence_plan.max_age_seconds * 1_000, "SIMULATION_STALE", "SimulationResult is older than the evidence freshness window.");
  check(
    missingPostconditionPaths(proposal.postcondition, copy.predicted_facts).length === 0,
    "SIMULATION_INCOMPLETE",
    "SimulationResult does not predict every postcondition fact.",
  );
  check(
    unmetBindings(proposal, copy.predicted_facts).length === 0,
    "SIMULATION_BINDING_MISMATCH",
    "SimulationResult predicts facts that contradict the parameters the proposal binds them to.",
  );
  const evaluation = evaluatePostcondition(proposal.postcondition, { facts: copy.predicted_facts });
  return {
    simulation: copy,
    simulation_digest: digest(copy),
    predicted_satisfied: evaluation.satisfied,
    key_id: verified.key_id,
  };
}
