import { deepClone, digest } from "./canonical.js";
import { addMilliseconds, ManualClock } from "./clock.js";
import { RailError } from "./errors.js";
import {
  MockRefundConnector,
  measureMockRefundRecoveryImplementation,
} from "./mock-refund-connector.js";
import { ConsequenceRail } from "./rail.js";
import {
  createDemoSigner,
  demoConnectorTrustedKeys,
  demoRecoveryTrustedKeys,
  demoTrustedKeys,
} from "./signing.js";
import { verifyBundle } from "./verify.js";

export const DEMO_FAULTS = [
  "none",
  "duplicate",
  "lost-response-after-commit",
  "lost-response-before-commit",
  "stale-evidence",
  "remedy-failure",
  "remedy-lost-response-after-commit",
  "remedy-lost-response-before-commit",
  "post-remedy-stale-evidence",
  "post-remedy-false-evidence",
  "permit-replay",
  "action-mutation",
  "tampered-bundle",
];

export function buildRefundProposal(clock, assuranceMode = "enforced") {
  const requestedAt = clock.now();
  return {
    schema_version: "consequence-rail/action-proposal/v0.1",
    action_type: "demo.refund.issue/v1",
    subject: {
      type: "service",
      id: "support-agent-demo",
    },
    target: {
      connector: "mock-refund-processor",
      resource_type: "order",
      resource_id: "ord_demo_42",
    },
    parameters: {
      amount_minor: 12_000,
      currency: "USD",
    },
    idempotency_key: "refund:ord_demo_42:1",
    requested_at: requestedAt,
    expires_at: addMilliseconds(requestedAt, 120_000),
    assurance_mode: assuranceMode,
    postcondition: {
      op: "all",
      clauses: [
        {
          path: "active_refund_count",
          op: "eq",
          value: 1,
        },
        {
          path: "net_refunded_minor",
          op: "eq",
          value: 12_000,
        },
      ],
    },
    evidence_plan: {
      source: "mock-refund-processor",
      max_age_seconds: 60,
    },
  };
}

export function buildRefundReservation(actionDigest, proposal, clock) {
  return {
    action_digest: actionDigest,
    kind: "reverse",
    connector: "mock-refund-processor",
    capability: "void-duplicate-refund",
    capability_reference: "demo-capability:void-duplicate-refund",
    expires_at: addMilliseconds(proposal.expires_at, 300_000),
    remedy_window_seconds: 120,
    max_attempts: 1,
    max_amount_minor: proposal.parameters.amount_minor,
    idempotency_key: `remedy:${proposal.idempotency_key}:void-duplicate`,
  };
}

export function createDemoRuntime({
  assuranceMode = "enforced",
  requireRecoveryPreflight = false,
  clock = new ManualClock(),
} = {}) {
  const signer = createDemoSigner();
  const connector = new MockRefundConnector(clock);
  const rail = new ConsequenceRail({
    signer,
    clock,
    connector,
    connectorTrustedKeys: connector.trustedKeys(),
    recoveryTrustedKeys: demoRecoveryTrustedKeys(),
    requireRecoveryPreflight,
    measureRecoveryImplementation: (candidateConnector) =>
      measureMockRefundRecoveryImplementation(candidateConnector),
  });
  return {
    assuranceMode,
    clock,
    signer,
    connector,
    rail,
  };
}

export function prepareRefund(runtime) {
  const proposal = buildRefundProposal(runtime.clock, runtime.assuranceMode);
  const proposed = runtime.rail.propose(proposal);
  runtime.rail.authorize(proposed.action_id, {
    allow: true,
    policy_id: "demo-refund-policy/v1",
    policy_digest: digest({
      max_amount_minor: 25_000,
      currency: "USD",
      require_recourse: true,
    }),
    evaluation_input_digest: digest({
      amount_minor: proposal.parameters.amount_minor,
      currency: proposal.parameters.currency,
    }),
  });
  runtime.rail.reserveRecourse(
    proposed.action_id,
    buildRefundReservation(proposed.action_digest, proposal, runtime.clock),
  );
  runtime.rail.issuePermit(proposed.action_id);
  return {
    actionId: proposed.action_id,
    proposal,
  };
}

export async function runRefundDemo({ fault = "none", assuranceMode = "enforced" } = {}) {
  if (!DEMO_FAULTS.includes(fault)) {
    throw new RailError("FAULT_UNKNOWN", `Unknown demo fault: ${fault}.`);
  }

  const runtime = createDemoRuntime({ assuranceMode });
  const { actionId, proposal } = prepareRefund(runtime);
  let expectedRejection = null;

  if (fault === "action-mutation") {
    const mutated = deepClone(proposal);
    mutated.parameters.amount_minor += 1;
    try {
      await runtime.rail.execute(actionId, { proposalOverride: mutated });
    } catch (error) {
      expectedRejection = error;
    }
  } else {
    const executionFault =
      fault === "duplicate" ||
      fault === "remedy-failure" ||
      fault.startsWith("remedy-") ||
      fault.startsWith("post-remedy-") ||
      fault.startsWith("lost-response")
        ? fault
        : "none";
    const normalizedExecutionFault =
      executionFault.startsWith("remedy-") ||
      executionFault.startsWith("post-remedy-")
        ? "duplicate"
        : executionFault;
    await runtime.rail.execute(actionId, { fault: normalizedExecutionFault });
  }

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

  if (fault === "permit-replay") {
    try {
      await runtime.rail.execute(actionId);
    } catch (error) {
      expectedRejection = error;
    }
  }

  let bundle = null;
  let verification = null;
  let tamperDetection = null;
  if (view.outcome) {
    bundle = runtime.rail.exportBundle(actionId, { profile: "audit" });
    verification = verifyBundle(bundle, {
      trustedKeys: demoTrustedKeys(),
      trustedConnectorKeys: demoConnectorTrustedKeys(),
      requireSemantics: true,
    });
  }

  if (fault === "tampered-bundle" && bundle) {
    const tampered = deepClone(bundle);
    tampered.events[0].payload.action_type = "demo.refund.issue/tampered";
    try {
      verifyBundle(tampered, {
        trustedKeys: demoTrustedKeys(),
        trustedConnectorKeys: demoConnectorTrustedKeys(),
        requireSemantics: true,
      });
      tamperDetection = {
        detected: false,
        code: null,
      };
    } catch (error) {
      tamperDetection = {
        detected: true,
        code: error.code,
      };
    }
  }

  const summary = {
    scenario: "synthetic-refund",
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
    active_refunds: runtime.connector.refunds.filter((item) => item.status === "active").length,
    bundle_verification: verification?.valid ? "pass" : view.outcome ? "fail" : "not_available",
    expected_rejection: expectedRejection
      ? {
          code: expectedRejection.code,
          message: expectedRejection.message,
        }
      : null,
    tamper_detection: tamperDetection,
  };

  return {
    summary,
    bundle,
    runtime,
  };
}

export function runIrreversibleDemo() {
  const runtime = createDemoRuntime();
  const requestedAt = runtime.clock.now();
  const proposal = {
    schema_version: "consequence-rail/action-proposal/v0.1",
    action_type: "demo.email.send/v1",
    subject: {
      type: "service",
      id: "communications-agent-demo",
    },
    target: {
      connector: "mock-email-sender",
      resource_type: "message",
      resource_id: "msg_demo_1",
    },
    parameters: {
      recipient_id: "recipient_demo",
      subject: "Synthetic message",
    },
    idempotency_key: "email:msg_demo_1:1",
    requested_at: requestedAt,
    expires_at: addMilliseconds(requestedAt, 120_000),
    assurance_mode: "enforced",
    postcondition: {
      op: "all",
      clauses: [
        {
          path: "delivered",
          op: "eq",
          value: true,
        },
      ],
    },
    evidence_plan: {
      source: "mock-email-sender",
      max_age_seconds: 60,
    },
  };
  const proposed = runtime.rail.propose(proposal);
  runtime.rail.authorize(proposed.action_id, {
    allow: true,
    policy_id: "demo-email-policy/v1",
    policy_digest: digest({ allow_synthetic_email: true }),
  });

  try {
    runtime.rail.reserveRecourse(proposed.action_id, {
      action_digest: proposed.action_digest,
      kind: "reverse",
      connector: "mock-email-sender",
      capability: "unsend-email",
      expires_at: addMilliseconds(proposal.expires_at, 300_000),
      remedy_window_seconds: 120,
      max_attempts: 1,
      idempotency_key: "remedy:email:msg_demo_1:unsend",
    });
    return {
      scenario: "irreversible-email",
      admitted: true,
      code: null,
    };
  } catch (error) {
    return {
      scenario: "irreversible-email",
      admitted: false,
      code: error.code,
      reason: "No connector-backed, bounded remedy capability was available.",
    };
  }
}
