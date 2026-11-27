// Signed authorization decisions. A policy system (for example a
// Constitutional Agent Testbench evaluation, a Cedar engine or a human
// approver) signs one decision over one exact action digest with its own
// key. The rail accepts it only under an explicitly trusted authorizer key,
// so the agent that proposes an action cannot also approve it.

import { deepClone, digest } from "./canonical.js";
import { RailError } from "./errors.js";
import {
  assert,
  assertDigest,
  assertExactFields,
  assertNoUnknownFields,
  assertNonEmptyString,
  assertTimestamp,
} from "./rail-schema.js";
import { normalizeSigner, signArtifact, verifyArtifact } from "./signing.js";

export const AUTHORIZATION_DECISION_SCHEMA_VERSION =
  "consequence-rail/authorization-decision/v0.1";

// The longest a signed decision may stay usable. A decision is consumed by
// one authorize call; a short life limits the window for a stolen copy.
export const MAX_AUTHORIZATION_TTL_SECONDS = 86_400;

const DECISION_FIELDS = new Set([
  "schema_version",
  "decision_id",
  "action_digest",
  "allow",
  "policy_id",
  "policy_digest",
  "evaluation_input_digest",
  "require_recovery_preflight",
  "decided_at",
  "expires_at",
  "signature",
]);
const INPUT_FIELDS = new Set([
  "actionDigest",
  "allow",
  "policyId",
  "policyDigest",
  "evaluationInputDigest",
  "requireRecoveryPreflight",
  "decidedAt",
  "expiresAt",
]);

/** True when a value claims to be a signed AuthorizationDecision. */
export function isSignedAuthorizationDecision(value) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "schema_version") &&
    value.schema_version === AUTHORIZATION_DECISION_SCHEMA_VERSION;
}

function checkDecisionBody(body, code) {
  assertDigest(body.action_digest, "AuthorizationDecision.action_digest", code);
  assert(typeof body.allow === "boolean", code, "AuthorizationDecision.allow must be boolean.");
  assertNonEmptyString(body.policy_id, "AuthorizationDecision.policy_id", code);
  assertDigest(body.policy_digest, "AuthorizationDecision.policy_digest", code);
  assert(
    body.evaluation_input_digest === null ||
      (typeof body.evaluation_input_digest === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(body.evaluation_input_digest)),
    code,
    "AuthorizationDecision.evaluation_input_digest must be a digest or null.",
  );
  assert(
    typeof body.require_recovery_preflight === "boolean",
    code,
    "AuthorizationDecision.require_recovery_preflight must be boolean.",
  );
  const decidedAt = assertTimestamp(body.decided_at, "AuthorizationDecision.decided_at", code);
  const expiresAt = assertTimestamp(body.expires_at, "AuthorizationDecision.expires_at", code);
  assert(
    expiresAt > decidedAt &&
      expiresAt - decidedAt <= MAX_AUTHORIZATION_TTL_SECONDS * 1_000,
    code,
    `AuthorizationDecision must expire after decided_at and within ${MAX_AUTHORIZATION_TTL_SECONDS} seconds.`,
  );
}

/**
 * Sign one decision over one action digest. The signer is the authorizer's
 * own Ed25519 key, never the rail's key.
 */
export function createAuthorizationDecision(input, signer) {
  assertNoUnknownFields(input ?? {}, INPUT_FIELDS, "Authorization decision input", "AUTHORIZATION_INVALID");
  const normalized = normalizeSigner(signer, "AUTHORIZATION_INVALID");
  const body = {
    schema_version: AUTHORIZATION_DECISION_SCHEMA_VERSION,
    action_digest: input.actionDigest,
    allow: input.allow,
    policy_id: input.policyId,
    policy_digest: input.policyDigest,
    evaluation_input_digest: input.evaluationInputDigest ?? null,
    require_recovery_preflight: input.requireRecoveryPreflight ?? false,
    decided_at: input.decidedAt,
    expires_at: input.expiresAt,
  };
  checkDecisionBody(body, "AUTHORIZATION_INVALID");
  body.decision_id = `authz_${digest(body).slice(0, 20)}`;
  return signArtifact(body, normalized);
}

/**
 * Verify a signed decision for one action at one instant. Throws a RailError
 * with an AUTHORIZATION_* code, UNTRUSTED_KEY or SIGNATURE_INVALID; returns
 * the decision digest and signing key id on success.
 */
export function verifyAuthorizationDecision(
  decision,
  { trustedKeys, actionDigest, now },
) {
  const code = "AUTHORIZATION_INVALID";
  let copy;
  try {
    copy = deepClone(decision);
  } catch {
    throw new RailError(code, "AuthorizationDecision must be canonical JSON.");
  }
  assertExactFields(copy, DECISION_FIELDS, "AuthorizationDecision", code);
  assert(
    copy.schema_version === AUTHORIZATION_DECISION_SCHEMA_VERSION,
    code,
    "Unsupported AuthorizationDecision schema version.",
  );
  checkDecisionBody(copy, code);
  const { signature: _signature, decision_id: decisionId, ...unsigned } = copy;
  assert(
    decisionId === `authz_${digest(unsigned).slice(0, 20)}`,
    code,
    "AuthorizationDecision.decision_id does not match its contents.",
  );
  if (!(trustedKeys instanceof Map) || trustedKeys.size === 0) {
    throw new RailError(
      "AUTHORIZER_UNTRUSTED",
      "No authorizer key is trusted, so a signed decision cannot be accepted.",
    );
  }
  const verified = verifyArtifact(copy, trustedKeys);
  assert(
    copy.action_digest === actionDigest,
    "AUTHORIZATION_ACTION_MISMATCH",
    "AuthorizationDecision is bound to a different action.",
  );
  const nowMs = new Date(now).getTime();
  assert(
    new Date(copy.decided_at).getTime() <= nowMs,
    "AUTHORIZATION_FROM_FUTURE",
    "AuthorizationDecision was decided after the current time.",
  );
  assert(
    new Date(copy.expires_at).getTime() > nowMs,
    "AUTHORIZATION_EXPIRED",
    "AuthorizationDecision has expired.",
  );
  return {
    decision: copy,
    decision_digest: verified.digest,
    key_id: verified.key_id,
  };
}
