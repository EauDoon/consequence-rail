import { digest } from "./canonical.js";
import { UnknownExecutionError, UnknownRemedyError, RailError } from "./errors.js";
import { createDemoConnectorSigner, signArtifact } from "./signing.js";

/**
 * Bounded synthetic support-ticket connector. It moves no money.
 *
 * It posts one comment on one synthetic ticket for a registered
 * demo.ticket.comment/v1 action, and its pre-reserved remedy deletes only a
 * comment that this action created. The reservation scope is max_quantity:
 * the number of comments the remedy may delete. Nothing here talks to a real
 * help desk, CRM or messaging system.
 */
export const TICKET_ACTION_TYPE = "demo.ticket.comment/v1";
const CONNECTOR = "mock-ticket-service";
const CAPABILITY = "delete-comment";

export class MockTicketConnector {
  constructor(clock, { signer = createDemoConnectorSigner() } = {}) {
    this.clock = clock;
    this.signer = signer;
    this.comments = [];
    this.executions = new Map();
    this.executionActionDigests = new Map();
    this.executionComments = new Map();
    this.recourseReservations = new Map();
    this.remedyExecutions = new Map();
    this.remedyActionDigests = new Map();
    this.executeCalls = 0;
    this.statusCalls = 0;
    this.reserveRecourseCalls = 0;
    this.recourseStatusCalls = 0;
    this.remedyCalls = 0;
    this.remedyStatusCalls = 0;
    this.simulateCalls = 0;
    this.exclusiveCredentialCustody = true;
  }

  capabilities() {
    return {
      connector: CONNECTOR,
      exclusive_credential_custody: this.exclusiveCredentialCustody,
      actions: [TICKET_ACTION_TYPE],
      remedies: [CAPABILITY],
      connector_signing_key_id: this.signer.kid,
    };
  }

  trustedKeys() {
    return new Map([[this.signer.kid, this.signer.publicKey]]);
  }

  reserveRecourse(proposal, request) {
    this.reserveRecourseCalls += 1;
    if (request.capability !== CAPABILITY || request.connector !== CONNECTOR) {
      throw new RailError("RECOURSE_UNAVAILABLE", "The connector cannot reserve the requested remedy.");
    }
    if (proposal.action_type !== TICKET_ACTION_TYPE) {
      throw new RailError("RECOURSE_UNAVAILABLE", "The connector only reserves comment remedies for comment actions.");
    }
    if (!Number.isSafeInteger(request.max_quantity) || request.max_quantity < 1) {
      throw new RailError("RECOURSE_SCOPE_INSUFFICIENT", "The comment remedy must be able to delete at least one comment.");
    }
    const reservationToken = `rsv_${digest({
      action_digest: request.action_digest,
      capability: request.capability,
      expires_at: request.expires_at,
      max_quantity: request.max_quantity,
    }).slice(0, 24)}`;
    const commitment = signArtifact({
      schema_version: "consequence-rail/connector-recourse-commitment/v0.1",
      reservation_token: reservationToken,
      action_digest: request.action_digest,
      connector: CONNECTOR,
      capability: request.capability,
      kind: request.kind,
      expires_at: request.expires_at,
      max_attempts: request.max_attempts,
      max_quantity: request.max_quantity,
      reserved_at: this.clock.now(),
      status: "active",
    }, this.signer);
    this.recourseReservations.set(reservationToken, { commitment, status: "active" });
    return commitment;
  }

  recourseStatus(reservationToken) {
    this.recourseStatusCalls += 1;
    const reservation = this.recourseReservations.get(reservationToken);
    if (
      reservation?.status === "active" &&
      new Date(reservation.commitment.expires_at).getTime() <= new Date(this.clock.now()).getTime()
    ) {
      reservation.status = "expired";
    }
    return reservation
      ? { reservation_token: reservationToken, status: reservation.status }
      : { reservation_token: reservationToken, status: "unknown" };
  }

  releaseRecourse(reservationToken) {
    const reservation = this.recourseReservations.get(reservationToken);
    if (reservation && reservation.status === "active") {
      reservation.status = "released";
    }
  }

  /**
   * Signed dry run: predict the facts that posting this comment would
   * produce, without posting it. A ticket that is locked predicts no comment.
   */
  simulate(proposal, { actionDigest }) {
    this.simulateCalls += 1;
    const locked = this.lockedTickets?.has(proposal.target.resource_id) === true;
    return signArtifact({
      schema_version: "consequence-rail/simulation-result/v0.1",
      action_digest: actionDigest,
      connector: CONNECTOR,
      simulated_at: this.clock.now(),
      predicted_facts: {
        comment_count: locked ? 0 : 1,
        visibility: proposal.parameters.visibility,
        body_matches: !locked,
      },
    }, this.signer);
  }

  postComment(proposal, idempotencyKey, suffix) {
    const comment = {
      comment_id: `cmt_${digest(`${proposal.target.resource_id}:${idempotencyKey}:${suffix}`).slice(0, 20)}`,
      ticket_id: proposal.target.resource_id,
      body_digest: digest(proposal.parameters.body),
      visibility: proposal.parameters.visibility,
      status: "active",
    };
    this.comments.push(comment);
    const tracked = this.executionComments.get(idempotencyKey) ?? [];
    tracked.push(comment.comment_id);
    this.executionComments.set(idempotencyKey, tracked);
    return comment;
  }

  rejectForeignIdempotency(bindings, idempotencyKey, proposal) {
    const actionDigest = digest(proposal);
    const bound = bindings.get(idempotencyKey);
    if (bound !== undefined && bound !== actionDigest) {
      throw new RailError("IDEMPOTENCY_CONFLICT", "Idempotency key is already bound to a different action.");
    }
    return actionDigest;
  }

  remember(results, digests, idempotencyKey, proposal, result) {
    digests.set(idempotencyKey, this.rejectForeignIdempotency(digests, idempotencyKey, proposal));
    results.set(idempotencyKey, result);
    return result;
  }

  async execute(proposal, idempotencyKey, fault = "none") {
    this.executeCalls += 1;
    if (this.executionActionDigests.has(idempotencyKey)) {
      this.rejectForeignIdempotency(this.executionActionDigests, idempotencyKey, proposal);
      return this.executions.get(idempotencyKey);
    }
    if (fault === "lost-response-before-commit") {
      this.remember(this.executions, this.executionActionDigests, idempotencyKey, proposal, {
        status: "no_effect",
        idempotency_key: idempotencyKey,
      });
      throw new UnknownExecutionError("The connector response was lost before an external effect was confirmed.", {
        idempotency_key: idempotencyKey,
      });
    }
    const comment = this.postComment(proposal, idempotencyKey, "primary");
    const result = { status: "executed", external_id: comment.comment_id, idempotency_key: idempotencyKey };
    this.remember(this.executions, this.executionActionDigests, idempotencyKey, proposal, result);
    // The duplicate fault posts the same comment twice, the classic agent
    // retry bug. The bounded remedy deletes only the extra comment.
    if (fault === "duplicate" || fault === "remedy-failure") {
      this.postComment(proposal, idempotencyKey, "duplicate");
    }
    if (fault === "lost-response-after-commit") {
      throw new UnknownExecutionError("The connector response was lost after the external effect.", {
        external_id: comment.comment_id,
        idempotency_key: idempotencyKey,
      });
    }
    return result;
  }

  async status(idempotencyKey) {
    this.statusCalls += 1;
    return this.executions.get(idempotencyKey) ?? { status: "unknown", idempotency_key: idempotencyKey };
  }

  /** Read-only view of one ticket's live comments, for a pass-through tool. */
  listComments(ticketId) {
    return this.comments
      .filter((comment) => comment.ticket_id === ticketId && comment.status === "active")
      .map(({ comment_id, visibility, body_digest }) => ({ comment_id, visibility, body_digest }));
  }

  activeComments(proposal) {
    const tracked = new Set(this.executionComments.get(proposal.idempotency_key) ?? []);
    return this.comments.filter(
      (comment) =>
        tracked.has(comment.comment_id) &&
        comment.ticket_id === proposal.target.resource_id &&
        comment.status === "active",
    );
  }

  async observe(proposal, options = {}) {
    const active = this.activeComments(proposal);
    const observedAt =
      options.fault === "stale-evidence" || options.fault === "post-remedy-stale-evidence"
        ? new Date(new Date(this.clock.now()).getTime() - 3_600_000).toISOString()
        : this.clock.now();
    const falseOffset = options.fault === "post-remedy-false-evidence" ? 1 : 0;
    return {
      schema_version: "consequence-rail/outcome-evidence/v0.1",
      action_digest: options.actionDigest,
      source: CONNECTOR,
      resource: { type: "ticket", id: proposal.target.resource_id },
      observed_at: observedAt,
      facts: {
        comment_count: active.length + falseOffset,
        visibility: active[0]?.visibility ?? null,
        body_matches: active.length > 0 &&
          active.every((comment) => comment.body_digest === digest(proposal.parameters.body)),
      },
    };
  }

  async remediate(proposal, reservation, idempotencyKey, fault = "none") {
    this.remedyCalls += 1;
    if (this.remedyActionDigests.has(idempotencyKey)) {
      this.rejectForeignIdempotency(this.remedyActionDigests, idempotencyKey, proposal);
      return this.remedyExecutions.get(idempotencyKey);
    }
    const recourse = this.recourseReservations.get(reservation.connector_commitment?.reservation_token);
    if (!recourse || recourse.status !== "active") {
      throw new RailError("RECOURSE_NOT_ACTIVE", "The connector-backed recourse is not active.");
    }
    const record = (result) =>
      this.remember(this.remedyExecutions, this.remedyActionDigests, idempotencyKey, proposal, result);
    if (fault === "remedy-lost-response-before-commit") {
      record({ status: "no_effect", idempotency_key: idempotencyKey });
      throw new UnknownRemedyError("The remedy response was lost before an effect was confirmed.", {
        idempotency_key: idempotencyKey,
      });
    }
    if (fault === "remedy-failure") {
      return record({ status: "failed", idempotency_key: idempotencyKey });
    }
    // Delete only a comment this action created. With a duplicate, the extra
    // comment goes and the action's own comment, which the receipt records,
    // stays.
    const active = this.activeComments(proposal);
    const bound = active.length > 1 ? active[active.length - 1] : active[0];
    if (!bound) {
      return record({ status: "failed", idempotency_key: idempotencyKey });
    }
    bound.status = "deleted";
    const result = record({ status: "remediated", external_id: bound.comment_id, idempotency_key: idempotencyKey });
    recourse.status = "consumed";
    if (fault === "remedy-lost-response-after-commit") {
      throw new UnknownRemedyError("The remedy response was lost after the external effect.", {
        external_id: bound.comment_id,
        idempotency_key: idempotencyKey,
      });
    }
    return result;
  }

  async remedyStatus(idempotencyKey) {
    this.remedyStatusCalls += 1;
    return this.remedyExecutions.get(idempotencyKey) ?? { status: "unknown", idempotency_key: idempotencyKey };
  }
}
