// ConsequenceRail orchestrator. The main in-memory state machine that wires
// schemas, validators, and the event store into a single coordinated API.
// Constants and pure helpers live in src/rail-schema.js and src/rail-state.js.

import { deepClone, deepFreeze, digest } from "./canonical.js";
import { isExpired } from "./clock.js";
import {
  ActionClassRegistry,
  unmetBindings,
  validateClassParameters,
  validateProposalDeclarations,
} from "./action-classes.js";
import { isSignedAuthorizationDecision, verifyAuthorizationDecision } from "./authorization.js";
import { verifySimulationResult } from "./simulation.js";
import { MemoryEventStore } from "./event-store.js";
import { RailError } from "./errors.js";
import { divergentPostconditionPaths, evaluatePostcondition, missingPostconditionPaths } from "./postconditions.js";
import { verifyRecoveryPreflight } from "./recovery-preflight.js";
import { normalizeSigner, signArtifact, verifyArtifact } from "./signing.js";
import {
  assert,
  assertConnectorResult,
  assertDigest,
  assertExactFields,
  assertNoUnknownFields,
  assertNonEmptyString,
  assertPlainObject,
  assertRequiredFields,
  assertSafeInteger,
  assertTimestamp,
  RECEIPT_RECOURSE_STATUSES,
  OPEN_PROPOSAL_VERSION,
  proposalScopeField,
  proposalAdmitsActionType,
  MAX_DURATION_SECONDS,
  AUTHORIZATION_FIELDS,
  CONNECTOR_CAPABILITY_FIELDS,
  CONNECTOR_COMMITMENT_FIELDS,
  CONNECTOR_RESULT_FIELDS,
  EVIDENCE_FAULTS,
  EVIDENCE_FIELDS,
  EVIDENCE_PLAN_FIELDS,
  EVIDENCE_RESOURCE_FIELDS,
  EXECUTION_FAULTS,
  EXECUTION_RESULTS,
  EXECUTION_STATUSES,
  INVENTORY_CONNECTOR_COMMITMENT_FIELDS,
  INVENTORY_PARAMETER_FIELDS,
  INVENTORY_RECOURSE_INPUT_FIELDS,
  PROPOSAL_FIELDS,
  PROPOSAL_V3_FIELDS,
  PROPOSAL_V3_OPTIONAL_FIELDS,
  PLAN_REFERENCE_FIELDS,
  PLAN_ID_PATTERN,
  MAX_PLAN_STEPS,
  EVIDENCE_PLAN_V3_FIELDS,
  RECOURSE_SCOPE_FIELDS,
  RECOURSE_INPUT_FIELDS,
  RECOURSE_STATUS_FIELDS,
  REFUND_PARAMETER_FIELDS,
  REMEDIATION_FAULTS,
  REMEDY_EVIDENCE_FAULTS,
  REMEDY_RESULTS,
  REMEDY_STATUSES,
  EMAIL_PARAMETER_FIELDS,
  SUBJECT_FIELDS,
  TARGET_FIELDS,
} from "./rail-schema.js";
import {
  ACTION_PROPOSAL_VERSIONS,
  ALLOWED_TRANSITIONS,
  ASSURANCE_MODES,
  BUNDLE_VERSION_BY_PROPOSAL,
  MAX_ACTIONS,
  RECEIPT_OUTCOME_BY_STATE,
  RECEIPT_VERSION_BY_PROPOSAL,
} from "./rail-state.js";

function isIdempotencyConflict(error) {
  // A revoked proxy throws from instanceof. That is an untyped connector
  // failure, not a conflict, and must stay on the ambiguous-result path.
  try {
    return error instanceof RailError && error.code === "IDEMPOTENCY_CONFLICT";
  } catch {
    return false;
  }
}

function isDefiniteExecutionRefusal(error) {
  // These codes are raised before the connector records an effect. A lost
  // response stays UnknownExecutionError and remains ambiguous.
  try {
    return error instanceof RailError &&
      (error.code === "IDEMPOTENCY_CONFLICT" || error.code === "INVENTORY_INSUFFICIENT");
  } catch {
    return false;
  }
}

export class ConsequenceRail {
  constructor({
    signer,
    clock,
    connector,
    connectorTrustedKeys,
    recoveryTrustedKeys,
    authorizerTrustedKeys,
    requireSignedAuthorization = false,
    actionClasses,
    requireSimulation = false,
    requireRecoveryPreflight = false,
    measureRecoveryImplementation = null,
    maxActions = MAX_ACTIONS,
    eventStore,
  } = {}) {
    assert(signer && clock && connector, "CONFIG_INVALID", "Signer, clock and connector are required.");
    // Check the whole signer contract now. A signer without publicKeyPem used
    // to close an action and then fail at export; a mismatched public half
    // failed only at execute, after a reservation and permit existed.
    signer = normalizeSigner(signer, "CONFIG_INVALID");
    assert(
      typeof requireSignedAuthorization === "boolean",
      "CONFIG_INVALID",
      "requireSignedAuthorization must be boolean.",
    );
    assert(
      authorizerTrustedKeys === undefined || authorizerTrustedKeys instanceof Map,
      "CONFIG_INVALID",
      "authorizerTrustedKeys must be a Map when supplied.",
    );
    assert(
      !requireSignedAuthorization || authorizerTrustedKeys?.size > 0,
      "CONFIG_INVALID",
      "requireSignedAuthorization needs at least one trusted authorizer key.",
    );
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
    // Copied so a caller changing its own map later cannot change the trust.
    this.authorizerTrustedKeys = new Map(authorizerTrustedKeys ?? []);
    this.requireSignedAuthorization = requireSignedAuthorization;
    // Registered action classes admit ActionProposal v0.3. An array of class
    // definitions is copied into a registry this rail owns.
    assert(
      actionClasses === undefined ||
        actionClasses instanceof ActionClassRegistry ||
        Array.isArray(actionClasses),
      "CONFIG_INVALID",
      "actionClasses must be an ActionClassRegistry or an array of class definitions.",
    );
    this.actionClasses = actionClasses instanceof ActionClassRegistry
      ? new ActionClassRegistry(actionClasses.list())
      : new ActionClassRegistry(actionClasses ?? []);
    this.requireRecoveryPreflight = requireRecoveryPreflight;
    // With requireSimulation, a v0.3 action needs an accepted connector dry
    // run that predicts its postcondition before a permit is issued.
    this.requireSimulation = requireSimulation === true;
    // Plans group v0.3 actions into ordered steps with one kill switch.
    this.plans = new Map();
    this.measureRecoveryImplementation = measureRecoveryImplementation;
    this.maxActions = maxActions;
    const configuredEventStore = eventStore ?? new MemoryEventStore(signer, clock);
    // Contract: append returns after exactly one event is visible, or throws
    // without changing the event list. Durable stores must enforce this atomically.
    assert(
      configuredEventStore?.failureAtomicAppend === true &&
        typeof configuredEventStore.append === "function" &&
        typeof configuredEventStore.list === "function",
      "CONFIG_INVALID",
      "The event store must provide failure-atomic append and list operations.",
    );
    const eventStoreFacade = Object.freeze({
      failureAtomicAppend: true,
      append: configuredEventStore.append.bind(configuredEventStore),
      list: configuredEventStore.list.bind(configuredEventStore),
    });
    Object.defineProperty(this, "eventStore", {
      value: eventStoreFacade,
      enumerable: true,
    });
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
    const plan = proposal.plan ? this.getPlan(proposal.plan.plan_id) : null;
    if (plan) {
      this.assertPlanOpen(plan);
      assert(
        proposal.plan.step === plan.steps.length + 1,
        "PLAN_STEP_INVALID",
        `The next step of ${plan.plan_id} is ${plan.steps.length + 1}.`,
      );
    }

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
    // Append the event first; only commit the in-memory record if the
    // append succeeds. This keeps the event log and the action map in
    // sync when a failure-atomic event store throws on append.
    this.eventStore.append(actionId, "ACTION_PROPOSED", "rail", {
      state: "PROPOSED",
      action_digest: actionDigest,
      action_type: proposal.action_type,
      assurance_mode: proposal.assurance_mode,
    });
    this.actions.set(actionId, record);
    if (plan) {
      plan.steps.push(actionId);
      this.eventStore.append(plan.plan_id, "PLAN_STEP_ADDED", "rail", {
        step: proposal.plan.step,
        action_id: actionId,
        action_digest: actionDigest,
      });
    }
    return this.inspect(actionId);
  }

  authorize(actionId, decision) {
    const record = this.get(actionId);
    this.assertPlanAllows(record);
    this.assertState(record, "PROPOSED");
    if (isSignedAuthorizationDecision(decision)) {
      return this.authorizeSigned(record, decision);
    }
    // The unsigned form records a caller's claim. Whoever can call the rail
    // can make it, including the proposer, so a rail that must separate the
    // two refuses it.
    assert(
      !this.requireSignedAuthorization,
      "AUTHORIZATION_SIGNATURE_REQUIRED",
      "This rail accepts only a signed AuthorizationDecision from a trusted authorizer.",
      { action_id: actionId },
    );
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

    const authorization = deepFreeze(deepClone({
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
    record.authorization = authorization;
    return this.inspect(actionId);
  }

  authorizeSigned(record, decision) {
    // Verify everything before the first append: a refused decision leaves
    // the action PROPOSED with no new event.
    const verified = verifyAuthorizationDecision(decision, {
      trustedKeys: this.authorizerTrustedKeys,
      actionDigest: record.action_digest,
      now: this.clock.now(),
    });
    const signed = verified.decision;
    const authorization = deepFreeze(deepClone({
      allow: signed.allow,
      policy_id: signed.policy_id,
      policy_digest: signed.policy_digest,
      evaluation_input_digest: signed.evaluation_input_digest,
      evaluation_digest: signed.evaluation_digest,
      require_recovery_preflight:
        this.requireRecoveryPreflight || signed.require_recovery_preflight,
      decided_at: signed.decided_at,
      decision_digest: verified.decision_digest,
      authorizer_key_id: verified.key_id,
    }));
    this.eventStore.append(record.action_id, "AUTHORIZATION_DECISION_ACCEPTED", "authorizer", {
      decision_digest: verified.decision_digest,
      decision_id: signed.decision_id,
      authorizer_key_id: verified.key_id,
      allow: signed.allow,
      policy_id: signed.policy_id,
      policy_digest: signed.policy_digest,
    });
    this.transition(
      record,
      signed.allow ? "AUTHORIZED" : "DENIED",
      signed.allow ? "POLICY_ALLOWED" : "POLICY_DENIED",
      {
        policy_id: signed.policy_id,
        policy_digest: signed.policy_digest,
        decision_digest: verified.decision_digest,
      },
    );
    record.authorization = authorization;
    record.authorization_decision = deepFreeze(signed);
    return this.inspect(record.action_id);
  }

  acceptRecoveryQualification(actionId, bundle) {
    const record = this.get(actionId);
    this.assertState(record, "RECOURSE_RESERVED");
    // Prepare the exact evidence we will retain before recording acceptance.
    // No input validation or caller-owned object reads may fail after append.
    bundle = deepFreeze(deepClone(bundle));
    const verification = deepFreeze(verifyRecoveryPreflight(bundle, {
      trustedKeys: this.recoveryTrustedKeys,
      now: this.clock.now(),
      requireCurrent: true,
    }));
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

    // Append the event first; only mutate the record after the event is
    // durable. A failing event append would otherwise leave the record
    // with recovery_preflight fields but no RECOVERY_PREFLIGHT_ACCEPTED
    // event, breaking the audit profile.
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
    record.recovery_preflight = bundle;
    record.recovery_preflight_verification = verification;
    return this.inspect(actionId);
  }

  reserveRecourse(actionId, input) {
    const record = this.get(actionId);
    this.assertPlanAllows(record);
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
      ...(proposalScopeField(record.proposal) === "max_quantity"
        ? { max_quantity: request.max_quantity }
        : { max_amount_minor: request.max_amount_minor }),
      idempotency_key_digest: digest(request.idempotency_key),
      connector_commitment: connectorCommitment,
    };
    const signedReservation = signArtifact({
      ...reservation,
      schema_version: "consequence-rail/recourse-reservation/v0.1",
      reservation_id: `rr_${digest(reservation).slice(0, 20)}`,
      reserved_at: this.clock.now(),
    }, this.signer);
    const reservationDigest = digest(signedReservation);
    // Commit the state transition (which appends the event) first; only
    // mutate record.* after the event is durable. A failing event append
    // would otherwise leave the record with reservation fields but no
    // STATE_TRANSITION event, breaking the audit profile.
    this.transition(record, "RECOURSE_RESERVED", "RECOURSE_VERIFIED", {
      reservation_digest: reservationDigest,
      remedy_kind: reservation.kind,
      capability: reservation.capability,
      connector_commitment_digest: digest(connectorCommitment),
    });
    record.remedy_idempotency_key = request.idempotency_key;
    record.reservation = signedReservation;
    record.reservation_digest = reservationDigest;
    return this.inspect(actionId);
  }

  issuePermit(actionId) {
    const record = this.get(actionId);
    this.assertPlanAllows(record);
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

    if (record.proposal.schema_version === OPEN_PROPOSAL_VERSION && this.requireSimulation) {
      assert(record.simulation, "SIMULATION_REQUIRED", "An accepted dry run of this action is required before permit issuance.");
    }
    if (record.simulation) {
      assert(
        record.simulation_predicted_satisfied,
        "SIMULATION_PREDICTS_BREACH",
        "The connector's dry run predicts that the postcondition would not hold.",
        { simulation_digest: record.simulation_digest },
      );
      assert(
        new Date(this.clock.now()).getTime() - Date.parse(record.simulation.simulated_at) <=
          record.proposal.evidence_plan.max_age_seconds * 1_000,
        "SIMULATION_STALE",
        "The accepted dry run is older than the evidence freshness window.",
      );
    }

    const permitBody = {
      schema_version: record.simulation ? "consequence-rail/action-permit/v0.2" : "consequence-rail/action-permit/v0.1",
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
      ...(record.simulation ? { simulation_digest: record.simulation_digest } : {}),
    };
    const signedPermit = signArtifact(permitBody, this.signer);
    const permitDigest = digest(signedPermit);
    // Commit the state transition (which appends the event) first; only
    // mutate record.* after the event is durable. A failing event append
    // would otherwise leave record.permit and record.permit_digest set
    // without a STATE_TRANSITION event, breaking the audit profile.
    this.transition(record, "PERMITTED", "PERMIT_ISSUED", {
      permit_digest: permitDigest,
      assurance_mode: record.proposal.assurance_mode,
      bypass_possible: signedPermit.bypass_possible,
      ...(record.simulation ? { simulation_digest: record.simulation_digest } : {}),
      ...(record.authorization.require_recovery_preflight
        ? {
            recovery_preflight_attestation_digest:
              record.recovery_preflight_verification.attestation_digest,
          }
        : {}),
    });
    record.permit = signedPermit;
    record.permit_digest = permitDigest;
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
    this.assertPlanAllows(record);
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
    const useNumber = record.permit_uses + 1;
    this.transition(record, "EXECUTING", "PERMIT_CONSUMED", {
      permit_digest: record.permit_digest,
      use_number: useNumber,
    });
    record.permit_uses = useNumber;

    try {
      const execution = assertConnectorResult(
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
        external_reference_digest: digest(execution.external_id ?? execution.idempotency_key),
      });
      record.execution = execution;
    } catch (error) {
      if (isDefiniteExecutionRefusal(error)) {
        this.transition(record, "FAILED", error.code, {
          idempotency_key_digest: digest(record.proposal.idempotency_key),
        });
        this.finalizeRecourse(record, {
          release: true,
          reason: error.code,
        });
        throw error;
      }
      const execution = {
        status: "unknown",
        idempotency_key: record.proposal.idempotency_key,
        external_id: null,
      };
      this.transition(record, "UNKNOWN", "EXECUTION_AMBIGUOUS", {
        idempotency_key_digest: digest(record.proposal.idempotency_key),
      });
      record.execution = execution;
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
    if (status.status === "executed") {
      this.transition(record, "EXECUTED", "STATUS_CONFIRMED_EXECUTED", {
        external_reference_digest: digest(status.external_id ?? status.idempotency_key),
      });
      record.execution = status;
    } else if (status.status === "no_effect") {
      this.transition(record, "FAILED", "STATUS_CONFIRMED_NO_EFFECT", {
        idempotency_key_digest: digest(status.idempotency_key),
      });
      this.finalizeRecourse(record, {
        release: true,
        reason: "STATUS_CONFIRMED_NO_EFFECT",
      });
      record.execution = status;
    } else {
      this.transition(record, "REVIEW_REQUIRED", "STATUS_UNRESOLVED", {});
      this.close(record);
      record.execution = status;
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

    let accepted;
    let evaluation;
    let acceptedDigest;
    try {
      evidence = this.validateEvidence(record, evidence);
      ({ accepted, evaluation, acceptedDigest } = this.acceptEvidence(record, evidence));
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

    this.eventStore.append(actionId, "EVIDENCE_ACCEPTED", "rail", {
      evidence_digest: acceptedDigest,
      source: accepted.source,
      satisfied: evaluation.satisfied,
    });
    record.evidence.push(accepted);
    if (record.simulation) {
      this.eventStore.append(actionId, "SIMULATION_COMPARED", "rail", {
        simulation_digest: record.simulation_digest,
        evidence_digest: acceptedDigest,
        diverged_paths: divergentPostconditionPaths(
          record.proposal.postcondition,
          record.simulation.predicted_facts,
          accepted.facts,
        ),
      });
    }

    if (evaluation.satisfied) {
      this.transition(record, "SATISFIED", "POSTCONDITION_SATISFIED", {
        evidence_digest: acceptedDigest,
      });
      if (!this.holdForPlan(record)) this.close(record);
    } else {
      this.transition(record, "BREACHED", "POSTCONDITION_BREACHED", {
        evidence_digest: acceptedDigest,
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
    assert(
      record.state === "REMEDY_DUE" || record.state === "UNWIND_DUE",
      "ILLEGAL_TRANSITION",
      `Action is in ${record.state}, not REMEDY_DUE or UNWIND_DUE.`,
      { action_id: actionId, state: record.state },
    );
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
    if (record.reservation.kind !== "reverse" && record.reservation.kind !== "compensate") {
      // An escalate reservation never starts an automatic remedy. The breach
      // goes to review now, and the operator handles it as a child action
      // against the recourse that stays reserved.
      this.transition(record, "REVIEW_REQUIRED", "REMEDY_REQUIRES_CHILD_ACTION", {
        kind: record.reservation.kind,
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

    const attempt = record.remedy_attempts + 1;
    this.transition(record, "REMEDIATING", "REMEDY_STARTED", {
      attempt,
      reservation_digest: record.reservation_digest,
    });
    record.remedy_attempts = attempt;
    try {
      const remedyResult = assertConnectorResult(
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
      record.remedy_result = remedyResult;
    } catch (error) {
      if (isIdempotencyConflict(error)) {
        this.transition(record, "REMEDY_FAILED", "IDEMPOTENCY_CONFLICT", {
          idempotency_key_digest: record.reservation.idempotency_key_digest,
        });
        this.close(record);
        throw error;
      }
      const remedyResult = {
        status: "unknown",
        idempotency_key: record.remedy_idempotency_key,
        external_id: null,
      };
      this.transition(record, "REMEDY_UNKNOWN", "REMEDY_EXECUTION_AMBIGUOUS", {
        idempotency_key_digest: record.reservation.idempotency_key_digest,
      });
      record.remedy_result = remedyResult;
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
      "Remediation evidence fault is not supported.",
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
    if (status.status === "remediated") {
      this.transition(record, "REMEDY_VERIFYING", "REMEDY_STATUS_CONFIRMED", {
        result_digest: digest(status),
      });
      record.remedy_result = status;
      await this.verifyRemedyOutcome(record, { fault: evidenceFault });
    } else if (status.status === "no_effect" || status.status === "failed") {
      this.transition(record, "REMEDY_FAILED", "REMEDY_STATUS_CONFIRMED_NO_EFFECT", {
        result: status.status,
      });
      this.close(record);
      record.remedy_result = status;
    } else {
      this.transition(record, "REVIEW_REQUIRED", "REMEDY_STATUS_UNRESOLVED", {
        idempotency_key_digest: record.reservation.idempotency_key_digest,
      });
      this.close(record);
      record.remedy_result = status;
    }
    return this.inspect(actionId);
  }

  async verifyRemedyOutcome(record, { fault = "none" } = {}) {
    this.assertState(record, "REMEDY_VERIFYING");
    let accepted;
    let evaluation;
    let acceptedDigest;
    try {
      const observed = await this.connector.observe(record.proposal, {
        actionDigest: record.action_digest,
        fault,
      });
      const evidence = this.validateEvidence(record, observed);
      ({ accepted, evaluation, acceptedDigest } = this.acceptEvidence(
        record,
        evidence,
        record.unwinding ? "post-unwind" : "post-remedy",
      ));
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

    this.eventStore.append(record.action_id, "REMEDY_EVIDENCE_ACCEPTED", "rail", {
      evidence_digest: acceptedDigest,
      satisfied: evaluation.satisfied,
    });
    record.evidence.push(accepted);

    if (evaluation.satisfied) {
      this.transition(record, "REMEDIATED", "REMEDY_VERIFIED", {
        evidence_digest: acceptedDigest,
      });
    } else {
      this.transition(record, "REMEDY_INCONCLUSIVE", "REMEDY_POSTCONDITION_UNRESOLVED", {
        evidence_digest: acceptedDigest,
      });
    }
    this.close(record);
  }

  // Evaluate validated evidence and sign the accepted artifact. Both steps
  // run inside the caller's guarded block, so evidence that cannot be
  // represented once evaluated (for example a fact subtree that exceeds the
  // canonical JSON limits when copied into the evaluation) is rejected
  // through the normal fail-closed path instead of stranding the action.
  acceptEvidence(record, evidence, phase = null) {
    const evaluation = evaluatePostcondition(this.activePostcondition(record), evidence);
    try {
      const accepted = signArtifact({
        ...evidence,
        evaluation,
        captured_by: "consequence-rail",
        ...(phase ? { phase } : {}),
      }, this.signer);
      return { accepted, evaluation, acceptedDigest: digest(accepted) };
    } catch (error) {
      if (error instanceof RailError && error.code === "CANONICALIZATION_FAILED") {
        throw new RailError(
          "EVIDENCE_UNREPRESENTABLE",
          "Evaluated evidence exceeds the canonical JSON limits.",
        );
      }
      throw error;
    }
  }

  /**
   * Ask the connector for a signed dry run of the exact reserved action and
   * accept it if it is fresh, bound to this action and complete. The result
   * is bound into the permit; a predicted breach blocks the permit.
   */
  async simulate(actionId) {
    const record = this.get(actionId);
    this.assertPlanAllows(record);
    this.assertState(record, "RECOURSE_RESERVED");
    assert(
      record.proposal.schema_version === OPEN_PROPOSAL_VERSION,
      "SIMULATION_UNSUPPORTED",
      "Simulation evidence binds into ActionPermit v0.2, which only ActionProposal v0.3 uses.",
    );
    assert(
      typeof this.connector.simulate === "function",
      "SIMULATION_UNSUPPORTED",
      "The connector does not offer a dry run.",
    );
    const result = await this.connector.simulate(deepClone(record.proposal), { actionDigest: record.action_digest });
    const checked = verifySimulationResult(result, {
      proposal: record.proposal,
      actionDigest: record.action_digest,
      trustedKeys: this.connectorTrustedKeys,
      now: this.clock.now(),
    });
    this.eventStore.append(actionId, "SIMULATION_ACCEPTED", "rail", {
      simulation_digest: checked.simulation_digest,
      predicted_satisfied: checked.predicted_satisfied,
      connector_key_id: checked.key_id,
    });
    record.simulation = deepFreeze(checked.simulation);
    record.simulation_digest = checked.simulation_digest;
    record.simulation_predicted_satisfied = checked.predicted_satisfied;
    return this.inspect(actionId);
  }

  // ---- Plans: ordered steps, one kill switch, reverse-order unwind ----

  /** Open a plan that v0.3 proposals can join as numbered steps. */
  openPlan({ plan_id: planId, ...rest } = {}) {
    assertNoUnknownFields(rest, new Set(), "Plan");
    assert(
      typeof planId === "string" && PLAN_ID_PATTERN.test(planId),
      "SCHEMA_INVALID",
      "plan_id must look like plan_<name>.",
    );
    assert(!this.plans.has(planId), "PLAN_EXISTS", "A plan with this id is already open.", { plan_id: planId });
    assert(this.plans.size < this.maxActions, "ACTION_CAPACITY_REACHED", "The in-memory plan capacity has been reached.");
    this.eventStore.append(planId, "PLAN_OPENED", "rail", { plan_id: planId });
    this.plans.set(planId, { plan_id: planId, state: "open", steps: [], halt_reason: null });
    return this.inspectPlan(planId);
  }

  getPlan(planId) {
    const plan = this.plans.get(planId);
    assert(plan, "PLAN_NOT_FOUND", "Plan was not found.", { plan_id: planId });
    return plan;
  }

  assertPlanOpen(plan) {
    assert(
      plan.state === "open",
      plan.state === "halted" || plan.state.startsWith("unwind") ? "PLAN_HALTED" : "PLAN_CLOSED",
      `Plan ${plan.plan_id} is ${plan.state}; no further step may proceed.`,
      { plan_id: plan.plan_id, plan_state: plan.state },
    );
  }

  /** The kill switch: a step of a plan that is no longer open cannot advance. */
  assertPlanAllows(record) {
    if (record.proposal.plan) this.assertPlanOpen(this.getPlan(record.proposal.plan.plan_id));
  }

  /**
   * A satisfied step keeps its reserved recourse until the plan is committed
   * or unwound, so a later failure can still undo it.
   */
  holdForPlan(record) {
    if (!record.proposal.plan) return false;
    const plan = this.getPlan(record.proposal.plan.plan_id);
    if (plan.state === "committed") return false;
    this.eventStore.append(record.action_id, "PLAN_STEP_HELD", "rail", {
      plan_id: plan.plan_id,
      step: record.proposal.plan.step,
    });
    record.plan_held = true;
    return true;
  }

  activePostcondition(record) {
    return record.unwinding ? record.proposal.plan.unwind_postcondition : record.proposal.postcondition;
  }

  /**
   * Stop a plan. Steps not yet executing are revoked and their recourse is
   * released; nothing in the plan can be authorized, reserved, permitted or
   * executed afterwards. A step already executing finishes its own call.
   */
  haltPlan(planId, { reason = "OPERATOR_HALT", ...rest } = {}) {
    assertNoUnknownFields(rest, new Set(), "Plan halt options");
    assert(typeof reason === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(reason), "SCHEMA_INVALID", "reason must be an upper-case code.");
    const plan = this.getPlan(planId);
    this.assertPlanOpen(plan);
    plan.state = "halted";
    plan.halt_reason = reason;
    this.eventStore.append(planId, "PLAN_HALTED", "rail", { reason });
    for (const actionId of plan.steps) {
      const record = this.actions.get(actionId);
      if (["AUTHORIZED", "RECOURSE_RESERVED", "PERMITTED"].includes(record.state)) {
        this.transition(record, "REVOKED", "PLAN_HALTED", { plan_id: planId, reason });
        if (record.reservation?.connector_commitment) {
          this.connector.releaseRecourse(record.reservation.connector_commitment.reservation_token);
        }
      }
    }
    return this.inspectPlan(planId);
  }

  /**
   * Halt the plan if it is open, then undo its held steps from the last to
   * the first with each step's reserved remedy. Each undo is verified against
   * that step's unwind postcondition before the next one starts; the first
   * step that does not verify stops the unwind.
   */
  async unwindPlan(planId) {
    const plan = this.getPlan(planId);
    if (plan.state === "open") this.haltPlan(planId, { reason: "UNWIND_REQUESTED" });
    assert(plan.state === "halted", "PLAN_CLOSED", `Plan ${planId} is ${plan.state} and cannot be unwound.`);
    const busy = plan.steps.filter((actionId) =>
      ["EXECUTING", "UNKNOWN", "EXECUTED", "VERIFYING", "BREACHED", "REMEDY_DUE", "REMEDIATING", "REMEDY_UNKNOWN", "REMEDY_VERIFYING"]
        .includes(this.actions.get(actionId).state));
    assert(busy.length === 0, "PLAN_BUSY", "A plan step is still in flight; finish it before unwinding.", { action_ids: busy });
    plan.state = "unwinding";
    this.eventStore.append(planId, "PLAN_UNWIND_STARTED", "rail", {});
    for (const actionId of [...plan.steps].reverse()) {
      const record = this.actions.get(actionId);
      if (!record.plan_held || record.state !== "SATISFIED") continue;
      record.unwinding = true;
      record.plan_held = false;
      this.transition(record, "UNWIND_DUE", "PLAN_UNWIND", { plan_id: planId, step: record.proposal.plan.step });
      let view = await this.remediate(actionId);
      if (view.state === "REMEDY_UNKNOWN") view = await this.reconcileRemedy(actionId);
      this.eventStore.append(planId, "PLAN_STEP_UNWOUND", "rail", {
        step: record.proposal.plan.step,
        action_id: actionId,
        outcome: view.outcome,
      });
      if (view.outcome !== "compensated") {
        plan.state = "unwind_failed";
        this.eventStore.append(planId, "PLAN_UNWIND_STOPPED", "rail", { step: record.proposal.plan.step });
        return this.inspectPlan(planId);
      }
    }
    plan.state = "unwound";
    this.eventStore.append(planId, "PLAN_UNWOUND", "rail", {});
    return this.inspectPlan(planId);
  }

  /**
   * Keep the plan's completed effects: close every held step as settled and
   * release its recourse. Allowed while open, after a halt, or after an
   * unwind that stopped.
   */
  commitPlan(planId) {
    const plan = this.getPlan(planId);
    assert(
      ["open", "halted", "unwind_failed"].includes(plan.state),
      "PLAN_CLOSED",
      `Plan ${planId} is ${plan.state} and cannot be committed.`,
    );
    const busy = plan.steps.filter((actionId) =>
      !["SATISFIED", "CLOSED", "DENIED", "REVOKED", "EXPIRED", "FAILED", "PROPOSED"].includes(this.actions.get(actionId).state));
    assert(busy.length === 0, "PLAN_BUSY", "A plan step is still in flight; finish it before committing.", { action_ids: busy });
    plan.state = "committed";
    this.eventStore.append(planId, "PLAN_COMMITTED", "rail", {});
    for (const actionId of plan.steps) {
      const record = this.actions.get(actionId);
      if (record.plan_held && record.state === "SATISFIED") {
        record.plan_held = false;
        this.close(record);
      }
    }
    return this.inspectPlan(planId);
  }

  inspectPlan(planId) {
    const plan = this.getPlan(planId);
    const events = this.eventStore.list(planId);
    return {
      plan_id: plan.plan_id,
      state: plan.state,
      halt_reason: plan.halt_reason,
      steps: plan.steps.map((actionId, index) => {
        const record = this.actions.get(actionId);
        return {
          step: index + 1,
          action_id: actionId,
          state: record.state,
          outcome: record.receipt?.outcome ?? null,
          held: record.plan_held === true,
        };
      }),
      event_count: events.length,
      event_chain_head: events.at(-1)?.event_hash ?? null,
    };
  }

  /** The plan's own signed event chain. */
  planEvents(planId) {
    this.getPlan(planId);
    return this.eventStore.list(planId);
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
      ...(record.simulation
        ? { simulation_digest: record.simulation_digest, simulation_predicted_satisfied: record.simulation_predicted_satisfied }
        : {}),
      ...(record.proposal.plan
        ? { plan_id: record.proposal.plan.plan_id, plan_step: record.proposal.plan.step, plan_held: record.plan_held === true }
        : {}),
      ...(record.authorization?.decision_digest
        ? {
            authorization_decision_digest: record.authorization.decision_digest,
            authorizer_key_id: record.authorization.authorizer_key_id,
          }
        : {}),
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
      schema_version: BUNDLE_VERSION_BY_PROPOSAL.get(record.proposal.schema_version),
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
      ...(auditProfile && record.simulation ? { simulation_result: record.simulation } : {}),
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
    const eventPayload = {
      from_state: previousState,
      to_state: nextState,
      reason_code: reasonCode,
      details_digest: digest(details ?? {}),
    };
    this.eventStore.append(record.action_id, "STATE_TRANSITION", "rail", eventPayload);
    record.state = nextState;
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
    assert(
      RECEIPT_RECOURSE_STATUSES.has(recourseFinalStatus.status),
      "RECEIPT_UNSUPPORTED",
      "A settlement receipt cannot represent an unknown final recourse status; the action stays review-required.",
    );
    this.transition(record, "CLOSED", `SETTLEMENT_${outcome.toUpperCase()}`, {
      outcome,
    });
    const events = this.eventStore.list(record.action_id);
    const receiptSchemaVersion = RECEIPT_VERSION_BY_PROPOSAL.get(
      record.proposal.schema_version,
    );
    const receiptBody = {
      schema_version: receiptSchemaVersion,
      ...(receiptSchemaVersion !== "consequence-rail/settlement-receipt/v0.1"
        ? { proposal_schema_version: record.proposal.schema_version }
        : {}),
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
      closed_at: events.at(-1).recorded_at,
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
    assertPlainObject(input, "ActionProposal");
    const open = input.schema_version === OPEN_PROPOSAL_VERSION;
    if (open) {
      assertNoUnknownFields(input, PROPOSAL_V3_OPTIONAL_FIELDS, "ActionProposal");
      assertRequiredFields(input, PROPOSAL_V3_FIELDS, "ActionProposal");
    } else {
      assertExactFields(input, PROPOSAL_FIELDS, "ActionProposal");
    }
    assert(
      ACTION_PROPOSAL_VERSIONS.has(input.schema_version),
      "SCHEMA_INVALID",
      "Unsupported ActionProposal schema version.",
    );
    assert(
      proposalAdmitsActionType(input.schema_version, input.action_type),
      "SCHEMA_INVALID",
      "Unsupported action type.",
    );
    const actionClass = open ? this.actionClasses.get(input.action_type) : null;
    assert(
      !open || actionClass !== null,
      "ACTION_CLASS_UNREGISTERED",
      "This rail has no registered class for the action type.",
      { action_type: input.action_type },
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
      open ? EVIDENCE_PLAN_V3_FIELDS : EVIDENCE_PLAN_FIELDS,
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

    if (open) {
      assertExactFields(input.recourse_scope, RECOURSE_SCOPE_FIELDS, "ActionProposal.recourse_scope");
      validateClassParameters(actionClass, input.parameters);
      validateProposalDeclarations(actionClass, input);
      if (input.plan !== undefined) {
        assertExactFields(input.plan, PLAN_REFERENCE_FIELDS, "ActionProposal.plan");
        assert(
          typeof input.plan.plan_id === "string" && PLAN_ID_PATTERN.test(input.plan.plan_id),
          "SCHEMA_INVALID",
          "ActionProposal.plan.plan_id is invalid.",
        );
        assertSafeInteger(input.plan.step, "ActionProposal.plan.step", { min: 1, max: MAX_PLAN_STEPS });
        evaluatePostcondition(input.plan.unwind_postcondition, { facts: {} });
      }
    } else if (input.action_type === "demo.inventory.allocate/v1") {
      assertExactFields(
        input.parameters,
        INVENTORY_PARAMETER_FIELDS,
        "ActionProposal.parameters",
      );
      assertNonEmptyString(input.parameters.sku, "ActionProposal.parameters.sku");
      assertSafeInteger(input.parameters.quantity, "ActionProposal.parameters.quantity", {
        min: 1,
        message: "Allocation quantity must be a positive integer.",
      });
    } else if (input.action_type === "demo.refund.issue/v1") {
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
        typeof input.parameters.currency === "string" &&
          /^[A-Z]{3}$/.test(input.parameters.currency),
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
    const scopeField = proposalScopeField(record.proposal);
    assertExactFields(
      input,
      scopeField === "max_quantity" ? INVENTORY_RECOURSE_INPUT_FIELDS : RECOURSE_INPUT_FIELDS,
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
      input[scopeField],
      `RecourseReservation.${scopeField}`,
      {
        min: 0,
        code: "RECOURSE_INVALID",
        message: `Recourse ${scopeField} must be a non-negative integer.`,
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
    if (record.proposal.schema_version === OPEN_PROPOSAL_VERSION) {
      const actionClass = this.actionClasses.get(record.proposal.action_type);
      assert(
        actionClass?.recourse.kinds.includes(input.kind),
        "RECOURSE_INVALID",
        "The action class does not allow this remedy kind.",
      );
      const covers = record.proposal.recourse_scope.covers_parameter;
      if (covers !== null) {
        assert(
          input[scopeField] >= record.proposal.parameters[covers],
          "RECOURSE_INVALID",
          `Recourse ${scopeField} does not cover the proposed ${covers}.`,
        );
      }
    } else if (record.proposal.parameters?.quantity !== undefined) {
      assert(
        input.max_quantity >= record.proposal.parameters.quantity,
        "RECOURSE_INVALID",
        "Recourse quantity does not cover the proposed allocation.",
      );
    } else if (record.proposal.parameters?.amount_minor !== undefined) {
      assert(
        input.max_amount_minor >= record.proposal.parameters.amount_minor,
        "RECOURSE_INVALID",
        "Recourse amount does not cover the proposed action.",
      );
    }
    return deepClone(input);
  }

  validateConnectorCommitment(record, request, commitment) {
    const commitmentScopeField = proposalScopeField(record.proposal);
    assertExactFields(
      commitment,
      commitmentScopeField === "max_quantity"
        ? INVENTORY_CONNECTOR_COMMITMENT_FIELDS
        : CONNECTOR_COMMITMENT_FIELDS,
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
      commitmentScopeField,
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
    const missingClauses = missingPostconditionPaths(
      this.activePostcondition(record),
      input.facts,
    );
    assert(
      missingClauses.length === 0,
      "EVIDENCE_FACT_MISSING",
      "Evidence does not report every postcondition fact.",
      { clause_indexes: missingClauses },
    );
    // Bindings show the approved effect happened. After an unwind the
    // effect is gone, so only the unwind postcondition applies.
    if (record.proposal.schema_version === OPEN_PROPOSAL_VERSION && !record.unwinding) {
      const unmet = unmetBindings(record.proposal, input.facts);
      assert(
        unmet.length === 0,
        "EVIDENCE_BINDING_MISMATCH",
        "Evidence facts do not equal the parameters the proposal binds them to.",
        { binding_indexes: unmet },
      );
    }
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
