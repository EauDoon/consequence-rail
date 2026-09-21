// Schema constants, field sets, and assertion helpers used by the
// consequence-rail orchestrator. Pure data and validators with no class
// state. The ConsequenceRail class lives in src/rail-class.js.

import { deepClone, deepFreeze } from "./canonical.js";
import { RailError } from "./errors.js";

export const SHA256_BASE64URL = /^[A-Za-z0-9_-]{43}$/;
export const MAX_DURATION_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);

export const RECEIPT_RECOURSE_STATUSES = new Set([
  "active",
  "expired",
  "released",
  "consumed",
]);

const PROPOSAL_FIELDS = new Set([
  "schema_version",
  "action_type",
  "subject",
  "target",
  "parameters",
  "idempotency_key",
  "requested_at",
  "expires_at",
  "assurance_mode",
  "postcondition",
  "evidence_plan",
]);

const RECOURSE_COMMON_INPUT_FIELDS = [
  "action_digest",
  "kind",
  "connector",
  "capability",
  "capability_reference",
  "expires_at",
  "remedy_window_seconds",
  "max_attempts",
  "idempotency_key",
];
const RECOURSE_INPUT_FIELDS = new Set([...RECOURSE_COMMON_INPUT_FIELDS, "max_amount_minor"]);
const INVENTORY_RECOURSE_INPUT_FIELDS = new Set([...RECOURSE_COMMON_INPUT_FIELDS, "max_quantity"]);
const AUTHORIZATION_FIELDS = new Set([
  "allow",
  "policy_id",
  "policy_digest",
  "evaluation_input_digest",
  "require_recovery_preflight",
]);
const SUBJECT_FIELDS = new Set(["type", "id"]);
const TARGET_FIELDS = new Set(["connector", "resource_type", "resource_id"]);
const REFUND_PARAMETER_FIELDS = new Set(["amount_minor", "currency"]);
const INVENTORY_PARAMETER_FIELDS = new Set(["sku", "quantity"]);
export const DEMO_ACTION_TYPES = new Set([
  "demo.refund.issue/v1",
  "demo.email.send/v1",
  "demo.inventory.allocate/v1",
]);
/**
 * The remedy scope field is domain-specific: refunds scope by minor currency
 * amount, inventory allocations by unit quantity. Each action type keeps its
 * own field so no domain is disguised as another.
 */
export function recourseScopeField(actionType) {
  return actionType === "demo.inventory.allocate/v1" ? "max_quantity" : "max_amount_minor";
}
const EMAIL_PARAMETER_FIELDS = new Set(["recipient_id", "subject"]);
const EVIDENCE_PLAN_FIELDS = new Set(["source", "max_age_seconds"]);
const EVIDENCE_FIELDS = new Set([
  "schema_version",
  "action_digest",
  "source",
  "resource",
  "observed_at",
  "facts",
]);
const EVIDENCE_RESOURCE_FIELDS = new Set(["type", "id"]);
const CONNECTOR_COMMITMENT_COMMON_FIELDS = [
  "schema_version",
  "reservation_token",
  "action_digest",
  "connector",
  "capability",
  "kind",
  "expires_at",
  "max_attempts",
  "reserved_at",
  "status",
  "signature",
];
const CONNECTOR_COMMITMENT_FIELDS = new Set([
  ...CONNECTOR_COMMITMENT_COMMON_FIELDS,
  "max_amount_minor",
]);
const INVENTORY_CONNECTOR_COMMITMENT_FIELDS = new Set([
  ...CONNECTOR_COMMITMENT_COMMON_FIELDS,
  "max_quantity",
]);
const RECOURSE_STATUS_FIELDS = new Set(["reservation_token", "status"]);
const CONNECTOR_CAPABILITY_FIELDS = new Set([
  "connector",
  "exclusive_credential_custody",
  "actions",
  "remedies",
  "connector_signing_key_id",
]);
export const EXECUTION_FAULTS = new Set([
  "none",
  "duplicate",
  "lost-response-before-commit",
  "lost-response-after-commit",
  "remedy-failure",
]);
const EVIDENCE_FAULTS = new Set(["none", "stale-evidence"]);
const REMEDIATION_FAULTS = new Set([
  "none",
  "remedy-failure",
  "remedy-lost-response-before-commit",
  "remedy-lost-response-after-commit",
  "post-remedy-stale-evidence",
  "post-remedy-false-evidence",
]);
const REMEDY_EVIDENCE_FAULTS = new Set([
  "none",
  "post-remedy-stale-evidence",
  "post-remedy-false-evidence",
]);
const EXECUTION_RESULTS = new Set(["executed"]);
const EXECUTION_STATUSES = new Set(["executed", "no_effect", "unknown"]);
const REMEDY_RESULTS = new Set(["remediated", "failed", "no_effect", "no_change"]);
const REMEDY_STATUSES = new Set([...REMEDY_RESULTS, "unknown"]);
const CONNECTOR_RESULT_FIELDS = new Set(["status", "idempotency_key"]);

export {
  PROPOSAL_FIELDS,
  AUTHORIZATION_FIELDS,
  SUBJECT_FIELDS,
  TARGET_FIELDS,
  REFUND_PARAMETER_FIELDS,
  INVENTORY_PARAMETER_FIELDS,
  EMAIL_PARAMETER_FIELDS,
  EVIDENCE_PLAN_FIELDS,
  EVIDENCE_FIELDS,
  EVIDENCE_RESOURCE_FIELDS,
  RECOURSE_INPUT_FIELDS,
  INVENTORY_RECOURSE_INPUT_FIELDS,
  CONNECTOR_COMMITMENT_FIELDS,
  INVENTORY_CONNECTOR_COMMITMENT_FIELDS,
  RECOURSE_STATUS_FIELDS,
  CONNECTOR_CAPABILITY_FIELDS,
  EVIDENCE_FAULTS,
  REMEDIATION_FAULTS,
  REMEDY_EVIDENCE_FAULTS,
  EXECUTION_RESULTS,
  EXECUTION_STATUSES,
  REMEDY_RESULTS,
  REMEDY_STATUSES,
  CONNECTOR_RESULT_FIELDS,
};

function assert(condition, code, message, details = {}) {
  if (!condition) {
    throw new RailError(code, message, details);
  }
}

function assertPlainObject(object, objectName, code = "SCHEMA_INVALID") {
  assert(
    object &&
      typeof object === "object" &&
      !Array.isArray(object) &&
      (Object.getPrototypeOf(object) === Object.prototype ||
        Object.getPrototypeOf(object) === null),
    code,
    `${objectName} must be a plain object.`,
  );
}

function assertNoUnknownFields(object, allowed, objectName, code = "SCHEMA_INVALID") {
  assertPlainObject(object, objectName, code);
  const unknown = Object.keys(object).filter((key) => !allowed.has(key));
  assert(unknown.length === 0, code, `${objectName} contains unknown fields.`, {
    fields: unknown,
  });
}

function assertRequiredFields(object, required, objectName, code = "SCHEMA_INVALID") {
  const missing = [...required].filter((key) => !Object.hasOwn(object, key));
  assert(missing.length === 0, code, `${objectName} is missing required fields.`, {
    fields: missing,
  });
}

function assertExactFields(object, fields, objectName, code = "SCHEMA_INVALID") {
  assertNoUnknownFields(object, fields, objectName, code);
  assertRequiredFields(object, fields, objectName, code);
}

function assertNonEmptyString(value, label, code = "SCHEMA_INVALID") {
  assert(typeof value === "string" && value.length > 0, code, `${label} is required.`);
}

function assertSafeInteger(value, label, {
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  code = "SCHEMA_INVALID",
  message,
} = {}) {
  assert(
    Number.isSafeInteger(value) && value >= min && value <= max,
    code,
    message ?? `${label} must be an integer between ${min} and ${max}.`,
  );
}

function assertDigest(value, label, code = "SCHEMA_INVALID") {
  assert(
    typeof value === "string" && SHA256_BASE64URL.test(value),
    code,
    `${label} must be a SHA-256 base64url digest.`,
  );
}

function assertTimestamp(value, label, code = "SCHEMA_INVALID") {
  const milliseconds = new Date(value).getTime();
  assert(
    typeof value === "string" &&
      Number.isFinite(milliseconds) &&
      new Date(milliseconds).toISOString() === value,
    code,
    `${label} must be an ISO date-time string.`,
  );
  return milliseconds;
}

function assertConnectorResult(result, idempotencyKey, allowedStatuses, label, code) {
  let clone;
  try {
    clone = deepClone(result);
  } catch {
    throw new RailError(code, `${label} must be canonical JSON.`);
  }
  assertPlainObject(clone, label, code);
  const owned = deepFreeze(Object.assign(Object.create(null), clone));
  assertRequiredFields(owned, CONNECTOR_RESULT_FIELDS, label, code);
  assert(
    owned.idempotency_key === idempotencyKey,
    code,
    `${label} is not bound to the requested idempotency key.`,
  );
  assert(
    allowedStatuses.has(owned.status),
    code,
    `${label} has an unsupported status.`,
  );
  return owned;
}

export {
  assert,
  assertPlainObject,
  assertNoUnknownFields,
  assertRequiredFields,
  assertExactFields,
  assertNonEmptyString,
  assertSafeInteger,
  assertDigest,
  assertTimestamp,
  assertConnectorResult,
};
