import { deepClone, deepFreeze, digest } from "./canonical.js";
import { isExpired } from "./clock.js";
import { MemoryEventStore } from "./event-store.js";
import { RailError } from "./errors.js";
import { evaluatePostcondition } from "./postconditions.js";
import { verifyRecoveryPreflight } from "./recovery-preflight.js";
import { signArtifact, verifyArtifact } from "./signing.js";

export const ASSURANCE_MODES = ["enforced", "cooperative", "observed"];

export const ALLOWED_TRANSITIONS = {
  PROPOSED: ["AUTHORIZED", "DENIED"],
  AUTHORIZED: ["EXPIRED", "REVOKED", "RECOURSE_RESERVED"],
  RECOURSE_RESERVED: ["EXPIRED", "REVOKED", "PERMITTED"],
  PERMITTED: ["EXPIRED", "REVOKED", "EXECUTING"],
  EXECUTING: ["EXECUTED", "FAILED", "UNKNOWN"],
  UNKNOWN: ["EXECUTED", "FAILED", "REVIEW_REQUIRED"],
  EXECUTED: ["VERIFYING"],
  VERIFYING: ["SATISFIED", "BREACHED", "INCONCLUSIVE"],
  BREACHED: ["REMEDY_DUE"],
  REMEDY_DUE: ["REMEDIATING", "REVIEW_REQUIRED"],
  REMEDIATING: ["REMEDY_VERIFYING", "REMEDY_FAILED", "REMEDY_UNKNOWN"],
  REMEDY_UNKNOWN: ["REMEDY_VERIFYING", "REMEDY_FAILED", "REVIEW_REQUIRED"],
  REMEDY_VERIFYING: ["REMEDIATED", "REMEDY_FAILED", "REMEDY_INCONCLUSIVE"],
  SATISFIED: ["CLOSED"],
  REMEDIATED: ["CLOSED"],
  INCONCLUSIVE: ["CLOSED"],
  REMEDY_INCONCLUSIVE: ["CLOSED"],
  REVIEW_REQUIRED: ["CLOSED"],
  REMEDY_FAILED: ["CLOSED"],
};

const RECEIPT_OUTCOME_BY_STATE = {
  SATISFIED: "settled",
  REMEDIATED: "compensated",
  INCONCLUSIVE: "disputed",
  REMEDY_INCONCLUSIVE: "disputed",
  REVIEW_REQUIRED: "disputed",
  REMEDY_FAILED: "disputed",
};

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

const RECOURSE_INPUT_FIELDS = new Set([
  "action_digest",
  "kind",
  "connector",
  "capability",
  "capability_reference",
  "expires_at",
  "remedy_window_seconds",
  "max_attempts",
  "max_amount_minor",
  "idempotency_key",
]);
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
const CONNECTOR_COMMITMENT_FIELDS = new Set([
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
const RECOURSE_STATUS_FIELDS = new Set(["reservation_token", "status"]);
const CONNECTOR_CAPABILITY_FIELDS = new Set([
  "connector",
  "exclusive_credential_custody",
  "actions",
  "remedies",
  "connector_signing_key_id",
]);
const SHA256_BASE64URL = /^[A-Za-z0-9_-]{43}$/;
const MAX_ACTIONS = 1_000;
const MAX_DURATION_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);
const EXECUTION_FAULTS = new Set([
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

export class ConsequenceRail {
  constructor({
    signer,
    clock,
    connector,
    connectorTrustedKeys,
    recoveryTrustedKeys,
    requireRecoveryPreflight = false,
    measureRecoveryImplementation = null,
    maxActions = MAX_ACTIONS,
    eventStore,
  } = {}) {
    assert(signer && clock && connector, "CONFIG_INVALID", "Signer, clock and connector are required.");
    assert(
      typeof requireRecoveryPreflight === "boolean",
      "CONFIG_INVALID",
      "requireRecoveryPreflight must be boolean.",
    );
    assert(
      measureRecoveryImplementation === null ||
        typeof measureRecoveryImplementation === "function",
      "CONFIG_INVALID",
      "measureRecoveryImplementation must be a function when supplied.",
    );
    assert(
      Number.isInteger(maxActions) && maxActions > 0,
      "CONFIG_INVALID",
      "maxActions must be a positive integer.",
    );
    this.signer = signer;
    this.clock = clock;
    this.connector = connector;
    this.connectorTrustedKeys = connectorTrustedKeys ?? new Map();
    this.recoveryTrustedKeys = recoveryTrustedKeys ?? new Map();
    this.requireRecoveryPreflight = requireRecoveryPreflight;
    this.measureRecoveryImplementation = measureRecoveryImplementation;
    this.maxActions = maxActions;
    this.eventStore = eventStore ?? new MemoryEventStore(signer, clock);
    this.actions = new Map();
    this.trustedKeys = new Map([[signer.kid, signer.publicKey]]);
  }

  propose(input) {
    assert(
      this.actions.size < this.maxActions,
      "ACTION_CAPACITY_REACHED",
      "The in-memory action capacity has been reached.",
    );
    const proposal = this.validateProposal(input);
    const actionDigest = digest(proposal);
    const actionId = `act_${actionDigest.slice(0, 20)}`;
    assert(!this.actions.has(actionId), "ACTION_EXISTS", "An identical action is already registered.", {
      action_id: actionId,
    });

    const record = {
      action_id: actionId,
      action_digest: actionDigest,
      proposal: deepFreeze(deepClone(proposal)),
      state: "PROPOSED",
      permit_uses: 0,
      remedy_attempts: 0,
      evidence: [],
      receipt: null,
    };
    this.actions.set(actionId, record);
    this.eventStore.append(actionId, "ACTION_PROPOSED", "rail", {
      state: "PROPOSED",
      action_digest: actionDigest,
      action_type: proposal.action_type,
      assurance_mode: proposal.assurance_mode,
    });
    return this.inspect(actionId);
  }

  authorize(actionId, decision) {
    const record = this.get(actionId);
    this.assertState(record, "PROPOSED");
    assertNoUnknownFields(decision, AUTHORIZATION_FIELDS, "AuthorizationDecision");
    assertRequiredFields(
      decision,
      new Set(["allow", "policy_id", "policy_digest"]),
      "AuthorizationDecision",
    );
    assert(typeof decision.allow === "boolean", "SCHEMA_INVALID", "Authorization requires allow.");
    assertNonEmptyString(decision.policy_id, "Authorization policy_id");
    assertDigest(decision.policy_digest, "Authorization policy_digest");
    if (decision.evaluation_input_digest !== undefined) {
      assertDigest(
        decision.evaluation_input_digest,
        "Authorization evaluation_input_digest",
      );
    }
    assert(
      decision.require_recovery_preflight === undefined ||
        typeof decision.require_recovery_preflight === "boolean",
      "SCHEMA_INVALID",
      "require_recovery_preflight must be boolean when supplied.",
    );

    record.authorization = deepFreeze(deepClone({
      allow: decision.allow,
      policy_id: decision.policy_id,
      policy_digest: decision.policy_digest,
      evaluation_input_digest: decision.evaluation_input_digest ?? null,
      require_recovery_preflight:
        this.requireRecoveryPreflight ||
        decision.require_recovery_preflight === true,
      decided_at: this.clock.now(),
    }));
    this.transition(record, decision.allow ? "AUTHORIZED" : "DENIED", decision.allow ? "POLICY_ALLOWED" : "POLICY_DENIED", {
      policy_id: decision.policy_id,
      policy_digest: decision.policy_digest,
    });
    return this.inspect(actionId);
  }

  acceptRecoveryQualification(actionId, bundle) {
    const record = this.get(actionId);
    this.assertState(record, "RECOURSE_RESERVED");
    const verification = verifyRecoveryPreflight(bundle, {
      trustedKeys: this.recoveryTrustedKeys,
      now: this.clock.now(),
      requireCurrent: true,
    });
    assert(
      verification.qualification === "QUALIFIED_EXACT",
      "RECOVERY_PREFLIGHT_NOT_QUALIFIED",
      "Recovery preflight did not qualify exact recovery.",
      { qualification: verification.qualification },
    );

    const contract = bundle.recovery_contract;
    assert(
      contract.action_digest === record.action_digest &&
        contract.action_class === record.proposal.action_type &&
        contract.scope.connector === record.proposal.target.connector &&
        contract.scope.resource_type === record.proposal.target.resource_type &&
        contract.scope.assurance_mode === record.proposal.assurance_mode &&
        contract.scope.parameters_digest === digest(record.proposal.parameters) &&
        contract.scope.postcondition_digest ===
          digest(record.proposal.postcondition) &&
        contract.scope.evidence_plan_digest ===
          digest(record.proposal.evidence_plan),
      "RECOVERY_COVERAGE_MISMATCH",
      "Recovery preflight does not cover the proposed action envelope.",
    );
    this.assertRecoveryBinding(
      record,
      contract,
      "RECOVERY_COVERAGE_MISMATCH",
    );

    record.recovery_preflight = deepFreeze(deepClone(bundle));
    record.recovery_preflight_verification = deepFreeze(
      deepClone(verification),
    );
    this.eventStore.append(
      actionId,
      "RECOVERY_PREFLIGHT_ACCEPTED",
      "recovery-preflight",
      {
        attestation_digest: verification.attestation_digest,
        coverage_digest: verification.coverage_digest,
        qualification: verification.qualification,
        expires_at: verification.expires_at,
      },
    );
    return this.inspect(actionId);
  }

  reserveRecourse(actionId, input) {
    const record = this.get(actionId);
    this.assertState(record, "AUTHORIZED");
    assert(
      record.proposal.assurance_mode !== "observed",
      "MODE_NOT_EXECUTABLE",
      "Observed mode cannot reserve recourse or issue execution permits.",
    );

    const request = this.validateReservation(record, input);
    assert(
      typeof this.connector.reserveRecourse === "function",
      "RECOURSE_UNAVAILABLE",
      "Connector does not implement recourse reservation.",
    );
    const connectorCommitment = this.connector.reserveRecourse(record.proposal, request);
    verifyArtifact(connectorCommitment, this.connectorTrustedKeys);
    this.validateConnectorCommitment(record, request, connectorCommitment);

    const reservation = {
      action_digest: request.action_digest,
      kind: request.kind,
      connector: request.connector,
      capability: request.capability,
      capability_reference_digest: digest(request.capability_reference),
      expires_at: request.expires_at,
      remedy_window_seconds: request.remedy_window_seconds,
      max_attempts: request.max_attempts,
      max_amount_minor: request.max_amount_minor,
      idempotency_key_digest: digest(request.idempotency_key),
      connector_commitment: connectorCommitment,
    };
    record.remedy_idempotency_key = request.idempotency_key;
    record.reservation = signArtifact({
      ...reservation,
      schema_version: "consequence-rail/recourse-reservation/v0.1",
      reservation_id: `rr_${digest(reservation).slice(0, 20)}`,
      reserved_at: this.clock.now(),
    }, this.signer);
    record.reservation_digest = digest(record.reservation);
    this.transition(record, "RECOURSE_RESERVED", "RECOURSE_VERIFIED", {
      reservation_digest: record.reservation_digest,
      remedy_kind: record.reservation.kind,
      capability: record.reservation.capability,
      connector_commitment_digest: digest(connectorCommitment),
    });
    return this.inspect(actionId);
  }

  issuePermit(actionId) {
    const record = this.get(actionId);
    this.assertState(record, "RECOURSE_RESERVED");
    this.assertNotExpired(record.proposal.expires_at, record, "ACTION_EXPIRED");
    this.assertNotExpired(record.reservation.expires_at, record, "RECOURSE_EXPIRED");

    const capabilities = this.connectorCapabilities();
    if (record.proposal.assurance_mode === "enforced") {
      assert(
        capabilities.exclusive_credential_custody === true,
        "ASSURANCE_UNSUPPORTED",
        "Enforced mode requires rail-exclusive downstream credential custody.",
      );
    }
    const recourseStatus = this.readRecourseStatus(record);
    if (recourseStatus.status !== "active") {
      this.transition(record, "REVOKED", "CONNECTOR_RECOURSE_NOT_ACTIVE", {
        recourse_status: recourseStatus.status,
      });
      this.finalizeRecourse(record, {
        release: true,
        reason: "CONNECTOR_RECOURSE_NOT_ACTIVE",
      });
      throw new RailError(
        "RECOURSE_NOT_ACTIVE",
        "Connector-backed recourse is no longer active.",
        {
          action_id: actionId,
          state: record.state,
        },
      );
    }

    if (record.authorization.require_recovery_preflight) {
      assert(
        record.recovery_preflight,
        "RECOVERY_PREFLIGHT_REQUIRED",
        "A current qualified recovery preflight is required before permit issuance.",
      );
      this.assertAcceptedRecoveryPreflight(record, { requireCurrent: true });
    }

    const permitBody = {
      schema_version: "consequence-rail/action-permit/v0.1",
      permit_id: `permit_${record.action_digest.slice(0, 20)}`,
      action_id: actionId,
      action_digest: record.action_digest,
      recourse_reservation_digest: record.reservation_digest,
      assurance_mode: record.proposal.assurance_mode,
      bypass_possible: record.proposal.assurance_mode !== "enforced",
      gated: true,
      jti: `jti_${digest({
        action_id: actionId,
        reservation_digest: record.reservation_digest,
      }).slice(0, 20)}`,
      issued_at: this.clock.now(),
      expires_at: record.proposal.expires_at,
      max_uses: 1,
    };
    record.permit = signArtifact(permitBody, this.signer);
    record.permit_digest = digest(record.permit);
    this.transition(record, "PERMITTED", "PERMIT_ISSUED", {
      permit_digest: record.permit_digest,
      assurance_mode: record.permit.assurance_mode,
      bypass_possible: record.permit.bypass_possible,
      ...(record.authorization.require_recovery_preflight
        ? {
            recovery_preflight_attestation_digest:
              record.recovery_preflight_verification.attestation_digest,
          }
        : {}),
    });
    return this.inspect(actionId);
  }

  async execute(actionId, options = {}) {
    assertNoUnknownFields(
      options,
      new Set(["fault", "proposalOverride"]),
      "Execution options",
    );
    const { fault = "none", proposalOverride } = options;
    assert(
      EXECUTION_FAULTS.has(fault),
      "SCHEMA_INVALID",
      "Execution fault is not supported.",
    );
    const record = this.get(actionId);
    assert(record.permit_uses === 0, "PERMIT_USED", "The single-use permit has already been consumed.", {
      action_id: actionId,
      state: record.state,
    });
    this.assertState(record, "PERMITTED");
    this.assertNotExpired(record.permit.expires_at, record, "PERMIT_EXPIRED");
    this.assertNotExpired(record.reservation.expires_at, record, "RECOURSE_EXPIRED");
    verifyArtifact(record.permit, this.trustedKeys);
    if (record.recovery_preflight) {
      this.assertAcceptedRecoveryPreflight(record, { requireCurrent: true });
    }

    const candidate = proposalOverride ?? record.proposal;
    assert(
      digest(candidate) === record.action_digest,
      "DIGEST_MISMATCH",
      "The execution payload does not match the authorized action digest.",
      { action_id: actionId, state: record.state },
    );
    const recourseStatus = this.readRecourseStatus(record);
    if (recourseStatus.status !== "active") {
      this.transition(record, "REVOKED", "CONNECTOR_RECOURSE_NOT_ACTIVE", {
        recourse_status: recourseStatus.status,
      });
      this.finalizeRecourse(record, {
        release: true,
        reason: "CONNECTOR_RECOURSE_NOT_ACTIVE",
      });
      throw new RailError(
        "RECOURSE_NOT_ACTIVE",
        "Connector-backed recourse is no longer active at execution time.",
        {
          action_id: actionId,
          state: record.state,
        },
      );
    }
    record.permit_uses += 1;
    this.transition(record, "EXECUTING", "PERMIT_CONSUMED", {
      permit_digest: record.permit_digest,
      use_number: record.permit_uses,
    });

    try {
      record.execution = assertConnectorResult(
        await this.connector.execute(
          record.proposal,
          record.proposal.idempotency_key,
          fault,
        ),
        record.proposal.idempotency_key,
        EXECUTION_RESULTS,
        "Connector execution result",
        "CONNECTOR_RESULT_INVALID",
      );
      this.transition(record, "EXECUTED", "CONNECTOR_EXECUTED", {
        external_reference_digest: digest(record.execution.external_id ?? record.execution.idempotency_key),
      });
    } catch {
      record.execution = {
        status: "unknown",
        idempotency_key: record.proposal.idempotency_key,
        external_id: null,
      };
      this.transition(record, "UNKNOWN", "EXECUTION_AMBIGUOUS", {
        idempotency_key_digest: digest(record.proposal.idempotency_key),
      });
    }

    return this.inspect(actionId);
  }

  async reconcile(actionId) {
    const record = this.get(actionId);
    this.assertState(record, "UNKNOWN");
    const status = assertConnectorResult(
      await this.connector.status(record.proposal.idempotency_key),
      record.proposal.idempotency_key,
      EXECUTION_STATUSES,
      "Connector execution status",
      "RECONCILIATION_INVALID",
    );
    record.execution = status;

    if (status.status === "executed") {
      this.transition(record, "EXECUTED", "STATUS_CONFIRMED_EXECUTED", {
        external_reference_digest: digest(status.external_id ?? status.idempotency_key),
      });
    } else if (status.status === "no_effect") {
      this.transition(record, "FAILED", "STATUS_CONFIRMED_NO_EFFECT", {
        idempotency_key_digest: digest(status.idempotency_key),
      });
      this.finalizeRecourse(record, {
        release: true,
        reason: "STATUS_CONFIRMED_NO_EFFECT",
      });
    } else {
      this.transition(record, "REVIEW_REQUIRED", "STATUS_UNRESOLVED", {});
      this.close(record);
    }
    return this.inspect(actionId);
  }

  async verifyOutcome(actionId, options = {}) {
    assertNoUnknownFields(
      options,
      new Set(["fault"]),
      "Outcome verification options",
    );
    const { fault = "none" } = options;
    assert(
      EVIDENCE_FAULTS.has(fault),
      "SCHEMA_INVALID",
      "Outcome evidence fault is not supported.",
    );
    const record = this.get(actionId);
    this.assertState(record, "EXECUTED");
    this.transition(record, "VERIFYING", "OUTCOME_VERIFICATION_STARTED", {});

    let evidence;
    try {
      evidence = await this.connector.observe(record.proposal, {
        fault,
        actionDigest: record.action_digest,
      });
    } catch {
      this.failClosedEvidenceObservation(record, "outcome");
      return this.inspect(actionId);
    }

    try {
      evidence = this.validateEvidence(record, evidence);
    } catch (error) {
      if (error instanceof RailError && error.code.startsWith("EVIDENCE_")) {
        this.eventStore.append(actionId, "EVIDENCE_REJECTED", "rail", {
          code: error.code,
        });
        this.transition(record, "INCONCLUSIVE", error.code, {});
        this.close(record);
        return this.inspect(actionId);
      }
      this.failClosedEvidenceObservation(record, "outcome");
      return this.inspect(actionId);
    }

    const evaluation = evaluatePostcondition(record.proposal.postcondition, evidence);
    const accepted = signArtifact({
      ...evidence,
      evaluation,
      captured_by: "consequence-rail",
    }, this.signer);
    record.evidence.push(accepted);
    this.eventStore.append(actionId, "EVIDENCE_ACCEPTED", "rail", {
      evidence_digest: digest(accepted),
      source: accepted.source,
      satisfied: evaluation.satisfied,
    });

    if (evaluation.satisfied) {
      this.transition(record, "SATISFIED", "POSTCONDITION_SATISFIED", {
        evidence_digest: digest(accepted),
      });
      this.close(record);
    } else {
      this.transition(record, "BREACHED", "POSTCONDITION_BREACHED", {
        evidence_digest: digest(accepted),
      });
      this.transition(record, "REMEDY_DUE", "RESERVED_REMEDY_DUE", {
        reservation_digest: record.reservation_digest,
      });
    }
    return this.inspect(actionId);
  }

  async remediate(actionId, options = {}) {
    assertNoUnknownFields(
      options,
      new Set(["fault"]),
      "Remediation options",
    );
    const { fault = "none" } = options;
    assert(
      REMEDIATION_FAULTS.has(fault),
      "SCHEMA_INVALID",
      "Remediation fault is not supported.",
    );
    const record = this.get(actionId);
    this.assertState(record, "REMEDY_DUE");
    if (isExpired(record.reservation.expires_at, this.clock.now())) {
      this.transition(record, "REVIEW_REQUIRED", "RECOURSE_EXPIRED", {});
      this.close(record);
      return this.inspect(actionId);
    }
    const recourseStatus = this.readRecourseStatus(record);
    if (recourseStatus.status !== "active") {
      this.transition(record, "REVIEW_REQUIRED", "RECOURSE_NOT_ACTIVE", {
        recourse_status: recourseStatus.status,
      });
      this.close(record);
      return this.inspect(actionId);
    }
    assert(
      record.remedy_attempts < record.reservation.max_attempts,
      "REMEDY_ATTEMPTS_EXHAUSTED",
      "The reserved remedy attempt limit has been reached.",
    );
    if (record.recovery_preflight) {
      this.assertAcceptedRecoveryPreflight(record, { requireCurrent: false });
    }
    const remediate = this.connector.remediate;
    assert(
      typeof remediate === "function",
      "RECOVERY_IMPLEMENTATION_INVALID",
      "The measured connector remediation method is unavailable.",
    );
    assert(
      record.reservation.kind === "reverse" || record.reservation.kind === "compensate",
      "REMEDY_REQUIRES_CHILD_ACTION",
      "Only a pre-authorized, bounded reversible remedy may run automatically.",
    );

    record.remedy_attempts += 1;
    this.transition(record, "REMEDIATING", "REMEDY_STARTED", {
      attempt: record.remedy_attempts,
      reservation_digest: record.reservation_digest,
    });
    try {
      record.remedy_result = assertConnectorResult(
        await Reflect.apply(remediate, this.connector, [
          record.proposal,
          record.reservation,
          record.remedy_idempotency_key,
          fault,
        ]),
        record.remedy_idempotency_key,
        REMEDY_RESULTS,
        "Connector remedy result",
        "CONNECTOR_RESULT_INVALID",
      );
    } catch {
      record.remedy_result = {
        status: "unknown",
        idempotency_key: record.remedy_idempotency_key,
        external_id: null,
      };
      this.transition(record, "REMEDY_UNKNOWN", "REMEDY_EXECUTION_AMBIGUOUS", {
        idempotency_key_digest: record.reservation.idempotency_key_digest,
      });
      return this.inspect(actionId);
    }

    if (record.remedy_result.status !== "remediated") {
      this.transition(record, "REMEDY_FAILED", "REMEDY_CONNECTOR_FAILED", {
        result: record.remedy_result.status,
      });
      this.close(record);
      return this.inspect(actionId);
    }

    this.transition(record, "REMEDY_VERIFYING", "REMEDY_EXECUTION_CONFIRMED", {
      result_digest: digest(record.remedy_result),
    });
    await this.verifyRemedyOutcome(record, { fault });
    return this.inspect(actionId);
  }

  async reconcileRemedy(actionId, options = {}) {
    assertNoUnknownFields(
      options,
      new Set(["evidenceFault"]),
      "Remedy reconciliation options",
    );
    const { evidenceFault = "none" } = options;
    assert(
      REMEDY_EVIDENCE_FAULTS.has(evidenceFault),
      "SCHEMA_INVALID",
      "Remedy evidence fault is not supported.",
    );
    const record = this.get(actionId);
    this.assertState(record, "REMEDY_UNKNOWN");
    const status = assertConnectorResult(
      await this.connector.remedyStatus(record.remedy_idempotency_key),
      record.remedy_idempotency_key,
      REMEDY_STATUSES,
      "Connector remedy status",
      "RECONCILIATION_INVALID",
    );
    record.remedy_result = status;

    if (status.status === "remediated") {
      this.transition(record, "REMEDY_VERIFYING", "REMEDY_STATUS_CONFIRMED", {
        result_digest: digest(status),
      });
      await this.verifyRemedyOutcome(record, { fault: evidenceFault });
    } else if (status.status === "no_effect" || status.status === "failed") {
      this.transition(record, "REMEDY_FAILED", "REMEDY_STATUS_CONFIRMED_NO_EFFECT", {
        result: status.status,
      });
      this.close(record);
    } else {
      this.transition(record, "REVIEW_REQUIRED", "REMEDY_STATUS_UNRESOLVED", {
        idempotency_key_digest: record.reservation.idempotency_key_digest,
      });
      this.close(record);
    }
    return this.inspect(actionId);
  }

  async verifyRemedyOutcome(record, { fault = "none" } = {}) {
    this.assertState(record, "REMEDY_VERIFYING");
    let evidence;
    try {
      const observed = await this.connector.observe(record.proposal, {
        actionDigest: record.action_digest,
        fault,
      });
      evidence = this.validateEvidence(record, observed);
    } catch (error) {
      if (error instanceof RailError && error.code.startsWith("EVIDENCE_")) {
        this.eventStore.append(record.action_id, "REMEDY_EVIDENCE_REJECTED", "rail", {
          code: error.code,
        });
        this.transition(record, "REMEDY_INCONCLUSIVE", error.code, {});
        this.close(record);
        return;
      }
      this.failClosedEvidenceObservation(record, "remedy");
      return;
    }

    const evaluation = evaluatePostcondition(record.proposal.postcondition, evidence);
    const accepted = signArtifact({
      ...evidence,
      evaluation,
      captured_by: "consequence-rail",
      phase: "post-remedy",
    }, this.signer);
    record.evidence.push(accepted);
    this.eventStore.append(record.action_id, "REMEDY_EVIDENCE_ACCEPTED", "rail", {
      evidence_digest: digest(accepted),
      satisfied: evaluation.satisfied,
    });

    if (evaluation.satisfied) {
      this.transition(record, "REMEDIATED", "REMEDY_VERIFIED", {
        evidence_digest: digest(accepted),
      });
    } else {
      this.transition(record, "REMEDY_INCONCLUSIVE", "REMEDY_POSTCONDITION_UNRESOLVED", {
        evidence_digest: digest(accepted),
      });
    }
    this.close(record);
  }

  inspect(actionId) {
    const record = this.get(actionId);
    const events = this.eventStore.list(actionId);
    const recoveryEnabled =
      record.authorization?.require_recovery_preflight === true;
    return {
      action_id: record.action_id,
      action_digest: record.action_digest,
      action_type: record.proposal.action_type,
      resource: {
        type: record.proposal.target.resource_type,
        id_digest: digest(record.proposal.target.resource_id),
      },
      state: record.state,
      assurance_mode: record.proposal.assurance_mode,
      bypass_possible: record.proposal.assurance_mode !== "enforced",
      permit_uses: record.permit_uses,
      remedy_attempts: record.remedy_attempts,
      event_count: events.length,
      event_chain_head: events.at(-1)?.event_hash ?? null,
      outcome: record.receipt?.outcome ?? null,
      ...(recoveryEnabled
        ? {
            recovery_preflight_required: true,
            recovery_preflight_qualification:
              record.recovery_preflight_verification?.qualification ?? null,
            recovery_preflight_attestation_digest:
              record.recovery_preflight_verification?.attestation_digest ?? null,
          }
        : {}),
    };
  }

  failClosedEvidenceObservation(record, phase) {
    const remedy = phase === "remedy";
    const code = remedy ? "REMEDY_EVIDENCE_UNAVAILABLE" : "EVIDENCE_UNAVAILABLE";
    this.eventStore.append(
      record.action_id,
      remedy ? "REMEDY_EVIDENCE_REJECTED" : "EVIDENCE_REJECTED",
      "rail",
      { code },
    );
    this.transition(
      record,
      remedy ? "REMEDY_INCONCLUSIVE" : "INCONCLUSIVE",
      code,
      {},
    );
    this.close(record);
  }

  exportBundle(actionId, { profile = "receipt" } = {}) {
    const record = this.get(actionId);
    assert(record.receipt, "RECEIPT_NOT_AVAILABLE", "A settlement receipt is not available.");
    const auditProfile = profile === "audit";
    assert(
      profile === "receipt" || profile === "audit",
      "BUNDLE_PROFILE_INVALID",
      "Bundle profile must be receipt or audit.",
    );
    return deepClone({
      schema_version: "consequence-rail/settlement-bundle/v0.1",
      profile: auditProfile ? "audit" : "receipt",
      action: {
        action_id: actionId,
        action_digest: record.action_digest,
        action_type: record.proposal.action_type,
        resource_id_digest: digest(record.proposal.target.resource_id),
        ...(auditProfile ? { proposal: record.proposal } : {}),
      },
      recourse_reservation: record.reservation,
      action_permit: record.permit,
      evidence_manifest: record.evidence.map((item) => digest(item)),
      outcome_evidence: auditProfile ? record.evidence : [],
      settlement_receipt: record.receipt,
      events: this.eventStore.list(actionId),
      trust_hint: {
        rail: {
          key_id: this.signer.kid,
          public_key_pem: this.signer.publicKeyPem,
        },
        connector: {
          key_id: record.reservation.connector_commitment.signature.key_id,
          public_key_pem: this.connector.signer?.publicKeyPem ?? null,
        },
        warning: "An embedded key is not trusted automatically.",
      },
    });
  }

  get(actionId) {
    const record = this.actions.get(actionId);
    if (!record) {
      throw new RailError("ACTION_NOT_FOUND", "Action was not found.", {
        action_id: actionId,
      });
    }
    return record;
  }

  recoveryImplementationDigest(record, code) {
    assert(
      typeof this.measureRecoveryImplementation === "function",
      code,
      "A trusted recovery implementation measurer is required.",
    );
    let implementationDigest;
    try {
      implementationDigest = this.measureRecoveryImplementation(
        this.connector,
        record.reservation.capability,
      );
    } catch (error) {
      throw new RailError(
        code,
        "The recovery implementation could not be measured.",
        { cause_code: error.code ?? "RECOVERY_IMPLEMENTATION_INVALID" },
      );
    }
    assertDigest(implementationDigest, "Recovery implementation digest", code);
    return implementationDigest;
  }

  assertRecoveryBinding(record, contract, code) {
    verifyArtifact(record.reservation, this.trustedKeys);
    verifyArtifact(
      record.reservation.connector_commitment,
      this.connectorTrustedKeys,
    );
    const actualReservationDigest = digest(record.reservation);
    const actualCommitmentDigest = digest(
      record.reservation.connector_commitment,
    );
    const actualImplementationDigest =
      this.recoveryImplementationDigest(record, code);
    assert(
      actualReservationDigest === record.reservation_digest &&
        contract.recourse.kind === record.reservation.kind &&
        contract.recourse.capability === record.reservation.capability &&
        contract.recourse.reservation_digest === actualReservationDigest &&
        contract.recourse.capability_reference_digest ===
          record.reservation.capability_reference_digest &&
        contract.recourse.connector_commitment_digest ===
          actualCommitmentDigest &&
        contract.recourse.implementation_digest ===
          actualImplementationDigest,
      code,
      "Recovery preflight does not match the exact live recourse binding.",
    );
  }

  assertAcceptedRecoveryPreflight(record, { requireCurrent }) {
    assert(
      record.recovery_preflight && record.recovery_preflight_verification,
      "RECOVERY_PREFLIGHT_REQUIRED",
      "A qualified recovery preflight is required.",
    );
    const verification = verifyRecoveryPreflight(record.recovery_preflight, {
      trustedKeys: this.recoveryTrustedKeys,
      now: requireCurrent ? this.clock.now() : null,
      requireCurrent,
    });
    assert(
      verification.qualification === "QUALIFIED_EXACT" &&
        verification.attestation_digest ===
          record.recovery_preflight_verification.attestation_digest,
      "RECOVERY_PREFLIGHT_NOT_QUALIFIED",
      "The accepted recovery preflight is no longer valid.",
    );
    this.assertRecoveryBinding(
      record,
      record.recovery_preflight.recovery_contract,
      "RECOVERY_PREFLIGHT_NOT_QUALIFIED",
    );
  }

  readRecourseStatus(record) {
    const expectedToken =
      record.reservation.connector_commitment.reservation_token;
    const status = this.connector.recourseStatus(expectedToken);
    assertExactFields(
      status,
      RECOURSE_STATUS_FIELDS,
      "Connector recourse status",
      "RECOURSE_STATUS_INVALID",
    );
    assert(
      status.reservation_token === expectedToken &&
        ["active", "expired", "released", "consumed", "unknown"].includes(
          status.status,
        ),
      "RECOURSE_STATUS_INVALID",
      "Connector recourse status is not bound to the expected reservation.",
    );
    return status;
  }

  connectorCapabilities(code = "RECOURSE_INVALID") {
    const capabilities = this.connector.capabilities();
    assertExactFields(
      capabilities,
      CONNECTOR_CAPABILITY_FIELDS,
      "Connector capabilities",
      code,
    );
    assertNonEmptyString(capabilities.connector, "Connector name", code);
    assert(
      typeof capabilities.exclusive_credential_custody === "boolean" &&
        Array.isArray(capabilities.actions) &&
        capabilities.actions.every((item) => typeof item === "string") &&
        Array.isArray(capabilities.remedies) &&
        capabilities.remedies.every((item) => typeof item === "string"),
      code,
      "Connector capabilities are malformed.",
    );
    assertNonEmptyString(
      capabilities.connector_signing_key_id,
      "Connector signing key id",
      code,
    );
    return capabilities;
  }

  transition(record, nextState, reasonCode, details) {
    const allowed = ALLOWED_TRANSITIONS[record.state] ?? [];
    assert(allowed.includes(nextState), "ILLEGAL_TRANSITION", `Cannot transition from ${record.state} to ${nextState}.`, {
      action_id: record.action_id,
      state: record.state,
      requested_state: nextState,
    });
    const previousState = record.state;
    record.state = nextState;
    this.eventStore.append(record.action_id, "STATE_TRANSITION", "rail", {
      from_state: previousState,
      to_state: nextState,
      reason_code: reasonCode,
      details_digest: digest(details ?? {}),
    });
  }

  finalizeRecourse(record, { release, reason }) {
    if (!record.reservation?.connector_commitment) {
      return null;
    }
    if (record.recourse_status_recorded) {
      return record.recourse_status_recorded;
    }

    const reservationToken =
      record.reservation.connector_commitment.reservation_token;
    if (release) {
      this.connector.releaseRecourse(reservationToken);
    }
    const status = this.readRecourseStatus(record);
    this.eventStore.append(
      record.action_id,
      status.status === "active"
        ? "RECOURSE_STATUS_RECORDED"
        : "RECOURSE_FINALIZED",
      "connector",
      {
        connector_commitment_digest: digest(
          record.reservation.connector_commitment,
        ),
        status: status.status,
        reason,
      },
    );
    record.recourse_status_recorded = status;
    return status;
  }

  close(record) {
    const outcome = RECEIPT_OUTCOME_BY_STATE[record.state];
    assert(outcome, "ILLEGAL_TRANSITION", `State ${record.state} cannot produce a settlement receipt.`);
    const recourseFinalStatus = this.finalizeRecourse(record, {
      release: outcome !== "disputed",
      reason: `SETTLEMENT_${outcome.toUpperCase()}`,
    });
    this.transition(record, "CLOSED", `SETTLEMENT_${outcome.toUpperCase()}`, {
      outcome,
    });
    const events = this.eventStore.list(record.action_id);
    const receiptBody = {
      schema_version: "consequence-rail/settlement-receipt/v0.1",
      receipt_id: `receipt_${digest({
        action_id: record.action_id,
        event_chain_head: events.at(-1).event_hash,
      }).slice(0, 20)}`,
      action_id: record.action_id,
      action_digest: record.action_digest,
      recourse_reservation_digest: record.reservation_digest,
      connector_recourse_commitment_digest: digest(record.reservation.connector_commitment),
      recourse_final_status: recourseFinalStatus.status,
      action_permit_digest: record.permit_digest,
      assurance_mode: record.proposal.assurance_mode,
      bypass_possible: record.proposal.assurance_mode !== "enforced",
      gated: true,
      outcome,
      configured_postcondition_result:
        outcome === "settled" || outcome === "compensated" ? "satisfied" : "unresolved",
      evidence_digests: record.evidence.map((item) => digest(item)),
      event_chain_head: events.at(-1).event_hash,
      closed_at: this.clock.now(),
      technical_claim:
        "The configured postcondition was evaluated against declared evidence sources.",
      limitations: [
        "Signatures establish integrity and provenance, not truth or causality.",
        "Settlement is a technical protocol status, not a legal or financial determination.",
        "Recovery is not guaranteed.",
      ],
    };
    record.receipt = signArtifact(receiptBody, this.signer);
  }

  validateProposal(input) {
    assertExactFields(input, PROPOSAL_FIELDS, "ActionProposal");
    assert(
      input.schema_version === "consequence-rail/action-proposal/v0.1",
      "SCHEMA_INVALID",
      "Unsupported ActionProposal schema version.",
    );
    assert(
      input.action_type === "demo.refund.issue/v1" || input.action_type === "demo.email.send/v1",
      "SCHEMA_INVALID",
      "Unsupported action type.",
    );
    assertExactFields(input.subject, SUBJECT_FIELDS, "ActionProposal.subject");
    assertNonEmptyString(input.subject.type, "ActionProposal.subject.type");
    assertNonEmptyString(input.subject.id, "ActionProposal.subject.id");
    assertExactFields(input.target, TARGET_FIELDS, "ActionProposal.target");
    for (const field of TARGET_FIELDS) {
      assertNonEmptyString(input.target[field], `ActionProposal.target.${field}`);
    }
    assertNonEmptyString(input.idempotency_key, "ActionProposal.idempotency_key");
    assert(ASSURANCE_MODES.includes(input.assurance_mode), "SCHEMA_INVALID", "Unknown assurance mode.");
    const requestedAt = assertTimestamp(
      input.requested_at,
      "ActionProposal.requested_at",
    );
    const expiresAt = assertTimestamp(
      input.expires_at,
      "ActionProposal.expires_at",
    );
    assert(
      expiresAt > requestedAt,
      "SCHEMA_INVALID",
      "expires_at must be after requested_at.",
    );
    assert(
      !isExpired(input.expires_at, this.clock.now()),
      "ACTION_EXPIRED",
      "ActionProposal has expired.",
    );
    assertExactFields(
      input.evidence_plan,
      EVIDENCE_PLAN_FIELDS,
      "ActionProposal.evidence_plan",
    );
    assertNonEmptyString(
      input.evidence_plan.source,
      "ActionProposal.evidence_plan.source",
    );
    assertSafeInteger(
      input.evidence_plan.max_age_seconds,
      "ActionProposal.evidence_plan.max_age_seconds",
      {
        min: 1,
        max: MAX_DURATION_SECONDS,
        message: "A positive evidence max age is required.",
      },
    );
    evaluatePostcondition(input.postcondition, { facts: {} });

    if (input.action_type === "demo.refund.issue/v1") {
      assertExactFields(
        input.parameters,
        REFUND_PARAMETER_FIELDS,
        "ActionProposal.parameters",
      );
      assertSafeInteger(
        input.parameters.amount_minor,
        "ActionProposal.parameters.amount_minor",
        {
          min: 1,
          message: "Refund amount_minor must be a positive integer.",
        },
      );
      assert(
        /^[A-Z]{3}$/.test(input.parameters?.currency ?? ""),
        "SCHEMA_INVALID",
        "Refund currency must be a three-letter uppercase code.",
      );
    } else {
      assertExactFields(
        input.parameters,
        EMAIL_PARAMETER_FIELDS,
        "ActionProposal.parameters",
      );
      assertNonEmptyString(
        input.parameters.recipient_id,
        "ActionProposal.parameters.recipient_id",
      );
      assertNonEmptyString(
        input.parameters.subject,
        "ActionProposal.parameters.subject",
      );
    }

    digest(input);

    return deepClone(input);
  }

  validateReservation(record, input) {
    assertExactFields(
      input,
      RECOURSE_INPUT_FIELDS,
      "RecourseReservation request",
      "RECOURSE_INVALID",
    );
    assertDigest(
      input.action_digest,
      "RecourseReservation action_digest",
      "RECOURSE_INVALID",
    );
    assert(
      input.action_digest === record.action_digest,
      "RECOURSE_INVALID",
      "RecourseReservation is not bound to this action.",
    );
    assert(
      ["reverse", "compensate", "escalate"].includes(input.kind),
      "RECOURSE_INVALID",
      "Unsupported remedy kind.",
    );
    assert(
      input.connector === record.proposal.target.connector,
      "RECOURSE_INVALID",
      "Recourse connector does not match the action connector.",
    );
    const capabilities = this.connectorCapabilities();
    assert(
      capabilities.connector === input.connector &&
        Array.isArray(capabilities.remedies) &&
        capabilities.remedies.every((item) => typeof item === "string") &&
        capabilities.remedies.includes(input.capability),
      "RECOURSE_INVALID",
      "Connector does not advertise the reserved remedy capability.",
    );
    assertSafeInteger(input.max_attempts, "RecourseReservation.max_attempts", {
      min: 1,
      code: "RECOURSE_INVALID",
      message: "Recourse max_attempts must be a positive integer.",
    });
    assert(
      typeof input.capability_reference === "string" &&
        input.capability_reference.length > 0,
      "RECOURSE_INVALID",
      "Recourse capability_reference is required.",
    );
    assertSafeInteger(
      input.remedy_window_seconds,
      "RecourseReservation.remedy_window_seconds",
      {
        min: 0,
        max: MAX_DURATION_SECONDS,
        code: "RECOURSE_INVALID",
        message: "Recourse remedy_window_seconds must be a non-negative integer.",
      },
    );
    assertSafeInteger(
      input.max_amount_minor,
      "RecourseReservation.max_amount_minor",
      {
        min: 0,
        code: "RECOURSE_INVALID",
        message: "Recourse max_amount_minor must be a non-negative integer.",
      },
    );
    assert(
      typeof input.idempotency_key === "string" && input.idempotency_key.length > 0,
      "RECOURSE_INVALID",
      "Recourse idempotency key is required.",
    );
    assertTimestamp(
      input.expires_at,
      "RecourseReservation expires_at",
      "RECOURSE_INVALID",
    );
    assert(!isExpired(input.expires_at, this.clock.now()), "RECOURSE_EXPIRED", "RecourseReservation has expired.");
    const requiredCoverage =
      new Date(record.proposal.expires_at).getTime() +
      Number(input.remedy_window_seconds ?? 0) * 1_000;
    assert(
      new Date(input.expires_at).getTime() >= requiredCoverage,
      "RECOURSE_WINDOW_TOO_SHORT",
      "Recourse validity must cover permit expiry and the remedy window.",
    );
    if (record.proposal.parameters?.amount_minor !== undefined) {
      assert(
        input.max_amount_minor >= record.proposal.parameters.amount_minor,
        "RECOURSE_INVALID",
        "Recourse amount does not cover the proposed action.",
      );
    }
    return deepClone(input);
  }

  validateConnectorCommitment(record, request, commitment) {
    assertExactFields(
      commitment,
      CONNECTOR_COMMITMENT_FIELDS,
      "ConnectorRecourseCommitment",
      "RECOURSE_COMMITMENT_INVALID",
    );
    assert(
      commitment.schema_version ===
        "consequence-rail/connector-recourse-commitment/v0.1",
      "RECOURSE_COMMITMENT_INVALID",
      "Connector returned an unsupported recourse commitment.",
    );
    assert(
      commitment.status === "active" &&
        typeof commitment.reservation_token === "string" &&
        commitment.reservation_token.length > 0,
      "RECOURSE_COMMITMENT_INVALID",
      "Connector did not return an active reservation token.",
    );
    for (const field of [
      "action_digest",
      "connector",
      "capability",
      "kind",
      "expires_at",
      "max_attempts",
      "max_amount_minor",
    ]) {
      assert(
        commitment[field] === request[field],
        "RECOURSE_COMMITMENT_INVALID",
        `Connector commitment does not match requested ${field}.`,
      );
    }
    assert(
      commitment.action_digest === record.action_digest,
      "RECOURSE_COMMITMENT_INVALID",
      "Connector commitment is bound to a different action.",
    );
    assertTimestamp(
      commitment.expires_at,
      "ConnectorRecourseCommitment.expires_at",
      "RECOURSE_COMMITMENT_INVALID",
    );
    assertTimestamp(
      commitment.reserved_at,
      "ConnectorRecourseCommitment.reserved_at",
      "RECOURSE_COMMITMENT_INVALID",
    );
  }

  validateEvidence(record, input) {
    assertExactFields(
      input,
      EVIDENCE_FIELDS,
      "OutcomeEvidence",
      "EVIDENCE_SCHEMA_INVALID",
    );
    assert(
      input?.schema_version === "consequence-rail/outcome-evidence/v0.1",
      "EVIDENCE_SCHEMA_INVALID",
      "Unsupported evidence schema.",
    );
    assertDigest(
      input.action_digest,
      "OutcomeEvidence.action_digest",
      "EVIDENCE_SCHEMA_INVALID",
    );
    assertExactFields(
      input.resource,
      EVIDENCE_RESOURCE_FIELDS,
      "OutcomeEvidence.resource",
      "EVIDENCE_SCHEMA_INVALID",
    );
    assert(
      input.action_digest === record.action_digest,
      "EVIDENCE_ACTION_MISMATCH",
      "Evidence is bound to a different action.",
    );
    assert(
      input.source === record.proposal.evidence_plan.source,
      "EVIDENCE_SOURCE_UNTRUSTED",
      "Evidence source is not declared by the action.",
    );
    assert(
      input.resource?.type === record.proposal.target.resource_type &&
        input.resource?.id === record.proposal.target.resource_id,
      "EVIDENCE_RESOURCE_MISMATCH",
      "Evidence describes a different resource.",
    );
    assertPlainObject(input.facts, "OutcomeEvidence.facts", "EVIDENCE_SCHEMA_INVALID");
    digest(input.facts);
    const observedAt = assertTimestamp(
      input.observed_at,
      "OutcomeEvidence.observed_at",
      "EVIDENCE_SCHEMA_INVALID",
    );
    const age = new Date(this.clock.now()).getTime() - observedAt;
    assert(age >= 0, "EVIDENCE_FROM_FUTURE", "Evidence timestamp is in the future.");
    assert(
      age <= record.proposal.evidence_plan.max_age_seconds * 1_000,
      "EVIDENCE_STALE",
      "Evidence is older than the configured freshness window.",
    );
    return deepClone(input);
  }

  assertState(record, expected) {
    assert(record.state === expected, "ILLEGAL_TRANSITION", `Action must be in ${expected}.`, {
      action_id: record.action_id,
      state: record.state,
    });
  }

  assertNotExpired(expiry, record, code) {
    if (isExpired(expiry, this.clock.now())) {
      if ((ALLOWED_TRANSITIONS[record.state] ?? []).includes("EXPIRED")) {
        this.transition(record, "EXPIRED", code, {});
        this.finalizeRecourse(record, {
          release: true,
          reason: code,
        });
      }
      throw new RailError(code, "The required authorization artifact has expired.", {
        action_id: record.action_id,
        state: record.state,
      });
    }
  }
}
