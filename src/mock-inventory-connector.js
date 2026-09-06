import { digest } from "./canonical.js";
import { UnknownExecutionError, UnknownRemedyError, RailError } from "./errors.js";
import { createDemoConnectorSigner, signArtifact } from "./signing.js";

/**
 * Bounded synthetic inventory-allocation connector.
 *
 * It allocates a declared quantity of one synthetic SKU to one synthetic
 * order, and its pre-reserved remedy releases only the allocation bound to
 * the action that created it. Inventory is never allowed to go negative, an
 * allocation is never released twice, and an allocation belonging to another
 * order is never released. Nothing here talks to a real warehouse, merchant,
 * payment system, or inventory service.
 */

const RECOVERY_METHODS = [
  "reserveRecourse",
  "recourseStatus",
  "releaseRecourse",
  "execute",
  "status",
  "observe",
  "remediate",
  "remedyStatus",
  "createAllocation",
];

export function measureMockInventoryRecoveryImplementation(connector) {
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
    connector: "mock-inventory-service",
    capability: "release-allocation",
    measurement_profile: "callable-source/v1",
    methods,
  });
}

export class MockInventoryConnector {
  constructor(clock, { signer = createDemoConnectorSigner(), onHand = 25 } = {}) {
    this.clock = clock;
    this.signer = signer;
    this.allocations = [];
    this.inventory = new Map([["sku_demo_1", onHand]]);
    this.onHandBaseline = onHand;
    this.executions = new Map();
    this.executionAllocations = new Map();
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
      connector: "mock-inventory-service",
      exclusive_credential_custody: this.exclusiveCredentialCustody,
      actions: ["demo.inventory.allocate/v1"],
      remedies: ["release-allocation"],
      connector_signing_key_id: this.signer.kid,
    };
  }

  trustedKeys() {
    return new Map([[this.signer.kid, this.signer.publicKey]]);
  }

  reserveRecourse(proposal, request) {
    this.reserveRecourseCalls += 1;
    if (
      request.capability !== "release-allocation" ||
      request.connector !== "mock-inventory-service"
    ) {
      throw new RailError("RECOURSE_UNAVAILABLE", "The connector cannot reserve the requested remedy.");
    }
    if (proposal.action_type !== "demo.inventory.allocate/v1") {
      throw new RailError("RECOURSE_UNAVAILABLE", "The connector only reserves allocation remedies for allocation actions.");
    }
    if (!Number.isSafeInteger(request.max_quantity) || !Number.isSafeInteger(proposal.parameters.quantity)) {
      throw new RailError("RECOURSE_SCOPE_INSUFFICIENT", "The allocation remedy requires integer quantities.");
    }
    if (request.max_quantity < proposal.parameters.quantity) {
      throw new RailError("RECOURSE_SCOPE_INSUFFICIENT", "The requested remedy scope is insufficient.");
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
      connector: "mock-inventory-service",
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

  createAllocation(proposal, suffix) {
    const quantity = proposal.parameters.quantity;
    const available = this.inventory.get(proposal.parameters.sku) ?? 0;
    if (quantity > available) {
      throw new RailError("INVENTORY_INSUFFICIENT", "The requested quantity exceeds available inventory.");
    }
    this.inventory.set(proposal.parameters.sku, available - quantity);
    const allocation = {
      allocation_id: `alloc_${digest(`${proposal.target.resource_id}:${suffix}`).slice(0, 20)}`,
      order_id: proposal.target.resource_id,
      sku: proposal.parameters.sku,
      quantity,
      status: "active",
    };
    this.allocations.push(allocation);
    return allocation;
  }

  recordAllocation(idempotencyKey, allocationId) {
    const tracked = this.executionAllocations.get(idempotencyKey) ?? [];
    tracked.push(allocationId);
    this.executionAllocations.set(idempotencyKey, tracked);
  }

  async execute(proposal, idempotencyKey, fault = "none") {
    this.executeCalls += 1;
    if (this.executions.has(idempotencyKey)) {
      return this.executions.get(idempotencyKey);
    }
    if (fault === "lost-response-before-commit") {
      this.executions.set(idempotencyKey, { status: "no_effect", idempotency_key: idempotencyKey });
      throw new UnknownExecutionError("The connector response was lost before an external effect was confirmed.", {
        idempotency_key: idempotencyKey,
      });
    }
    const allocation = this.createAllocation(proposal, `${idempotencyKey}:primary`);
    this.recordAllocation(idempotencyKey, allocation.allocation_id);
    const result = {
      status: "executed",
      external_id: allocation.allocation_id,
      idempotency_key: idempotencyKey,
    };
    this.executions.set(idempotencyKey, result);
    // The duplicate fault allocates the declared quantity a second time, which
    // breaks the allocation invariant; the bounded remedy releases only the
    // allocation bound to this action.
    if (fault === "duplicate" || fault === "remedy-failure") {
      const duplicate = this.createAllocation(proposal, `${idempotencyKey}:duplicate`);
      this.recordAllocation(idempotencyKey, duplicate.allocation_id);
    }
    if (fault === "lost-response-after-commit") {
      throw new UnknownExecutionError("The connector response was lost after the external effect.", {
        external_id: allocation.allocation_id,
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
    const active = this.allocations.filter(
      (allocation) =>
        allocation.order_id === proposal.target.resource_id && allocation.status === "active",
    );
    const observedAt =
      options.fault === "stale-evidence" || options.fault === "post-remedy-stale-evidence"
        ? new Date(new Date(this.clock.now()).getTime() - 3_600_000).toISOString()
        : this.clock.now();
    const falseOffset = options.fault === "post-remedy-false-evidence" ? 1 : 0;
    return {
      schema_version: "consequence-rail/outcome-evidence/v0.1",
      action_digest: options.actionDigest,
      source: "mock-inventory-service",
      resource: { type: "order", id: proposal.target.resource_id },
      observed_at: observedAt,
      facts: {
        allocation_count: active.length + falseOffset,
        allocated_quantity:
          active.reduce((total, allocation) => total + allocation.quantity, 0) +
          falseOffset * proposal.parameters.quantity,
        inventory_on_hand: this.inventory.get(proposal.parameters.sku) ?? 0,
        sku: proposal.parameters.sku,
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
      const result = { status: "no_effect", idempotency_key: idempotencyKey };
      this.remedyExecutions.set(idempotencyKey, result);
      throw new UnknownRemedyError("The remedy response was lost before an effect was confirmed.", {
        idempotency_key: idempotencyKey,
      });
    }
    if (fault === "remedy-failure") {
      const result = { status: "failed", idempotency_key: idempotencyKey };
      this.remedyExecutions.set(idempotencyKey, result);
      return result;
    }

    // Choose the allocation to release: only allocations this action created,
    // for this order, that are still active. With more than one (the duplicate
    // fault) the extra allocation is released so the action's own allocation,
    // which the receipt records, stays live.
    const tracked = this.executionAllocations.get(proposal.idempotency_key) ?? [];
    const candidates = tracked
      .map((allocationId) => this.allocations.find((item) => item.allocation_id === allocationId))
      .filter(
        (allocation) =>
          allocation !== undefined &&
          allocation.status === "active" &&
          allocation.order_id === proposal.target.resource_id,
      );
    const bound = candidates.length > 1 ? candidates[candidates.length - 1] : candidates[0];
    if (!bound) {
      const result = { status: "failed", idempotency_key: idempotencyKey };
      this.remedyExecutions.set(idempotencyKey, result);
      return result;
    }
    bound.status = "released";
    this.inventory.set(bound.sku, (this.inventory.get(bound.sku) ?? 0) + bound.quantity);
    const result = {
      status: "remediated",
      external_id: bound.allocation_id,
      idempotency_key: idempotencyKey,
    };
    this.remedyExecutions.set(idempotencyKey, result);
    if (fault === "remedy-lost-response-after-commit") {
      throw new UnknownRemedyError("The remedy response was lost after the external effect.", {
        external_id: bound.allocation_id,
        idempotency_key: idempotencyKey,
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
}
