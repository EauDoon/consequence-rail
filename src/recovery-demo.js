import { digest } from "./canonical.js";
import { addMilliseconds, ManualClock } from "./clock.js";
import {
  buildRefundProposal,
  buildRefundReservation,
  createDemoRuntime,
} from "./demo.js";
import {
  MOCK_REFUND_RECOVERY_ADAPTER_IMPLEMENTATION_DIGEST,
  MockRefundRecoveryAdapter,
} from "./mock-refund-recovery-adapter.js";
import { MOCK_REFUND_IMPLEMENTATION_DIGEST } from "./mock-refund-connector.js";
import {
  runRecoveryPreflight,
  verifyRecoveryPreflight,
} from "./recovery-preflight.js";
import {
  createDemoRecoverySigner,
  demoRecoveryTrustedKeys,
} from "./signing.js";

export const RECOVERY_DEMO_FAULTS = [
  "none",
  "missing-checkpoint",
  "corrupt-checkpoint",
  "fault-not-observed",
  "remedy-failure",
  "not-testable-local",
  "out-of-scope",
];

function prepareBoundReservation(clock, proposal) {
  const runtime = createDemoRuntime({ clock });
  const proposed = runtime.rail.propose(proposal);
  runtime.rail.authorize(proposed.action_id, {
    allow: true,
    policy_id: "demo-recovery-contract-builder/v1",
    policy_digest: digest({ allow: true }),
  });
  const request = buildRefundReservation(
    proposed.action_digest,
    proposal,
    clock,
  );
  runtime.rail.reserveRecourse(proposed.action_id, request);
  return {
    request,
    reservation: runtime.rail.get(proposed.action_id).reservation,
  };
}

function expectedRefundCheckpoint(proposal) {
  return {
    source: "mock-refund-processor",
    "resource.type": "order",
    "resource.id": proposal.target.resource_id,
    "facts.active_refund_count": 1,
    "facts.net_refunded_minor": proposal.parameters.amount_minor,
    "facts.currency": proposal.parameters.currency,
  };
}

export function buildRefundRecoveryContract(
  clock,
  { proposal: suppliedProposal = null, reservation = null, recourseRequest = null } = {},
) {
  const issuedAt = clock.now();
  const proposal = suppliedProposal ?? buildRefundProposal(clock, "enforced");
  const binding = reservation && recourseRequest
    ? { reservation, request: recourseRequest }
    : prepareBoundReservation(clock, proposal);
  return {
    schema_version: "consequence-rail/recovery-contract/v0.1",
    contract_id: "demo-refund-duplicate-recovery/v1",
    action_digest: digest(proposal),
    action_class: "demo.refund.issue/v1",
    scope: {
      connector: proposal.target.connector,
      resource_type: proposal.target.resource_type,
      assurance_mode: proposal.assurance_mode,
      parameters_digest: digest(proposal.parameters),
      postcondition_digest: digest(proposal.postcondition),
      evidence_plan_digest: digest(proposal.evidence_plan),
    },
    recourse: {
      kind: "reverse",
      capability: "void-duplicate-refund",
      implementation_digest: MOCK_REFUND_IMPLEMENTATION_DIGEST,
      reservation_digest: digest(binding.reservation),
      capability_reference_digest:
        binding.reservation.capability_reference_digest,
      connector_commitment_digest: digest(
        binding.reservation.connector_commitment,
      ),
    },
    recovery_class: "exact",
    fixture: {
      adapter: "mock-refund-recovery",
      adapter_version: "1",
      adapter_implementation_digest:
        MOCK_REFUND_RECOVERY_ADAPTER_IMPLEMENTATION_DIGEST,
      checkpoint_digest: digest(expectedRefundCheckpoint(proposal)),
      fidelity: "synthetic",
      configuration: {
        proposal,
        recourse_request: binding.request,
      },
    },
    fault: {
      kind: "connector-fault-injection",
      version: "1",
      parameters: {
        fault: "duplicate",
      },
    },
    procedure: {
      kind: "connector-reserved-remedy",
      version: "1",
      parameters: {
        capability: "void-duplicate-refund",
      },
    },
    oracle: {
      kind: "exact-state-digest",
      version: "1",
      parameters: {
        paths: [
          "source",
          "resource.type",
          "resource.id",
          "facts.active_refund_count",
          "facts.net_refunded_minor",
          "facts.currency",
        ],
      },
    },
    issued_at: issuedAt,
    expires_at: addMilliseconds(issuedAt, 86_400_000),
    max_attestation_age_seconds: 300,
  };
}

export async function runRecoveryPreflightDemo({
  fault = "none",
  clock = new ManualClock(),
} = {}) {
  const runtime = createDemoRuntime({
    clock,
    requireRecoveryPreflight: true,
  });
  const proposal = buildRefundProposal(clock, "enforced");
  const proposed = runtime.rail.propose(proposal);
  runtime.rail.authorize(proposed.action_id, {
    allow: true,
    policy_id: "demo-recovery-preflight-policy/v1",
    policy_digest: digest({ require_recovery_preflight: true }),
  });
  const recourseRequest = buildRefundReservation(
    proposed.action_digest,
    proposal,
    clock,
  );
  runtime.rail.reserveRecourse(
    proposed.action_id,
    recourseRequest,
  );
  let permitWithoutPreflight = "unexpectedly-issued";
  try {
    runtime.rail.issuePermit(proposed.action_id);
  } catch (error) {
    permitWithoutPreflight = error.code === "RECOVERY_PREFLIGHT_REQUIRED"
      ? "refused"
      : `error:${error.code ?? "unknown"}`;
  }
  const reservation = runtime.rail.get(proposed.action_id).reservation;
  const signer = createDemoRecoverySigner();
  const contract = buildRefundRecoveryContract(clock, {
    reservation,
    recourseRequest,
  });
  const adapter = new MockRefundRecoveryAdapter(clock, { drillFault: fault });
  const bundle = await runRecoveryPreflight({
    contract,
    adapter,
    signer,
    clock,
  });
  const verification = verifyRecoveryPreflight(bundle, {
    trustedKeys: demoRecoveryTrustedKeys(),
    now: clock.now(),
    requireCurrent: true,
  });
  let permitAfterPreflight = "refused";
  try {
    runtime.rail.acceptRecoveryQualification(proposed.action_id, bundle);
    runtime.rail.issuePermit(proposed.action_id);
    permitAfterPreflight = "issued";
  } catch (error) {
    permitAfterPreflight = `refused:${error.code ?? "unknown"}`;
  }
  return {
    bundle,
    runtime,
    verification,
    summary: {
      scenario: "synthetic-refund-recovery-preflight",
      fault,
      fixture_fidelity: bundle.drill_attestation.fixture_fidelity,
      recovery_class: bundle.drill_attestation.recovery_class,
      qualification: bundle.drill_attestation.qualification,
      bundle_verification: verification.valid ? "pass" : "fail",
      permit_without_preflight: permitWithoutPreflight,
      permit_after_preflight: permitAfterPreflight,
      live_connector_execute_calls: runtime.connector.executeCalls,
      live_connector_remedy_calls: runtime.connector.remedyCalls,
      production_recovery_claimed: false,
    },
  };
}
