import { deepClone, deepFreeze, digest } from "./canonical.js";
import { isExpired } from "./clock.js";
import { MemoryEventStore } from "./event-store.js";
import { RailError, UnknownExecutionError, UnknownRemedyError } from "./errors.js";
import { evaluatePostcondition } from "./postconditions.js";
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

function assert(condition, code, message, details = {}) {
  if (!condition) {
    throw new RailError(code, message, details);
  }
}

function assertNoUnknownFields(object, allowed, objectName) {
  const unknown = Object.keys(object).filter((key) => !allowed.has(key));
  assert(unknown.length === 0, "SCHEMA_INVALID", `${objectName} contains unknown fields.`, {
    fields: unknown,
  });
}

export class ConsequenceRail {
  constructor({ signer, clock, connector, connectorTrustedKeys, eventStore } = {}) {
    assert(signer && clock && connector, "CONFIG_INVALID", "Signer, clock and connector are required.");
    this.signer = signer;
    this.clock = clock;
    this.connector = connector;
    this.connectorTrustedKeys = connectorTrustedKeys ?? new Map();
    this.eventStore = eventStore ?? new MemoryEventStore(signer, clock);
    this.actions = new Map();
    this.trustedKeys = new Map([[signer.kid, signer.publicKey]]);
  }

  propose(input) {
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
    assert(typeof decision?.allow === "boolean", "SCHEMA_INVALID", "Authorization requires allow.");
    assert(typeof decision?.policy_id === "string", "SCHEMA_INVALID", "Authorization requires policy_id.");
    assert(
      typeof decision?.policy_digest === "string",
      "SCHEMA_INVALID",
      "Authorization requires policy_digest.",
    );

    record.authorization = deepFreeze(deepClone({
      allow: decision.allow,
      policy_id: decision.policy_id,
      policy_digest: decision.policy_digest,
      evaluation_input_digest: decision.evaluation_input_digest ?? null,
      decided_at: this.clock.now(),
    }));
    this.transition(record, decision.allow ? "AUTHORIZED" : "DENIED", decision.allow ? "POLICY_ALLOWED" : "POLICY_DENIED", {
      policy_id: decision.policy_id,
      policy_digest: decision.policy_digest,
    });
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

    const capabilities = this.connector.capabilities();
    if (record.proposal.assurance_mode === "enforced") {
      assert(
        capabilities.exclusive_credential_custody === true,
        "ASSURANCE_UNSUPPORTED",
        "Enforced mode requires rail-exclusive downstream credential custody.",
      );
    }
    const recourseStatus = this.connector.recourseStatus(
      record.reservation.connector_commitment.reservation_token,
    );
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
    });
    return this.inspect(actionId);
  }

  async execute(actionId, { fault = "none", proposalOverride } = {}) {
    const record = this.get(actionId);
    assert(record.permit_uses === 0, "PERMIT_USED", "The single-use permit has already been consumed.", {
      action_id: actionId,
      state: record.state,
    });
    this.assertState(record, "PERMITTED");
    this.assertNotExpired(record.permit.expires_at, record, "PERMIT_EXPIRED");
    this.assertNotExpired(record.reservation.expires_at, record, "RECOURSE_EXPIRED");
    verifyArtifact(record.permit, this.trustedKeys);

    const candidate = proposalOverride ?? record.proposal;
    assert(
      digest(candidate) === record.action_digest,
      "DIGEST_MISMATCH",
      "The execution payload does not match the authorized action digest.",
      { action_id: actionId, state: record.state },
    );
    const recourseStatus = this.connector.recourseStatus(
      record.reservation.connector_commitment.reservation_token,
    );
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
      record.execution = await this.connector.execute(
        record.proposal,
        record.proposal.idempotency_key,
        fault,
      );
      this.transition(record, "EXECUTED", "CONNECTOR_EXECUTED", {
        external_reference_digest: digest(record.execution.external_id ?? record.execution.idempotency_key),
      });
    } catch (error) {
      if (error instanceof UnknownExecutionError) {
        record.execution = {
          status: "unknown",
          idempotency_key: record.proposal.idempotency_key,
          external_id: error.details.external_id ?? null,
        };
        this.transition(record, "UNKNOWN", "EXECUTION_AMBIGUOUS", {
          idempotency_key_digest: digest(record.proposal.idempotency_key),
        });
      } else {
        record.execution = {
          status: "failed",
          code: error.code ?? "CONNECTOR_FAILED",
        };
        this.transition(record, "FAILED", "CONNECTOR_FAILED", {
          code: record.execution.code,
        });
        this.finalizeRecourse(record, {
          release: true,
          reason: "EXECUTION_FAILED_WITHOUT_EFFECT",
        });
      }
    }

    return this.inspect(actionId);
  }

  async reconcile(actionId) {
    const record = this.get(actionId);
    this.assertState(record, "UNKNOWN");
    const status = await this.connector.status(record.proposal.idempotency_key);
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

  async verifyOutcome(actionId, { fault = "none", evidenceOverride } = {}) {
    const record = this.get(actionId);
    this.assertState(record, "EXECUTED");
    this.transition(record, "VERIFYING", "OUTCOME_VERIFICATION_STARTED", {});

    let evidence = evidenceOverride ?? await this.connector.observe(record.proposal, {
      fault,
      actionDigest: record.action_digest,
    });

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
      throw error;
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

  async remediate(actionId, { fault = "none" } = {}) {
    const record = this.get(actionId);
    this.assertState(record, "REMEDY_DUE");
    if (isExpired(record.reservation.expires_at, this.clock.now())) {
      this.transition(record, "REVIEW_REQUIRED", "RECOURSE_EXPIRED", {});
      this.close(record);
      return this.inspect(actionId);
    }
    const recourseStatus = this.connector.recourseStatus(
      record.reservation.connector_commitment.reservation_token,
    );
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
      record.remedy_result = await this.connector.remediate(
        record.proposal,
        record.reservation,
        record.remedy_idempotency_key,
        fault,
      );
    } catch (error) {
      if (error instanceof UnknownRemedyError) {
        record.remedy_result = {
          status: "unknown",
          idempotency_key: record.remedy_idempotency_key,
          external_id: error.details.external_id ?? null,
        };
        this.transition(record, "REMEDY_UNKNOWN", "REMEDY_EXECUTION_AMBIGUOUS", {
          idempotency_key_digest: record.reservation.idempotency_key_digest,
        });
        return this.inspect(actionId);
      }
      this.transition(record, "REMEDY_FAILED", "REMEDY_CONNECTOR_FAILED", {
        code: error.code ?? "REMEDY_CONNECTOR_FAILED",
      });
      this.close(record);
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

  async reconcileRemedy(actionId, { evidenceFault = "none" } = {}) {
    const record = this.get(actionId);
    this.assertState(record, "REMEDY_UNKNOWN");
    const status = await this.connector.remedyStatus(record.remedy_idempotency_key);
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
      evidence = this.validateEvidence(
        record,
        await this.connector.observe(record.proposal, {
          actionDigest: record.action_digest,
          fault,
        }),
      );
    } catch (error) {
      if (error instanceof RailError && error.code.startsWith("EVIDENCE_")) {
        this.eventStore.append(record.action_id, "REMEDY_EVIDENCE_REJECTED", "rail", {
          code: error.code,
        });
        this.transition(record, "REMEDY_INCONCLUSIVE", error.code, {});
        this.close(record);
        return;
      }
      throw error;
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
    };
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
    return {
      schema_version: "consequence-rail/settlement-bundle/v0.1",
      profile: auditProfile ? "audit" : "receipt",
      action: {
        action_id: actionId,
        action_digest: record.action_digest,
        action_type: record.proposal.action_type,
        resource_id_digest: digest(record.proposal.target.resource_id),
        ...(auditProfile ? { proposal: deepClone(record.proposal) } : {}),
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
    };
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
    const status = this.connector.recourseStatus(reservationToken);
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
    assert(input && typeof input === "object", "SCHEMA_INVALID", "ActionProposal must be an object.");
    assertNoUnknownFields(input, PROPOSAL_FIELDS, "ActionProposal");
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
    assert(input.subject?.id && input.subject?.type, "SCHEMA_INVALID", "Subject type and id are required.");
    assert(
      input.target?.connector && input.target?.resource_type && input.target?.resource_id,
      "SCHEMA_INVALID",
      "Target connector and resource are required.",
    );
    assert(typeof input.idempotency_key === "string", "SCHEMA_INVALID", "idempotency_key is required.");
    assert(ASSURANCE_MODES.includes(input.assurance_mode), "SCHEMA_INVALID", "Unknown assurance mode.");
    assert(
      new Date(input.expires_at).getTime() > new Date(input.requested_at).getTime(),
      "SCHEMA_INVALID",
      "expires_at must be after requested_at.",
    );
    assert(input.evidence_plan?.source, "SCHEMA_INVALID", "An evidence source is required.");
    assert(
      Number.isInteger(input.evidence_plan?.max_age_seconds) &&
        input.evidence_plan.max_age_seconds > 0,
      "SCHEMA_INVALID",
      "A positive evidence max age is required.",
    );
    evaluatePostcondition(input.postcondition, { facts: {} });

    if (input.action_type === "demo.refund.issue/v1") {
      assert(
        Number.isSafeInteger(input.parameters?.amount_minor) && input.parameters.amount_minor > 0,
        "SCHEMA_INVALID",
        "Refund amount_minor must be a positive integer.",
      );
      assert(
        /^[A-Z]{3}$/.test(input.parameters?.currency ?? ""),
        "SCHEMA_INVALID",
        "Refund currency must be a three-letter uppercase code.",
      );
    }

    return deepClone(input);
  }

  validateReservation(record, input) {
    assert(input && typeof input === "object", "RECOURSE_INVALID", "RecourseReservation is required.");
    assertNoUnknownFields(input, RECOURSE_INPUT_FIELDS, "RecourseReservation request");
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
    const capabilities = this.connector.capabilities();
    assert(
      capabilities.remedies.includes(input.capability),
      "RECOURSE_INVALID",
      "Connector does not advertise the reserved remedy capability.",
    );
    assert(
      Number.isInteger(input.max_attempts) && input.max_attempts > 0,
      "RECOURSE_INVALID",
      "Recourse max_attempts must be a positive integer.",
    );
    assert(
      typeof input.capability_reference === "string" &&
        input.capability_reference.length > 0,
      "RECOURSE_INVALID",
      "Recourse capability_reference is required.",
    );
    assert(
      Number.isInteger(input.remedy_window_seconds) &&
        input.remedy_window_seconds >= 0,
      "RECOURSE_INVALID",
      "Recourse remedy_window_seconds must be a non-negative integer.",
    );
    assert(
      Number.isSafeInteger(input.max_amount_minor) &&
        input.max_amount_minor >= 0,
      "RECOURSE_INVALID",
      "Recourse max_amount_minor must be a non-negative integer.",
    );
    assert(
      typeof input.idempotency_key === "string" && input.idempotency_key.length > 0,
      "RECOURSE_INVALID",
      "Recourse idempotency key is required.",
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
    assert(
      commitment.schema_version ===
        "consequence-rail/connector-recourse-commitment/v0.1",
      "RECOURSE_COMMITMENT_INVALID",
      "Connector returned an unsupported recourse commitment.",
    );
    assert(
      commitment.status === "active" &&
        typeof commitment.reservation_token === "string",
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
  }

  validateEvidence(record, input) {
    assert(
      input?.schema_version === "consequence-rail/outcome-evidence/v0.1",
      "EVIDENCE_SCHEMA_INVALID",
      "Unsupported evidence schema.",
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
    const age =
      new Date(this.clock.now()).getTime() - new Date(input.observed_at).getTime();
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
