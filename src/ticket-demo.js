import { digest } from "./canonical.js";
import { DEMO_TICKET_COMMENT_CLASS } from "./action-classes.js";
import { addMilliseconds, ManualClock } from "./clock.js";
import { RailError } from "./errors.js";
import { INVENTORY_DEMO_FAULTS } from "./inventory-demo.js";
import { MockTicketConnector } from "./mock-ticket-connector.js";
import { ConsequenceRail } from "./rail.js";
import {
  createDemoSigner,
  demoConnectorTrustedKeys,
  demoRecoveryTrustedKeys,
  demoTrustedKeys,
} from "./signing.js";
import { verifyBundle } from "./verify.js";

// The ticket scenario runs the same ten faults as the inventory scenario.
export const TICKET_DEMO_FAULTS = [...INVENTORY_DEMO_FAULTS];

/**
 * A v0.3 proposal for a registered non-money action class. recourse_scope and
 * parameter_bindings repeat the class so an offline verifier can check the
 * bundle without the rail's registry.
 */
export function buildTicketProposal(clock, assuranceMode = "enforced") {
  const requestedAt = clock.now();
  return {
    schema_version: "consequence-rail/action-proposal/v0.3",
    action_type: DEMO_TICKET_COMMENT_CLASS.action_type,
    subject: { type: "agent", id: "support-agent-demo" },
    target: {
      connector: "mock-ticket-service",
      resource_type: "ticket",
      resource_id: "tkt_demo_42",
    },
    parameters: {
      body: "We have refunded the duplicate charge. It should reach you in 3 to 5 days.",
      visibility: "public",
    },
    idempotency_key: "comment:tkt_demo_42:1",
    requested_at: requestedAt,
    expires_at: addMilliseconds(requestedAt, 120_000),
    assurance_mode: assuranceMode,
    postcondition: {
      op: "all",
      clauses: [
        { path: "comment_count", op: "eq", value: 1 },
        { path: "body_matches", op: "eq", value: true },
      ],
    },
    evidence_plan: {
      source: "mock-ticket-service",
      max_age_seconds: 60,
      parameter_bindings: [{ fact: "visibility", parameter: "visibility" }],
    },
    recourse_scope: { field: "max_quantity", covers_parameter: null },
  };
}

export function buildTicketReservation(actionDigest, proposal) {
  return {
    action_digest: actionDigest,
    kind: "reverse",
    connector: "mock-ticket-service",
    capability: "delete-comment",
    capability_reference: "demo-capability:delete-comment",
    expires_at: addMilliseconds(proposal.expires_at, 300_000),
    remedy_window_seconds: 120,
    max_attempts: 1,
    max_quantity: 1,
    idempotency_key: `remedy:${proposal.idempotency_key}:delete`,
  };
}

export function createTicketRuntime({
  assuranceMode = "enforced",
  clock = new ManualClock(),
  signer = createDemoSigner(),
  connector = new MockTicketConnector(clock),
  createEventStore,
  permitLedger,
} = {}) {
  const eventStore = createEventStore ? createEventStore(signer, clock) : undefined;
  const rail = new ConsequenceRail({
    eventStore,
    permitLedger,
    signer,
    clock,
    connector,
    connectorTrustedKeys: connector.trustedKeys(),
    recoveryTrustedKeys: demoRecoveryTrustedKeys(),
    actionClasses: [DEMO_TICKET_COMMENT_CLASS],
    requireSimulation: true,
  });
  return { clock, signer, connector, rail, assuranceMode, eventStore };
}

export async function prepareTicket(runtime) {
  const proposal = buildTicketProposal(runtime.clock, runtime.assuranceMode);
  const proposed = runtime.rail.propose(proposal);
  runtime.rail.authorize(proposed.action_id, {
    allow: true,
    policy_id: "demo-ticket-comment-gate/v1",
    policy_digest: digest({ max_body_length: 2_000, require_recourse: true }),
    evaluation_input_digest: digest({ visibility: proposal.parameters.visibility }),
  });
  runtime.rail.reserveRecourse(proposed.action_id, buildTicketReservation(proposed.action_digest, proposal));
  await runtime.rail.simulate(proposed.action_id);
  runtime.rail.issuePermit(proposed.action_id);
  return { actionId: proposed.action_id, proposal };
}

/**
 * Bounded synthetic ticket-comment scenario: post a comment, detect a
 * duplicate post, delete only the extra comment this action created, and
 * close with a signed v0.3 receipt. Unknown outcomes reconcile instead of
 * retrying.
 */
export async function runTicketDemo({ fault = "none", assuranceMode = "enforced" } = {}) {
  if (!TICKET_DEMO_FAULTS.includes(fault)) {
    throw new RailError(
      "FAULT_UNKNOWN",
      `Unknown demo fault: ${fault}. Expected one of: ${TICKET_DEMO_FAULTS.join(", ")}.`,
    );
  }
  const runtime = createTicketRuntime({ assuranceMode });
  const { actionId } = await prepareTicket(runtime);

  const remedyPhase = fault.startsWith("remedy-") || fault.startsWith("post-remedy-");
  await runtime.rail.execute(actionId, {
    fault: remedyPhase ? "duplicate" : ["duplicate", "lost-response-before-commit", "lost-response-after-commit"].includes(fault) ? fault : "none",
  });
  let view = runtime.rail.inspect(actionId);
  if (view.state === "UNKNOWN") {
    await runtime.rail.reconcile(actionId);
    view = runtime.rail.inspect(actionId);
  }
  if (view.state === "EXECUTED") {
    await runtime.rail.verifyOutcome(actionId, { fault: fault === "stale-evidence" ? fault : "none" });
    view = runtime.rail.inspect(actionId);
  }
  if (view.state === "REMEDY_DUE") {
    await runtime.rail.remediate(actionId, { fault: remedyPhase ? fault : "none" });
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
  const active = runtime.connector.comments.filter((comment) => comment.status === "active");
  const summary = {
    scenario: "synthetic-ticket-comment",
    fault,
    action_id: actionId,
    action_type: DEMO_TICKET_COMMENT_CLASS.action_type,
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
    active_comments: active.length,
    deleted_comments: runtime.connector.comments.length - active.length,
    bundle_verification: verification?.valid ? "pass" : view.outcome ? "fail" : "not_available",
  };
  return { summary, bundle, runtime };
}
