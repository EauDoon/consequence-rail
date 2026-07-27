import { deepClone, digest } from "./canonical.js";
import {
  MOCK_REFUND_IMPLEMENTATION_DIGEST,
  MockRefundConnector,
  measureMockRefundRecoveryImplementation,
} from "./mock-refund-connector.js";

const SUPPORTED_DRILL_FAULTS = new Set([
  "none",
  "missing-checkpoint",
  "corrupt-checkpoint",
  "fault-not-observed",
  "remedy-failure",
  "not-testable-local",
  "out-of-scope",
]);

const EXPECTED_FAULT = {
  kind: "connector-fault-injection",
  version: "1",
  parameters: { fault: "duplicate" },
};
const EXPECTED_PROCEDURE = {
  kind: "connector-reserved-remedy",
  version: "1",
  parameters: { capability: "void-duplicate-refund" },
};
const EXPECTED_ORACLE = {
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
};

function operationMatches(actual, expected) {
  return digest(actual) === digest(expected);
}

function observedState(evidence, paths) {
  const state = {};
  for (const path of paths) {
    let current = evidence;
    for (const segment of path.split(".")) {
      if (
        ["__proto__", "constructor", "prototype"].includes(segment) ||
        !current ||
        typeof current !== "object" ||
        !Object.hasOwn(current, segment)
      ) {
        current = undefined;
        break;
      }
      current = current[segment];
    }
    state[path] = deepClone(current);
  }
  return state;
}

function notTestable(note) {
  return {
    local_testable: false,
    checkpoint_reference_digest: null,
    baseline_state: null,
    checkpoint_state: null,
    damaged_state: null,
    recovered_state: null,
    fault_observed: false,
    recovery_attempted: false,
    oracle_satisfied: false,
    notes: [note],
  };
}

export class MockRefundRecoveryAdapter {
  constructor(clock, { drillFault = "none" } = {}) {
    this.id = "mock-refund-recovery";
    this.version = "1";
    this.clock = clock;
    this.drillFault = drillFault;
    this.implementationDigest =
      MOCK_REFUND_RECOVERY_ADAPTER_IMPLEMENTATION_DIGEST;
  }

  async run(contract) {
    if (!SUPPORTED_DRILL_FAULTS.has(this.drillFault)) {
      return notTestable("DRILL_FAULT_UNSUPPORTED");
    }
    if (this.drillFault === "not-testable-local") {
      return notTestable("LOCAL_ADAPTER_UNAVAILABLE");
    }

    const proposal = deepClone(contract.fixture.configuration.proposal);
    if (
      this.drillFault === "out-of-scope" ||
      contract.fixture.fidelity !== "synthetic" ||
      proposal?.action_type !== contract.action_class ||
      digest(proposal) !== contract.action_digest ||
      proposal?.target?.connector !== contract.scope.connector ||
      proposal?.target?.resource_type !== contract.scope.resource_type ||
      proposal?.assurance_mode !== contract.scope.assurance_mode ||
      !proposal?.parameters ||
      !proposal?.postcondition ||
      !proposal?.evidence_plan ||
      digest(proposal?.parameters) !== contract.scope.parameters_digest ||
      digest(proposal?.postcondition) !== contract.scope.postcondition_digest ||
      digest(proposal?.evidence_plan) !== contract.scope.evidence_plan_digest ||
      contract.recourse.kind !== "reverse" ||
      contract.recourse.capability !== "void-duplicate-refund" ||
      contract.recourse.implementation_digest !==
        MOCK_REFUND_IMPLEMENTATION_DIGEST ||
      contract.fixture.adapter_implementation_digest !==
        this.implementationDigest ||
      !operationMatches(contract.fault, EXPECTED_FAULT) ||
      !operationMatches(contract.procedure, EXPECTED_PROCEDURE) ||
      !operationMatches(contract.oracle, EXPECTED_ORACLE)
    ) {
      return notTestable("CONTRACT_OUTSIDE_ADAPTER_SCOPE");
    }

    const actionDigest = digest(proposal);
    const controlConnector = new MockRefundConnector(this.clock);
    if (
      measureMockRefundRecoveryImplementation(controlConnector) !==
      contract.recourse.implementation_digest
    ) {
      return notTestable("IMPLEMENTATION_BINDING_MISMATCH");
    }
    await controlConnector.execute(
      proposal,
      `${proposal.idempotency_key}:preflight-control`,
      "none",
    );
    const baselineEvidence = await controlConnector.observe(proposal, {
      actionDigest,
    });
    const oraclePaths = contract.oracle.parameters.paths;
    const baselineState = observedState(baselineEvidence, oraclePaths);
    const checkpointReferenceDigest = contract.fixture.checkpoint_digest;

    let checkpointState = deepClone(baselineState);
    if (this.drillFault === "missing-checkpoint") {
      checkpointState = null;
    } else if (this.drillFault === "corrupt-checkpoint") {
      checkpointState["facts.active_refund_count"] += 100;
    }

    const fixtureConnector = new MockRefundConnector(this.clock);
    const request = deepClone(contract.fixture.configuration.recourse_request);
    if (
      request.action_digest !== actionDigest ||
      request.kind !== contract.recourse.kind ||
      request.connector !== contract.scope.connector ||
      request.capability !== contract.recourse.capability ||
      digest(request.capability_reference) !==
        contract.recourse.capability_reference_digest
    ) {
      return notTestable("RECOURSE_BINDING_MISMATCH");
    }
    const connectorCommitment = fixtureConnector.reserveRecourse(
      proposal,
      request,
    );
    if (
      digest(connectorCommitment) !==
      contract.recourse.connector_commitment_digest
    ) {
      return notTestable("CONNECTOR_COMMITMENT_BINDING_MISMATCH");
    }
    const reservation = {
      ...request,
      connector_commitment: connectorCommitment,
    };

    await fixtureConnector.execute(
      proposal,
      `${proposal.idempotency_key}:preflight-fixture`,
      this.drillFault === "fault-not-observed"
        ? "none"
        : contract.fault.parameters.fault,
    );
    const damagedEvidence = await fixtureConnector.observe(proposal, {
      actionDigest,
    });
    const damagedState = observedState(damagedEvidence, oraclePaths);
    const faultObserved = digest(damagedState) !== digest(baselineState);

    await fixtureConnector.remediate(
      proposal,
      reservation,
      `${proposal.idempotency_key}:preflight-remedy`,
      this.drillFault === "remedy-failure" ? "remedy-failure" : "none",
    );
    const recoveredEvidence = await fixtureConnector.observe(proposal, {
      actionDigest,
    });
    const recoveredState = observedState(recoveredEvidence, oraclePaths);
    const oracleSatisfied = digest(recoveredState) === digest(baselineState);

    return {
      local_testable: true,
      checkpoint_reference_digest: checkpointReferenceDigest,
      baseline_state: baselineState,
      checkpoint_state: checkpointState,
      damaged_state: damagedState,
      recovered_state: recoveredState,
      fault_observed: faultObserved,
      recovery_attempted: true,
      oracle_satisfied: oracleSatisfied,
      notes: [
        "ISOLATED_SYNTHETIC_CONNECTOR",
        "EXACT_ONLY_WITHIN_DECLARED_EVIDENCE_SURFACE",
      ],
    };
  }
}

export function measureMockRefundRecoveryAdapterImplementation(
  run = MockRefundRecoveryAdapter.prototype.run,
) {
  if (typeof run !== "function") {
    return null;
  }
  return digest({
    adapter: "mock-refund-recovery",
    version: "1",
    measurement_profile: "callable-source/v2",
    class_source: Function.prototype.toString.call(MockRefundRecoveryAdapter),
    live_run_source: Function.prototype.toString.call(run),
    observed_state_source: Function.prototype.toString.call(observedState),
    operation_match_source: Function.prototype.toString.call(operationMatches),
    expected_fault: EXPECTED_FAULT,
    expected_procedure: EXPECTED_PROCEDURE,
    expected_oracle: EXPECTED_ORACLE,
  });
}

export const MOCK_REFUND_RECOVERY_ADAPTER_IMPLEMENTATION_DIGEST =
  measureMockRefundRecoveryAdapterImplementation();
