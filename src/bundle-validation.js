import { digest } from "./canonical.js";
import { RailError } from "./errors.js";

const SHA256_BASE64URL = /^[A-Za-z0-9_-]{43}$/;
const ED25519_BASE64URL = /^[A-Za-z0-9_-]{86}$/;

const BUNDLE_FIELDS = new Set([
  "schema_version",
  "profile",
  "action",
  "recourse_reservation",
  "action_permit",
  "evidence_manifest",
  "outcome_evidence",
  "settlement_receipt",
  "events",
  "trust_hint",
]);
const ACTION_FIELDS = new Set([
  "action_id",
  "action_digest",
  "action_type",
  "resource_id_digest",
  "proposal",
]);
const ACTION_REQUIRED_FIELDS = new Set([
  "action_id",
  "action_digest",
  "action_type",
  "resource_id_digest",
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
const SUBJECT_FIELDS = new Set(["type", "id"]);
const TARGET_FIELDS = new Set(["connector", "resource_type", "resource_id"]);
const REFUND_PARAMETER_FIELDS = new Set(["amount_minor", "currency"]);
const EMAIL_PARAMETER_FIELDS = new Set(["recipient_id", "subject"]);
const POSTCONDITION_FIELDS = new Set(["op", "clauses"]);
const POSTCONDITION_CLAUSE_FIELDS = new Set(["path", "op", "value"]);
const EVIDENCE_PLAN_FIELDS = new Set(["source", "max_age_seconds"]);
const RESERVATION_FIELDS = new Set([
  "schema_version",
  "reservation_id",
  "action_digest",
  "kind",
  "connector",
  "capability",
  "expires_at",
  "remedy_window_seconds",
  "max_attempts",
  "max_amount_minor",
  "capability_reference_digest",
  "idempotency_key_digest",
  "reserved_by",
  "checked_at",
  "reserved_at",
  "connector_commitment",
  "signature",
]);
const RESERVATION_REQUIRED_FIELDS = new Set(
  [...RESERVATION_FIELDS].filter((field) => !["reserved_by", "checked_at"].includes(field)),
);
const COMMITMENT_FIELDS = new Set([
  "schema_version",
  "reservation_token",
  "action_digest",
  "connector",
  "capability",
  "kind",
  "expires_at",
  "max_attempts",
  "max_amount_minor",
  "reserved_at",
  "status",
  "signature",
]);
const PERMIT_FIELDS = new Set([
  "schema_version",
  "permit_id",
  "action_id",
  "action_digest",
  "recourse_reservation_digest",
  "assurance_mode",
  "bypass_possible",
  "gated",
  "jti",
  "issued_at",
  "expires_at",
  "max_uses",
  "signature",
]);
const EVIDENCE_FIELDS = new Set([
  "schema_version",
  "action_digest",
  "source",
  "resource",
  "observed_at",
  "facts",
  "evaluation",
  "captured_by",
  "phase",
  "signature",
]);
const EVIDENCE_REQUIRED_FIELDS = new Set(
  [...EVIDENCE_FIELDS].filter((field) => field !== "phase"),
);
const RESOURCE_FIELDS = new Set(["type", "id"]);
const RECEIPT_FIELDS = new Set([
  "schema_version",
  "receipt_id",
  "action_id",
  "action_digest",
  "recourse_reservation_digest",
  "connector_recourse_commitment_digest",
  "recourse_final_status",
  "action_permit_digest",
  "assurance_mode",
  "bypass_possible",
  "gated",
  "outcome",
  "configured_postcondition_result",
  "evidence_digests",
  "event_chain_head",
  "closed_at",
  "technical_claim",
  "limitations",
  "signature",
]);
const EVENT_FIELDS = new Set([
  "schema_version",
  "action_id",
  "sequence",
  "previous_hash",
  "event_type",
  "actor",
  "recorded_at",
  "payload",
  "signature",
  "event_hash",
]);
const SIGNATURE_FIELDS = new Set(["algorithm", "key_id", "value"]);
const TRUST_HINT_FIELDS = new Set(["rail", "connector", "warning"]);
const TRUST_KEY_FIELDS = new Set(["key_id", "public_key_pem"]);

function invalid(message, details = {}) {
  throw new RailError("BUNDLE_TAMPERED", message, details);
}

function plainObject(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    invalid(`${label} must be a plain object.`);
  }
}

function exactObject(value, allowed, required, label) {
  plainObject(value, label);
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  const missing = [...required].filter((field) => !Object.hasOwn(value, field));
  if (unknown.length > 0 || missing.length > 0) {
    invalid(`${label} does not match its closed schema.`, { unknown, missing });
  }
}

function string(value, label, { nonempty = false } = {}) {
  if (typeof value !== "string" || (nonempty && value.length === 0)) {
    invalid(`${label} must be${nonempty ? " a non-empty" : ""} string.`);
  }
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    invalid(`${label} must be an integer of at least ${minimum}.`);
  }
}

function timestamp(value, label) {
  const milliseconds = new Date(value).getTime();
  if (
    typeof value !== "string" ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    invalid(`${label} must be an exact ISO date-time string.`);
  }
}

function digestString(value, label) {
  if (typeof value !== "string" || !SHA256_BASE64URL.test(value)) {
    invalid(`${label} must be a SHA-256 base64url digest.`);
  }
}

function stringArray(value, label, { digests = false } = {}) {
  if (!Array.isArray(value)) invalid(`${label} must be an array.`);
  value.forEach((item, index) => {
    if (digests) digestString(item, `${label}[${index}]`);
    else string(item, `${label}[${index}]`);
  });
}

function signature(value, label) {
  exactObject(value, SIGNATURE_FIELDS, SIGNATURE_FIELDS, label);
  if (
    value.algorithm !== "Ed25519" ||
    typeof value.key_id !== "string" ||
    value.key_id.length === 0 ||
    typeof value.value !== "string" ||
    !ED25519_BASE64URL.test(value.value)
  ) {
    invalid(`${label} is not a supported Ed25519 signature.`);
  }
}

function postcondition(value) {
  exactObject(value, POSTCONDITION_FIELDS, POSTCONDITION_FIELDS, "ActionProposal.postcondition");
  if (value.op !== "all" || !Array.isArray(value.clauses) || value.clauses.length === 0) {
    invalid("ActionProposal.postcondition must contain one or more all-clauses.");
  }
  value.clauses.forEach((clause, index) => {
    const label = `ActionProposal.postcondition.clauses[${index}]`;
    exactObject(clause, POSTCONDITION_CLAUSE_FIELDS, POSTCONDITION_CLAUSE_FIELDS, label);
    string(clause.path, `${label}.path`, { nonempty: true });
    if (!new Set(["eq", "gte", "lte"]).has(clause.op)) {
      invalid(`${label}.op is unsupported.`);
    }
  });
}

function proposal(value) {
  exactObject(value, PROPOSAL_FIELDS, PROPOSAL_FIELDS, "ActionProposal");
  if (value.schema_version !== "consequence-rail/action-proposal/v0.1") {
    invalid("ActionProposal schema version is unsupported.");
  }
  if (!new Set(["demo.refund.issue/v1", "demo.email.send/v1"]).has(value.action_type)) {
    invalid("ActionProposal action type is unsupported.");
  }
  exactObject(value.subject, SUBJECT_FIELDS, SUBJECT_FIELDS, "ActionProposal.subject");
  string(value.subject.type, "ActionProposal.subject.type", { nonempty: true });
  string(value.subject.id, "ActionProposal.subject.id", { nonempty: true });
  exactObject(value.target, TARGET_FIELDS, TARGET_FIELDS, "ActionProposal.target");
  for (const field of TARGET_FIELDS) {
    string(value.target[field], `ActionProposal.target.${field}`, { nonempty: true });
  }
  if (value.action_type === "demo.refund.issue/v1") {
    exactObject(
      value.parameters,
      REFUND_PARAMETER_FIELDS,
      REFUND_PARAMETER_FIELDS,
      "ActionProposal.parameters",
    );
    integer(value.parameters.amount_minor, "ActionProposal.parameters.amount_minor", 1);
    if (!/^[A-Z]{3}$/.test(value.parameters.currency ?? "")) {
      invalid("ActionProposal.parameters.currency is invalid.");
    }
  } else {
    exactObject(
      value.parameters,
      EMAIL_PARAMETER_FIELDS,
      EMAIL_PARAMETER_FIELDS,
      "ActionProposal.parameters",
    );
    string(value.parameters.recipient_id, "ActionProposal.parameters.recipient_id", { nonempty: true });
    string(value.parameters.subject, "ActionProposal.parameters.subject", { nonempty: true });
  }
  string(value.idempotency_key, "ActionProposal.idempotency_key", { nonempty: true });
  timestamp(value.requested_at, "ActionProposal.requested_at");
  timestamp(value.expires_at, "ActionProposal.expires_at");
  if (!new Set(["enforced", "cooperative", "observed"]).has(value.assurance_mode)) {
    invalid("ActionProposal assurance mode is unsupported.");
  }
  postcondition(value.postcondition);
  exactObject(
    value.evidence_plan,
    EVIDENCE_PLAN_FIELDS,
    EVIDENCE_PLAN_FIELDS,
    "ActionProposal.evidence_plan",
  );
  string(value.evidence_plan.source, "ActionProposal.evidence_plan.source", { nonempty: true });
  integer(value.evidence_plan.max_age_seconds, "ActionProposal.evidence_plan.max_age_seconds", 1);
}

function action(value) {
  exactObject(value, ACTION_FIELDS, ACTION_REQUIRED_FIELDS, "SettlementBundle.action");
  string(value.action_id, "SettlementBundle.action.action_id", { nonempty: true });
  digestString(value.action_digest, "SettlementBundle.action.action_digest");
  string(value.action_type, "SettlementBundle.action.action_type", { nonempty: true });
  digestString(value.resource_id_digest, "SettlementBundle.action.resource_id_digest");
  if (Object.hasOwn(value, "proposal")) proposal(value.proposal);
}

function commitment(value) {
  exactObject(value, COMMITMENT_FIELDS, COMMITMENT_FIELDS, "ConnectorRecourseCommitment");
  if (value.schema_version !== "consequence-rail/connector-recourse-commitment/v0.1") {
    invalid("ConnectorRecourseCommitment schema version is unsupported.");
  }
  for (const field of ["reservation_token", "connector", "capability"]) {
    string(value[field], `ConnectorRecourseCommitment.${field}`, { nonempty: true });
  }
  digestString(value.action_digest, "ConnectorRecourseCommitment.action_digest");
  if (!new Set(["reverse", "compensate", "escalate"]).has(value.kind)) {
    invalid("ConnectorRecourseCommitment kind is unsupported.");
  }
  timestamp(value.expires_at, "ConnectorRecourseCommitment.expires_at");
  integer(value.max_attempts, "ConnectorRecourseCommitment.max_attempts", 1);
  integer(value.max_amount_minor, "ConnectorRecourseCommitment.max_amount_minor");
  timestamp(value.reserved_at, "ConnectorRecourseCommitment.reserved_at");
  if (value.status !== "active") invalid("ConnectorRecourseCommitment must be active.");
  signature(value.signature, "ConnectorRecourseCommitment.signature");
}

function reservation(value) {
  exactObject(
    value,
    RESERVATION_FIELDS,
    RESERVATION_REQUIRED_FIELDS,
    "RecourseReservation",
  );
  if (value.schema_version !== "consequence-rail/recourse-reservation/v0.1") {
    invalid("RecourseReservation schema version is unsupported.");
  }
  for (const field of ["reservation_id", "connector", "capability"]) {
    string(value[field], `RecourseReservation.${field}`, { nonempty: true });
  }
  digestString(value.action_digest, "RecourseReservation.action_digest");
  digestString(
    value.capability_reference_digest,
    "RecourseReservation.capability_reference_digest",
  );
  digestString(value.idempotency_key_digest, "RecourseReservation.idempotency_key_digest");
  if (!new Set(["reverse", "compensate", "escalate"]).has(value.kind)) {
    invalid("RecourseReservation kind is unsupported.");
  }
  timestamp(value.expires_at, "RecourseReservation.expires_at");
  integer(value.remedy_window_seconds, "RecourseReservation.remedy_window_seconds");
  integer(value.max_attempts, "RecourseReservation.max_attempts", 1);
  integer(value.max_amount_minor, "RecourseReservation.max_amount_minor");
  if (Object.hasOwn(value, "reserved_by")) {
    string(value.reserved_by, "RecourseReservation.reserved_by");
  }
  if (Object.hasOwn(value, "checked_at")) {
    timestamp(value.checked_at, "RecourseReservation.checked_at");
  }
  timestamp(value.reserved_at, "RecourseReservation.reserved_at");
  commitment(value.connector_commitment);
  signature(value.signature, "RecourseReservation.signature");
}

function permit(value) {
  exactObject(value, PERMIT_FIELDS, PERMIT_FIELDS, "ActionPermit");
  if (value.schema_version !== "consequence-rail/action-permit/v0.1") {
    invalid("ActionPermit schema version is unsupported.");
  }
  for (const field of ["permit_id", "action_id", "jti"]) {
    string(value[field], `ActionPermit.${field}`, { nonempty: true });
  }
  digestString(value.action_digest, "ActionPermit.action_digest");
  digestString(
    value.recourse_reservation_digest,
    "ActionPermit.recourse_reservation_digest",
  );
  if (!new Set(["enforced", "cooperative"]).has(value.assurance_mode)) {
    invalid("ActionPermit assurance mode is unsupported.");
  }
  if (typeof value.bypass_possible !== "boolean" || value.gated !== true || value.max_uses !== 1) {
    invalid("ActionPermit gate fields are invalid.");
  }
  timestamp(value.issued_at, "ActionPermit.issued_at");
  timestamp(value.expires_at, "ActionPermit.expires_at");
  signature(value.signature, "ActionPermit.signature");
}

function evidence(value, index) {
  const label = `OutcomeEvidence[${index}]`;
  exactObject(value, EVIDENCE_FIELDS, EVIDENCE_REQUIRED_FIELDS, label);
  if (value.schema_version !== "consequence-rail/outcome-evidence/v0.1") {
    invalid(`${label} schema version is unsupported.`);
  }
  digestString(value.action_digest, `${label}.action_digest`);
  string(value.source, `${label}.source`, { nonempty: true });
  exactObject(value.resource, RESOURCE_FIELDS, RESOURCE_FIELDS, `${label}.resource`);
  string(value.resource.type, `${label}.resource.type`, { nonempty: true });
  string(value.resource.id, `${label}.resource.id`, { nonempty: true });
  timestamp(value.observed_at, `${label}.observed_at`);
  plainObject(value.facts, `${label}.facts`);
  plainObject(value.evaluation, `${label}.evaluation`);
  string(value.captured_by, `${label}.captured_by`, { nonempty: true });
  if (Object.hasOwn(value, "phase")) string(value.phase, `${label}.phase`);
  signature(value.signature, `${label}.signature`);
}

function receipt(value) {
  exactObject(value, RECEIPT_FIELDS, RECEIPT_FIELDS, "SettlementReceipt");
  if (value.schema_version !== "consequence-rail/settlement-receipt/v0.1") {
    invalid("SettlementReceipt schema version is unsupported.");
  }
  for (const field of ["receipt_id", "action_id", "technical_claim"]) {
    string(value[field], `SettlementReceipt.${field}`, { nonempty: true });
  }
  for (const field of [
    "action_digest",
    "recourse_reservation_digest",
    "connector_recourse_commitment_digest",
    "action_permit_digest",
    "event_chain_head",
  ]) {
    digestString(value[field], `SettlementReceipt.${field}`);
  }
  if (!new Set(["active", "expired", "released", "consumed"]).has(value.recourse_final_status)) {
    invalid("SettlementReceipt recourse status is unsupported.");
  }
  if (!new Set(["enforced", "cooperative"]).has(value.assurance_mode)) {
    invalid("SettlementReceipt assurance mode is unsupported.");
  }
  if (typeof value.bypass_possible !== "boolean" || value.gated !== true) {
    invalid("SettlementReceipt gate fields are invalid.");
  }
  if (!new Set(["settled", "compensated", "disputed"]).has(value.outcome)) {
    invalid("SettlementReceipt outcome is unsupported.");
  }
  if (!new Set(["satisfied", "unresolved"]).has(value.configured_postcondition_result)) {
    invalid("SettlementReceipt postcondition result is unsupported.");
  }
  stringArray(value.evidence_digests, "SettlementReceipt.evidence_digests", { digests: true });
  timestamp(value.closed_at, "SettlementReceipt.closed_at");
  stringArray(value.limitations, "SettlementReceipt.limitations");
  signature(value.signature, "SettlementReceipt.signature");
}

function event(value, index) {
  const label = `Event[${index}]`;
  exactObject(value, EVENT_FIELDS, EVENT_FIELDS, label);
  if (value.schema_version !== "consequence-rail/event/v0.1") {
    invalid(`${label} schema version is unsupported.`);
  }
  string(value.action_id, `${label}.action_id`, { nonempty: true });
  integer(value.sequence, `${label}.sequence`);
  if (value.previous_hash !== null) digestString(value.previous_hash, `${label}.previous_hash`);
  string(value.event_type, `${label}.event_type`, { nonempty: true });
  string(value.actor, `${label}.actor`, { nonempty: true });
  timestamp(value.recorded_at, `${label}.recorded_at`);
  plainObject(value.payload, `${label}.payload`);
  signature(value.signature, `${label}.signature`);
  digestString(value.event_hash, `${label}.event_hash`);
}

function trustHint(value) {
  exactObject(value, TRUST_HINT_FIELDS, TRUST_HINT_FIELDS, "SettlementBundle.trust_hint");
  exactObject(value.rail, TRUST_KEY_FIELDS, TRUST_KEY_FIELDS, "SettlementBundle.trust_hint.rail");
  exactObject(
    value.connector,
    TRUST_KEY_FIELDS,
    TRUST_KEY_FIELDS,
    "SettlementBundle.trust_hint.connector",
  );
  string(value.rail.key_id, "SettlementBundle.trust_hint.rail.key_id", { nonempty: true });
  string(value.rail.public_key_pem, "SettlementBundle.trust_hint.rail.public_key_pem", { nonempty: true });
  string(value.connector.key_id, "SettlementBundle.trust_hint.connector.key_id", { nonempty: true });
  if (value.connector.public_key_pem !== null) {
    string(
      value.connector.public_key_pem,
      "SettlementBundle.trust_hint.connector.public_key_pem",
      { nonempty: true },
    );
  }
  string(value.warning, "SettlementBundle.trust_hint.warning", { nonempty: true });
}

export function validateSettlementBundle(bundle) {
  try {
    digest(bundle);
  } catch (error) {
    invalid("SettlementBundle is not canonical strict JSON.", {
      cause_code: error?.code ?? "CANONICALIZATION_FAILED",
    });
  }
  exactObject(bundle, BUNDLE_FIELDS, BUNDLE_FIELDS, "SettlementBundle");
  if (bundle.schema_version !== "consequence-rail/settlement-bundle/v0.1") {
    invalid("SettlementBundle schema version is unsupported.");
  }
  if (!new Set(["receipt", "audit"]).has(bundle.profile)) {
    invalid("SettlementBundle profile is unsupported.");
  }
  action(bundle.action);
  reservation(bundle.recourse_reservation);
  permit(bundle.action_permit);
  stringArray(bundle.evidence_manifest, "SettlementBundle.evidence_manifest", { digests: true });
  if (!Array.isArray(bundle.outcome_evidence)) {
    invalid("SettlementBundle.outcome_evidence must be an array.");
  }
  bundle.outcome_evidence.forEach(evidence);
  receipt(bundle.settlement_receipt);
  if (!Array.isArray(bundle.events)) invalid("SettlementBundle.events must be an array.");
  bundle.events.forEach(event);
  trustHint(bundle.trust_hint);
  return bundle;
}
