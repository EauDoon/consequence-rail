import { deepClone, digest } from "./canonical.js";
import { addMilliseconds, ManualClock } from "./clock.js";
import { RailError } from "./errors.js";
import {
  MockInventoryConnector,
  measureMockInventoryRecoveryImplementation,
} from "./mock-inventory-connector.js";
import { ConsequenceRail } from "./rail.js";
import {
  createDemoSigner,
  demoConnectorTrustedKeys,
  demoRecoveryTrustedKeys,
  demoTrustedKeys,
} from "./signing.js";
import { verifyBundle } from "./verify.js";

export const INVENTORY_DEMO_FAULTS = [
  "none",
  "duplicate",
  "remedy-failure",
  "remedy-lost-response-before-commit",
  "remedy-lost-response-after-commit",
  "post-remedy-stale-evidence",
  "post-remedy-false-evidence",
  "lost-response-before-commit",
  "lost-response-after-commit",
  "stale-evidence",
];

export function buildInventoryProposal(clock, assuranceMode = "enforced") {
  const requestedAt = clock.now();
  return {
    schema_version: "consequence-rail/action-proposal/v0.1",
    action_type: "demo.inventory.allocate/v1",
    subject: {
      type: "service",
      id: "allocation-agent-demo",
    },
    target: {
      connector: "mock-inventory-service",
      resource_type: "order",
      resource_id: "ord_inventory_7",
    },
    parameters: {
      sku: "sku_demo_1",
      quantity: 4,
    },
    idempotency_key: "allocate:ord_inventory_7:1",
    requested_at: requestedAt,
    expires_at: addMilliseconds(requestedAt, 120_000),
    assurance_mode: assuranceMode,
    postcondition: {
      op: "all",
      clauses: [
        {
          path: "allocation_count",
          op: "eq",
          value: 1,
        },
        {
          path: "allocated_quantity",
          op: "eq",
          value: 4,
        },
        {
          path: "inventory_on_hand",
          op: "gte",
          value: 0,
        },
      ],
    },
    evidence_plan: {
      source: "mock-inventory-service",
      max_age_seconds: 60,
    },
  };
}

export function buildInventoryReservation(actionDigest, proposal, clock) {
  return {
    action_digest: actionDigest,
    kind: "reverse",
    connector: "mock-inventory-service",
    capability: "release-allocation",
    capability_reference: "demo-capability:release-allocation",
    expires_at: addMilliseconds(proposal.expires_at, 300_000),
    remedy_window_seconds: 120,
    max_attempts: 1,
    max_quantity: proposal.parameters.quantity,
    idempotency_key: `remedy:${proposal.idempotency_key}:release`,
  };
}

export function createInventoryRuntime({
  assuranceMode = "enforced",
  clock = new ManualClock(),
} = {}) {
  const signer = createDemoSigner();
  const connector = new MockInventoryConnector(clock);
  const rail = new ConsequenceRail({
    signer,
    clock,
    connector,
    connectorTrustedKeys: connector.trustedKeys(),
    recoveryTrustedKeys: demoRecoveryTrustedKeys(),
    requireRecoveryPreflight: false,
    measureRecoveryImplementation: (candidateConnector) =>
      measureMockInventoryRecoveryImplementation(candidateConnector),
  });
  return { clock, signer, connector, rail, assuranceMode };
}

export function prepareInventory(runtime) {
  const proposal = buildInventoryProposal(runtime.clock, runtime.assuranceMode);
  const proposed = runtime.rail.propose(proposal);
  runtime.rail.authorize(proposed.action_id, {
    allow: true,
    policy_id: "demo-inventory-gate/v1",
    policy_digest: digest({
      sku: proposal.parameters.sku,
      max_quantity: 10,
      require_recourse: true,
    }),
    evaluation_input_digest: digest({
      sku: proposal.parameters.sku,
      quantity: proposal.parameters.quantity,
    }),
  });
  runtime.rail.reserveRecourse(
    proposed.action_id,
    buildInventoryReservation(proposed.action_digest, proposal, runtime.clock),
  );
  runtime.rail.issuePermit(proposed.action_id);
  return { actionId: proposed.action_id, proposal };
}

/**
 * Bounded synthetic inventory-allocation scenario: allocate, detect a broken
 * allocation invariant, reverse only the allocation bound to this action, and
 * close with a signed receipt. Unknown outcomes reconcile instead of retrying.
 */
export async function runInventoryDemo({ fault = "none", assuranceMode = "enforced" } = {}) {
  if (!INVENTORY_DEMO_FAULTS.includes(fault)) {
    throw new RailError(
      "FAULT_UNKNOWN",
      `Unknown demo fault: ${fault}. Expected one of: ${INVENTORY_DEMO_FAULTS.join(", ")}.`,
    );
  }

  const runtime = createInventoryRuntime({ assuranceMode });
  const { actionId } = prepareInventory(runtime);

  const executionFault =
    fault === "duplicate" ||
    fault === "remedy-failure" ||
    fault.startsWith("remedy-") ||
    fault.startsWith("post-remedy-") ||
    fault.startsWith("lost-response")
      ? fault
      : "none";
  const normalizedExecutionFault =
    executionFault.startsWith("remedy-") || executionFault.startsWith("post-remedy-")
      ? "duplicate"
      : executionFault;
  await runtime.rail.execute(actionId, { fault: normalizedExecutionFault });

  let view = runtime.rail.inspect(actionId);
  if (view.state === "UNKNOWN") {
    await runtime.rail.reconcile(actionId);
    view = runtime.rail.inspect(actionId);
  }

  if (view.state === "EXECUTED") {
    await runtime.rail.verifyOutcome(actionId, {
      fault: fault === "stale-evidence" ? "stale-evidence" : "none",
    });
    view = runtime.rail.inspect(actionId);
  }

  if (view.state === "REMEDY_DUE") {
    await runtime.rail.remediate(actionId, {
      fault:
        fault === "remedy-failure" ||
        fault.startsWith("remedy-lost-response") ||
        fault.startsWith("post-remedy-")
          ? fault
          : "none",
    });
    view = runtime.rail.inspect(actionId);
  }

  if (view.state === "REMEDY_UNKNOWN") {
    await runtime.rail.reconcileRemedy(actionId);
    view = runtime.rail.inspect(actionId);
  }

  let bundle = null;
  let verification = null;
  if (view.outcome) {
    bundle = runtime.rail.exportBundle(actionId, { profile: "audit" });
    verification = verifyBundle(bundle, {
      trustedKeys: demoTrustedKeys(),
      trustedConnectorKeys: demoConnectorTrustedKeys(),
      requireSemantics: true,
    });
  }

  const summary = {
    scenario: "synthetic-inventory-allocation",
    fault,
    action_id: actionId,
    state: view.state,
    outcome: view.outcome,
    assurance_mode: view.assurance_mode,
    bypass_possible: view.bypass_possible,
    execute_calls: runtime.connector.executeCalls,
    status_calls: runtime.connector.statusCalls,
    recourse_reservation_calls: runtime.connector.reserveRecourseCalls,
    recourse_status_calls: runtime.connector.recourseStatusCalls,
    remedy_calls: runtime.connector.remedyCalls,
    remedy_status_calls: runtime.connector.remedyStatusCalls,
    active_allocations: runtime.connector.allocations.filter((item) => item.status === "active").length,
    allocated_quantity: runtime.connector.allocations
      .filter((item) => item.status === "active")
      .reduce((total, item) => total + item.quantity, 0),
    inventory_on_hand: runtime.connector.inventory.get("sku_demo_1") ?? 0,
    bundle_verification: verification?.valid ? "pass" : view.outcome ? "fail" : "not_available",
  };

  return { summary, bundle, runtime };
}
