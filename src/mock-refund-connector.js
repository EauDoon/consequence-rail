import { digest } from "./canonical.js";
import { UnknownExecutionError, UnknownRemedyError, RailError } from "./errors.js";
import { createDemoConnectorSigner, signArtifact } from "./signing.js";

const RECOVERY_METHODS = [
  "reserveRecourse",
  "recourseStatus",
  "releaseRecourse",
  "execute",
  "status",
  "observe",
  "remediate",
  "remedyStatus",
  "createRefund",
];

export function measureMockRefundRecoveryImplementation(connector) {
  const methods = {};
  for (const name of RECOVERY_METHODS) {
    const implementation = connector?.[name];
    if (typeof implementation !== "function") {
      throw new RailError(
        "RECOVERY_IMPLEMENTATION_INVALID",
        `Recovery implementation is missing method ${name}.`,
      );
    }
    methods[name] = Function.prototype.toString.call(implementation);
  }
  return digest({
    connector: "mock-refund-processor",
    capability: "void-duplicate-refund",
    measurement_profile: "callable-source/v1",
    methods,
  });
}

export class MockRefundConnector {
  constructor(clock, { signer = createDemoConnectorSigner() } = {}) {
    this.clock = clock;
    this.signer = signer;
    this.refunds = [];
    this.executions = new Map();
    this.recourseReservations = new Map();
    this.remedyExecutions = new Map();
    this.executeCalls = 0;
    this.statusCalls = 0;
    this.reserveRecourseCalls = 0;
    this.recourseStatusCalls = 0;
    this.remedyCalls = 0;
    this.remedyStatusCalls = 0;
    this.exclusiveCredentialCustody = true;
  }

  capabilities() {
    return {
      connector: "mock-refund-processor",
      exclusive_credential_custody: this.exclusiveCredentialCustody,
      actions: ["demo.refund.issue/v1"],
      remedies: ["void-duplicate-refund"],
      connector_signing_key_id: this.signer.kid,
    };
  }

  trustedKeys() {
    return new Map([[this.signer.kid, this.signer.publicKey]]);
  }

  reserveRecourse(proposal, request) {
    this.reserveRecourseCalls += 1;
    if (
      request.capability !== "void-duplicate-refund" ||
      request.connector !== "mock-refund-processor"
    ) {
      throw new RailError("RECOURSE_UNAVAILABLE", "The connector cannot reserve the requested remedy.");
    }
    if (request.max_amount_minor < proposal.parameters.amount_minor) {
      throw new RailError("RECOURSE_SCOPE_INSUFFICIENT", "The requested remedy scope is insufficient.");
    }

    const reservationToken = `rsv_${digest({
      action_digest: request.action_digest,
      capability: request.capability,
      expires_at: request.expires_at,
      max_amount_minor: request.max_amount_minor,
    }).slice(0, 24)}`;
    const commitment = signArtifact({
      schema_version: "consequence-rail/connector-recourse-commitment/v0.1",
      reservation_token: reservationToken,
      action_digest: request.action_digest,
      connector: "mock-refund-processor",
      capability: request.capability,
      kind: request.kind,
      expires_at: request.expires_at,
      max_attempts: request.max_attempts,
      max_amount_minor: request.max_amount_minor,
      reserved_at: this.clock.now(),
      status: "active",
    }, this.signer);
    this.recourseReservations.set(reservationToken, {
      commitment,
      status: "active",
    });
    return commitment;
  }

  recourseStatus(reservationToken) {
    this.recourseStatusCalls += 1;
    const reservation = this.recourseReservations.get(reservationToken);
    if (
      reservation?.status === "active" &&
      new Date(reservation.commitment.expires_at).getTime() <=
        new Date(this.clock.now()).getTime()
    ) {
      reservation.status = "expired";
    }
    return reservation
      ? {
          reservation_token: reservationToken,
          status: reservation.status,
        }
      : {
          reservation_token: reservationToken,
          status: "unknown",
        };
  }

  releaseRecourse(reservationToken) {
    const reservation = this.recourseReservations.get(reservationToken);
    if (reservation && reservation.status === "active") {
      reservation.status = "released";
    }
  }

  async execute(proposal, idempotencyKey, fault = "none") {
    this.executeCalls += 1;

    if (this.executions.has(idempotencyKey)) {
      return this.executions.get(idempotencyKey);
    }

    if (fault === "lost-response-before-commit") {
      this.executions.set(idempotencyKey, {
        status: "no_effect",
        idempotency_key: idempotencyKey,
      });
      throw new UnknownExecutionError("The connector response was lost before an external effect was confirmed.", {
        idempotency_key: idempotencyKey,
      });
    }

    const refund = this.createRefund(proposal, `${idempotencyKey}:primary`);
    const result = {
      status: "executed",
      external_id: refund.refund_id,
      idempotency_key: idempotencyKey,
    };
    this.executions.set(idempotencyKey, result);

    if (fault === "duplicate" || fault === "remedy-failure") {
      this.createRefund(proposal, `${idempotencyKey}:duplicate`);
    }

    if (fault === "lost-response-after-commit") {
      throw new UnknownExecutionError("The connector response was lost after the external effect.", {
        external_id: refund.refund_id,
        idempotency_key: idempotencyKey,
      });
    }

    return result;
  }

  async status(idempotencyKey) {
    this.statusCalls += 1;
    return this.executions.get(idempotencyKey) ?? {
      status: "unknown",
      idempotency_key: idempotencyKey,
    };
  }

  async observe(proposal, options = {}) {
    const active = this.refunds.filter(
      (refund) =>
        refund.order_id === proposal.target.resource_id &&
        refund.status === "active",
    );
    const observedAt =
      options.fault === "stale-evidence" ||
      options.fault === "post-remedy-stale-evidence"
        ? new Date(new Date(this.clock.now()).getTime() - 3_600_000).toISOString()
        : this.clock.now();
    const falseOffset = options.fault === "post-remedy-false-evidence" ? 1 : 0;

    return {
      schema_version: "consequence-rail/outcome-evidence/v0.1",
      action_digest: options.actionDigest,
      source: "mock-refund-processor",
      resource: {
        type: "order",
        id: proposal.target.resource_id,
      },
      observed_at: observedAt,
      facts: {
        active_refund_count: active.length + falseOffset,
        net_refunded_minor:
          active.reduce((total, refund) => total + refund.amount_minor, 0) +
          falseOffset * proposal.parameters.amount_minor,
        currency: proposal.parameters.currency,
      },
    };
  }

  async remediate(proposal, reservation, idempotencyKey, fault = "none") {
    this.remedyCalls += 1;
    if (this.remedyExecutions.has(idempotencyKey)) {
      return this.remedyExecutions.get(idempotencyKey);
    }

    const reservationToken = reservation.connector_commitment?.reservation_token;
    const recourse = this.recourseReservations.get(reservationToken);
    if (!recourse || recourse.status !== "active") {
      throw new RailError("RECOURSE_NOT_ACTIVE", "The connector-backed recourse is not active.");
    }

    if (fault === "remedy-lost-response-before-commit") {
      const result = {
        status: "no_effect",
        idempotency_key: idempotencyKey,
      };
      this.remedyExecutions.set(idempotencyKey, result);
      throw new UnknownRemedyError("The remedy response was lost before an effect was confirmed.", {
        idempotency_key: idempotencyKey,
      });
    }

    if (fault === "remedy-failure") {
      const result = {
        status: "failed",
        reason: "injected_failure",
        idempotency_key: idempotencyKey,
      };
      this.remedyExecutions.set(idempotencyKey, result);
      return result;
    }

    if (reservation.capability !== "void-duplicate-refund") {
      throw new RailError("REMEDY_UNSUPPORTED", "The reserved remedy is not supported.");
    }

    const active = this.refunds.filter(
      (refund) =>
        refund.order_id === proposal.target.resource_id &&
        refund.status === "active",
    );
    const duplicate = active.at(-1);
    if (!duplicate || active.length < 2) {
      const result = {
        status: "no_change",
        idempotency_key: idempotencyKey,
      };
      this.remedyExecutions.set(idempotencyKey, result);
      return result;
    }

    duplicate.status = "voided";
    duplicate.voided_at = this.clock.now();
    const result = {
      status: "remediated",
      external_id: duplicate.refund_id,
      idempotency_key: idempotencyKey,
    };
    this.remedyExecutions.set(idempotencyKey, result);
    recourse.status = "consumed";

    if (fault === "remedy-lost-response-after-commit") {
      throw new UnknownRemedyError("The remedy response was lost after the external effect.", {
        idempotency_key: idempotencyKey,
        external_id: duplicate.refund_id,
      });
    }
    return result;
  }

  async remedyStatus(idempotencyKey) {
    this.remedyStatusCalls += 1;
    return this.remedyExecutions.get(idempotencyKey) ?? {
      status: "unknown",
      idempotency_key: idempotencyKey,
    };
  }

  createRefund(proposal, suffix) {
    const refund = {
      refund_id: `rf_${this.refunds.length + 1}`,
      order_id: proposal.target.resource_id,
      amount_minor: proposal.parameters.amount_minor,
      currency: proposal.parameters.currency,
      status: "active",
      created_at: this.clock.now(),
      synthetic_reference: suffix,
    };
    this.refunds.push(refund);
    return refund;
  }
}

export const MOCK_REFUND_IMPLEMENTATION_DIGEST =
  measureMockRefundRecoveryImplementation(MockRefundConnector.prototype);
