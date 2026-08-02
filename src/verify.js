import { digest } from "./canonical.js";
import { validateSettlementBundle } from "./bundle-validation.js";
import { verifyEventChain } from "./event-store.js";
import { RailError } from "./errors.js";
import { evaluatePostcondition } from "./postconditions.js";
import { ALLOWED_TRANSITIONS } from "./rail.js";
import { verifyArtifact } from "./signing.js";

function integrityAssert(condition, message, details = {}) {
  if (!condition) {
    throw new RailError("BUNDLE_TAMPERED", message, details);
  }
}

function semanticAssert(condition, message, details = {}) {
  if (!condition) {
    throw new RailError("SEMANTIC_INVALID", message, details);
  }
}

export function verifyBundle(
  bundle,
  {
    trustedKeys = new Map(),
    trustedConnectorKeys = new Map(),
    requireSemantics = true,
  } = {},
) {
  validateSettlementBundle(bundle);
  integrityAssert(
    bundle?.schema_version === "consequence-rail/settlement-bundle/v0.1",
    "Unsupported settlement bundle version.",
  );
  integrityAssert(
    bundle.profile === "receipt" || bundle.profile === "audit",
    "Settlement bundle profile is invalid.",
  );

  const chain = verifyEventChain(bundle.events ?? [], trustedKeys);
  verifyArtifact(bundle.recourse_reservation, trustedKeys);
  verifyArtifact(bundle.recourse_reservation?.connector_commitment, trustedConnectorKeys);
  verifyArtifact(bundle.action_permit, trustedKeys);
  for (const evidence of bundle.outcome_evidence ?? []) {
    verifyArtifact(evidence, trustedKeys);
  }
  verifyArtifact(bundle.settlement_receipt, trustedKeys);

  const action = bundle.action;
  const reservation = bundle.recourse_reservation;
  const permit = bundle.action_permit;
  const receipt = bundle.settlement_receipt;
  const evidenceManifest = bundle.evidence_manifest ?? [];

  integrityAssert(permit.action_id === action.action_id, "Permit action id does not match the bundle.");
  integrityAssert(
    permit.action_digest === action.action_digest,
    "Permit action digest does not match the bundle.",
  );
  integrityAssert(
    permit.recourse_reservation_digest === digest(reservation),
    "Permit does not bind the supplied recourse reservation.",
  );
  integrityAssert(receipt.action_id === action.action_id, "Receipt action id does not match the bundle.");
  integrityAssert(
    receipt.action_digest === action.action_digest,
    "Receipt action digest does not match the bundle.",
  );
  integrityAssert(
    receipt.action_permit_digest === digest(permit),
    "Receipt does not bind the supplied permit.",
  );
  integrityAssert(
    receipt.recourse_reservation_digest === digest(reservation),
    "Receipt does not bind the supplied recourse reservation.",
  );
  integrityAssert(
    receipt.connector_recourse_commitment_digest ===
      digest(reservation.connector_commitment),
    "Receipt does not bind the connector recourse commitment.",
  );
  integrityAssert(
    JSON.stringify(receipt.evidence_digests) === JSON.stringify(evidenceManifest),
    "Receipt evidence digests do not match the evidence manifest.",
  );
  if (bundle.profile === "audit") {
    integrityAssert(
      JSON.stringify(evidenceManifest) ===
        JSON.stringify((bundle.outcome_evidence ?? []).map((item) => digest(item))),
      "Audit evidence does not match the evidence manifest.",
    );
  } else {
    integrityAssert(
      (bundle.outcome_evidence ?? []).length === 0,
      "Receipt profile must not include raw outcome evidence.",
    );
  }
  integrityAssert(
    receipt.event_chain_head === chain.chain_head,
    "Receipt does not bind the event-chain head.",
  );
  integrityAssert(
    ["settled", "compensated", "disputed"].includes(receipt.outcome),
    "Receipt contains an invalid technical settlement outcome.",
  );
  integrityAssert(
    receipt.assurance_mode === permit.assurance_mode &&
      receipt.bypass_possible === permit.bypass_possible,
    "Receipt assurance disclosure does not match the permit.",
  );

  if (action.proposal) {
    integrityAssert(
      digest(action.proposal) === action.action_digest,
      "Included proposal does not match the action digest.",
    );
  }

  const closed = (bundle.events ?? []).at(-1);
  integrityAssert(
    closed?.event_type === "STATE_TRANSITION" &&
      closed?.payload?.to_state === "CLOSED",
    "The event chain does not end in CLOSED.",
  );

  const integrity = {
    valid: true,
    event_count: chain.event_count,
    event_chain_head: chain.chain_head,
  };

  if (!requireSemantics) {
    return {
      valid: true,
      integrity,
      semantics: {
        status: "not_requested",
        valid: null,
      },
      action_id: action.action_id,
      outcome: receipt.outcome,
      assurance_mode: receipt.assurance_mode,
      bypass_possible: receipt.bypass_possible,
      event_count: chain.event_count,
      event_chain_head: chain.chain_head,
      trusted_key_id: receipt.signature.key_id,
      trusted_connector_key_id: reservation.connector_commitment.signature.key_id,
    };
  }

  const semantics = verifySemantics(bundle);
  return {
    valid: true,
    integrity,
    semantics,
    action_id: action.action_id,
    outcome: receipt.outcome,
    assurance_mode: receipt.assurance_mode,
    bypass_possible: receipt.bypass_possible,
    event_count: chain.event_count,
    event_chain_head: chain.chain_head,
    trusted_key_id: receipt.signature.key_id,
    trusted_connector_key_id: reservation.connector_commitment.signature.key_id,
  };
}

export function verifyBundleTimeline(
  bundle,
  {
    trustedKeys = new Map(),
    trustedConnectorKeys = new Map(),
  } = {},
) {
  const verification = verifyBundle(bundle, {
    trustedKeys,
    trustedConnectorKeys,
    requireSemantics: bundle?.profile === "audit",
  });
  const events = (bundle.events ?? []).map((event) => ({
    sequence: event.sequence,
    event_type: event.event_type,
    actor: event.actor,
    recorded_at: event.recorded_at,
    payload_digest: digest(event.payload),
    ...(event.event_type === "STATE_TRANSITION"
      ? {
          from_state: event.payload.from_state,
          to_state: event.payload.to_state,
          reason_code: event.payload.reason_code,
        }
      : {}),
  }));
  return {
    valid: verification.valid,
    action_id: verification.action_id,
    outcome: verification.outcome,
    event_count: events.length,
    event_chain_head: verification.event_chain_head,
    semantics: verification.semantics,
    events,
  };
}

function verifySemantics(bundle) {
  semanticAssert(
    bundle.profile === "audit" &&
      bundle.action?.proposal &&
      Array.isArray(bundle.outcome_evidence),
    "Full semantic verification requires an audit-profile bundle.",
  );

  const action = bundle.action;
  const proposal = action.proposal;
  const reservation = bundle.recourse_reservation;
  const commitment = reservation.connector_commitment;
  const permit = bundle.action_permit;
  const receipt = bundle.settlement_receipt;
  const events = bundle.events;

  semanticAssert(reservation.action_digest === action.action_digest, "Reservation action binding is invalid.");
  semanticAssert(commitment.action_digest === action.action_digest, "Connector commitment action binding is invalid.");
  for (const field of [
    "connector",
    "capability",
    "kind",
    "expires_at",
    "max_attempts",
    "max_amount_minor",
  ]) {
    semanticAssert(
      commitment[field] === reservation[field],
      `Connector commitment does not match reservation field ${field}.`,
    );
  }
  semanticAssert(commitment.status === "active", "Connector commitment was not active when issued.");
  semanticAssert(
    new Date(commitment.reserved_at).getTime() <= new Date(permit.issued_at).getTime(),
    "Permit was issued before connector recourse was reserved.",
  );
  semanticAssert(
    new Date(reservation.expires_at).getTime() >=
      new Date(permit.expires_at).getTime() +
        Number(reservation.remedy_window_seconds ?? 0) * 1_000,
    "Reservation does not cover permit expiry and remedy window.",
  );
  semanticAssert(
    action.action_type === proposal.action_type &&
      action.resource_id_digest === digest(proposal.target.resource_id),
    "Action summary does not match the included proposal.",
  );
  semanticAssert(
    proposal.target.connector === reservation.connector,
    "Reservation connector does not match the action target.",
  );
  semanticAssert(
    permit.max_uses === 1 &&
      (permit.assurance_mode === "enforced" || permit.assurance_mode === "cooperative"),
    "Permit execution semantics are invalid.",
  );
  semanticAssert(
    permit.bypass_possible === (permit.assurance_mode !== "enforced"),
    "Permit bypass disclosure is invalid.",
  );

  const states = replayStates(events, action);
  const expectedOutcome = deriveOutcome(states);
  semanticAssert(
    receipt.outcome === expectedOutcome,
    "Receipt outcome does not follow from the signed lifecycle.",
    {
      expected: expectedOutcome,
      actual: receipt.outcome,
    },
  );
  semanticAssert(
    receipt.configured_postcondition_result ===
      (expectedOutcome === "settled" || expectedOutcome === "compensated"
        ? "satisfied"
        : "unresolved"),
    "Receipt postcondition result does not match its outcome.",
  );

  const executionEvent = events.find(
    (event) =>
      event.event_type === "STATE_TRANSITION" &&
      event.payload.to_state === "EXECUTING",
  );
  semanticAssert(executionEvent, "Lifecycle never consumed the execution permit.");
  semanticAssert(
    new Date(executionEvent.recorded_at).getTime() >=
      new Date(permit.issued_at).getTime() &&
      new Date(executionEvent.recorded_at).getTime() <=
        new Date(permit.expires_at).getTime(),
    "Execution occurred outside the permit validity window.",
  );
  semanticAssert(
    states.filter((state) => state === "EXECUTING").length === 1,
    "Lifecycle contains more than one execution attempt.",
  );

  const evaluations = bundle.outcome_evidence.map((evidence) =>
    verifyEvidenceSemantics(evidence, proposal, events),
  );

  if (expectedOutcome === "settled") {
    semanticAssert(
      evaluations.some((item) => item.phase !== "post-remedy" && item.satisfied),
      "Settled outcome lacks satisfying initial evidence.",
    );
    semanticAssert(!states.includes("BREACHED"), "Settled lifecycle contains a breach.");
  } else if (expectedOutcome === "compensated") {
    semanticAssert(
      evaluations.some((item) => item.phase !== "post-remedy" && !item.satisfied),
      "Compensated outcome lacks evidence of the initial breach.",
    );
    semanticAssert(
      evaluations.some((item) => item.phase === "post-remedy" && item.satisfied),
      "Compensated outcome lacks satisfying post-remedy evidence.",
    );
  } else {
    semanticAssert(
      states.some((state) =>
        [
          "INCONCLUSIVE",
          "REVIEW_REQUIRED",
          "REMEDY_FAILED",
          "REMEDY_INCONCLUSIVE",
        ].includes(state),
      ),
      "Disputed outcome lacks an unresolved lifecycle state.",
    );
  }

  semanticAssert(
    ["active", "expired", "released", "consumed"].includes(
      receipt.recourse_final_status,
    ),
    "Receipt recourse final status is invalid.",
  );
  const recourseFinalizedEvents = events.filter(
    (event) =>
      event.event_type === "RECOURSE_FINALIZED" ||
      event.event_type === "RECOURSE_STATUS_RECORDED",
  );
  semanticAssert(
    recourseFinalizedEvents.length === 1 &&
      recourseFinalizedEvents[0].payload.status === receipt.recourse_final_status &&
      recourseFinalizedEvents[0].payload.connector_commitment_digest ===
        digest(commitment),
    "Receipt recourse final status does not match the signed event history.",
  );
  const recourseFinalizedEvent = recourseFinalizedEvents[0];
  semanticAssert(
    recourseFinalizedEvent === events.at(-2),
    "Recourse final status must be recorded immediately before the terminal CLOSED transition.",
  );
  semanticAssert(
    recourseFinalizedEvent.event_type ===
      (receipt.recourse_final_status === "active"
        ? "RECOURSE_STATUS_RECORDED"
        : "RECOURSE_FINALIZED"),
    "Recourse finalization event type does not match its status.",
  );
  const terminalState = stateBeforeEvent(events, recourseFinalizedEvent.sequence);
  const expectedTerminalStates = {
    settled: ["SATISFIED"],
    compensated: ["REMEDIATED"],
    disputed: [
      "INCONCLUSIVE",
      "REMEDY_INCONCLUSIVE",
      "REVIEW_REQUIRED",
      "REMEDY_FAILED",
    ],
  };
  semanticAssert(
    expectedTerminalStates[expectedOutcome].includes(terminalState),
    "Recourse final status was recorded outside the terminal settlement phase.",
    {
      expected_outcome: expectedOutcome,
      actual_state: terminalState,
    },
  );
  semanticAssert(
    receipt.technical_claim ===
      "The configured postcondition was evaluated against declared evidence sources.",
    "Receipt contains an unsupported technical claim.",
  );

  return {
    status: "verified",
    valid: true,
    final_state: "CLOSED",
    derived_outcome: expectedOutcome,
    evidence_count: evaluations.length,
  };
}

function replayStates(events, action) {
  semanticAssert(
    events[0]?.event_type === "ACTION_PROPOSED" &&
      events[0]?.payload?.state === "PROPOSED" &&
      events[0]?.payload?.action_digest === action.action_digest,
    "Event history does not begin with the supplied action.",
  );

  let current = "PROPOSED";
  let previousRecordedAt = Number.NEGATIVE_INFINITY;
  const states = [current];
  for (const event of events) {
    semanticAssert(
      event.action_id === action.action_id,
      "Event is bound to a different action id.",
      {
        sequence: event.sequence,
      },
    );
    const recordedAt = new Date(event.recorded_at).getTime();
    semanticAssert(
      Number.isFinite(recordedAt) && recordedAt >= previousRecordedAt,
      "Event timestamps are invalid or non-monotonic.",
      {
        sequence: event.sequence,
      },
    );
    previousRecordedAt = recordedAt;
    if (event.event_type !== "STATE_TRANSITION") continue;
    semanticAssert(
      event.payload.from_state === current,
      "State transition does not start from the replayed state.",
      {
        sequence: event.sequence,
        expected: current,
        actual: event.payload.from_state,
      },
    );
    semanticAssert(
      (ALLOWED_TRANSITIONS[current] ?? []).includes(event.payload.to_state),
      "Event history contains an illegal state transition.",
      {
        sequence: event.sequence,
        from: current,
        to: event.payload.to_state,
      },
    );
    current = event.payload.to_state;
    states.push(current);
  }
  semanticAssert(current === "CLOSED", "Replayed lifecycle does not end in CLOSED.");
  return states;
}

function deriveOutcome(states) {
  if (states.includes("REMEDIATED")) return "compensated";
  if (states.includes("SATISFIED")) return "settled";
  if (
    states.some((state) =>
      [
        "INCONCLUSIVE",
        "REVIEW_REQUIRED",
        "REMEDY_FAILED",
        "REMEDY_INCONCLUSIVE",
      ].includes(state),
    )
  ) {
    return "disputed";
  }
  throw new RailError("SEMANTIC_INVALID", "Lifecycle does not support a settlement outcome.");
}

function verifyEvidenceSemantics(evidence, proposal, events) {
  semanticAssert(
    evidence.action_digest === digest(proposal),
    "Evidence is bound to a different proposal.",
  );
  semanticAssert(
    evidence.source === proposal.evidence_plan.source,
    "Evidence source does not match the proposal.",
  );
  semanticAssert(
    evidence.resource?.type === proposal.target.resource_type &&
      evidence.resource?.id === proposal.target.resource_id,
    "Evidence resource does not match the proposal.",
  );
  const evidenceDigest = digest(evidence);
  const acceptedEvent = events.find(
    (event) =>
      event.event_type ===
        (evidence.phase === "post-remedy"
          ? "REMEDY_EVIDENCE_ACCEPTED"
          : "EVIDENCE_ACCEPTED") &&
      event.payload.evidence_digest === evidenceDigest,
  );
  semanticAssert(acceptedEvent, "Evidence is not bound to an acceptance event.");
  semanticAssert(
    stateBeforeEvent(events, acceptedEvent.sequence) ===
      (evidence.phase === "post-remedy" ? "REMEDY_VERIFYING" : "VERIFYING"),
    "Evidence was accepted outside its legal lifecycle phase.",
  );
  const age =
    new Date(acceptedEvent.recorded_at).getTime() -
    new Date(evidence.observed_at).getTime();
  semanticAssert(
    age >= 0 && age <= proposal.evidence_plan.max_age_seconds * 1_000,
    "Accepted evidence violates the configured freshness window.",
  );
  const evaluation = evaluatePostcondition(proposal.postcondition, evidence);
  semanticAssert(
    digest(evaluation) === digest(evidence.evaluation),
    "Recorded evidence evaluation does not match the configured postcondition.",
  );
  semanticAssert(
    acceptedEvent.payload.satisfied === evaluation.satisfied,
    "Evidence acceptance event contradicts the postcondition evaluation.",
  );
  return {
    phase: evidence.phase ?? "initial",
    satisfied: evaluation.satisfied,
  };
}

function stateBeforeEvent(events, targetSequence) {
  let state = "PROPOSED";
  for (const event of events) {
    if (event.sequence === targetSequence) {
      return state;
    }
    if (event.event_type === "STATE_TRANSITION") {
      state = event.payload.to_state;
    }
  }
  return null;
}
