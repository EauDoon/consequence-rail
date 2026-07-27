import { deepClone, deepFreeze, digest } from "./canonical.js";
import { RailError } from "./errors.js";
import { measureMockRefundRecoveryAdapterImplementation } from "./mock-refund-recovery-adapter.js";
import { signArtifact, verifyArtifact } from "./signing.js";

export const RECOVERY_QUALIFICATIONS = [
  "QUALIFIED_EXACT",
  "REVIEW_COMPENSATED",
  "NOT_QUALIFIED",
  "NOT_TESTABLE_LOCAL",
];

const RECOVERY_CLASSES = ["exact", "compensation", "containment", "escalation"];
const FIXTURE_FIDELITIES = ["synthetic", "staging", "production-like"];
const CONTRACT_FIELDS = new Set([
  "schema_version",
  "contract_id",
  "action_digest",
  "action_class",
  "scope",
  "recourse",
  "recovery_class",
  "fixture",
  "fault",
  "procedure",
  "oracle",
  "issued_at",
  "expires_at",
  "max_attestation_age_seconds",
]);
const SCOPE_FIELDS = new Set([
  "connector",
  "resource_type",
  "assurance_mode",
  "parameters_digest",
  "postcondition_digest",
  "evidence_plan_digest",
]);
const RECOURSE_FIELDS = new Set([
  "kind",
  "capability",
  "implementation_digest",
  "reservation_digest",
  "capability_reference_digest",
  "connector_commitment_digest",
]);
const FIXTURE_FIELDS = new Set([
  "adapter",
  "adapter_version",
  "adapter_implementation_digest",
  "checkpoint_digest",
  "fidelity",
  "configuration",
]);
const OPERATION_FIELDS = new Set(["kind", "version", "parameters"]);
const ATTESTATION_FIELDS = new Set([
  "schema_version",
  "attestation_id",
  "contract_digest",
  "coverage_digest",
  "adapter_digest",
  "trace_digest",
  "fixture_digest",
  "checkpoint_digest",
  "fault_digest",
  "damaged_state_digest",
  "procedure_digest",
  "oracle_digest",
  "recovered_state_digest",
  "recovery_class",
  "fixture_fidelity",
  "qualification",
  "drilled_at",
  "expires_at",
  "limitations",
  "signature",
]);
const BUNDLE_FIELDS = new Set([
  "schema_version",
  "recovery_contract",
  "trace",
  "drill_attestation",
  "trust_hint",
]);
const TRACE_FIELDS = new Set([
  "adapter_id",
  "adapter_version",
  "adapter_implementation_digest",
  "local_testable",
  "checkpoint_reference_digest",
  "baseline_state",
  "checkpoint_state",
  "damaged_state",
  "recovered_state",
  "fault_observed",
  "recovery_attempted",
  "oracle_satisfied",
  "notes",
]);
const TRACE_RESULT_FIELDS = new Set(
  [...TRACE_FIELDS].filter((field) => ![
    "adapter_id",
    "adapter_version",
    "adapter_implementation_digest",
  ].includes(field)),
);
const TRUST_HINT_FIELDS = new Set(["key_id", "public_key_pem", "warning"]);
const SHA256_BASE64URL = /^[A-Za-z0-9_-]{43}$/;

const LIMITATIONS = [
  "Qualification is limited to the pinned fixture, adapter, fault, procedure and oracle.",
  "Synthetic or staging evidence does not establish production recoverability.",
  "Signatures establish integrity and provenance, not the truth of the drill environment.",
];

function assert(condition, code, message, details = {}) {
  if (!condition) {
    throw new RailError(code, message, details);
  }
}

function assertObject(value, label, code = "RECOVERY_CONTRACT_INVALID") {
  assert(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null),
    code,
    `${label} must be an object.`,
  );
}

function assertRequiredFields(value, required, label, code = "RECOVERY_CONTRACT_INVALID") {
  const missing = [...required].filter((field) => !Object.hasOwn(value, field));
  assert(missing.length === 0, code, `${label} is missing required fields.`, {
    fields: missing,
  });
}

function assertExactFields(value, allowed, label, code = "RECOVERY_CONTRACT_INVALID") {
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  assert(unknown.length === 0, code, `${label} contains unknown fields.`, {
    fields: unknown,
  });
}

function assertNonEmptyString(value, label) {
  assert(
    typeof value === "string" && value.length > 0,
    "RECOVERY_CONTRACT_INVALID",
    `${label} must be a non-empty string.`,
  );
}

function assertDigest(value, label, code = "RECOVERY_CONTRACT_INVALID") {
  assert(
    typeof value === "string" && SHA256_BASE64URL.test(value),
    code,
    `${label} must be a SHA-256 base64url digest.`,
  );
}

function timestamp(value, label, code = "RECOVERY_CONTRACT_INVALID") {
  const milliseconds = new Date(value).getTime();
  assert(
    typeof value === "string" &&
      Number.isFinite(milliseconds) &&
      new Date(milliseconds).toISOString() === value,
    code,
    `${label} must be an ISO date-time string.`,
  );
  return milliseconds;
}

function validateOperation(value, label) {
  assertObject(value, label);
  assertExactFields(value, OPERATION_FIELDS, label);
  assertRequiredFields(value, OPERATION_FIELDS, label);
  assertNonEmptyString(value.kind, `${label}.kind`);
  assertNonEmptyString(value.version, `${label}.version`);
  assertObject(value.parameters, `${label}.parameters`);
  digest(value.parameters);
}

export function recoveryCoverage(contract) {
  return {
    action_digest: contract.action_digest,
    action_class: contract.action_class,
    recourse: deepClone(contract.recourse),
    scope: deepClone(contract.scope),
    fixture: {
      adapter: contract.fixture.adapter,
      adapter_version: contract.fixture.adapter_version,
      adapter_implementation_digest:
        contract.fixture.adapter_implementation_digest,
      checkpoint_digest: contract.fixture.checkpoint_digest,
    },
  };
}

export function validateRecoveryContract(input) {
  assertObject(input, "RecoveryContract");
  assertExactFields(input, CONTRACT_FIELDS, "RecoveryContract");
  assertRequiredFields(input, CONTRACT_FIELDS, "RecoveryContract");
  assert(
    input.schema_version === "consequence-rail/recovery-contract/v0.1",
    "RECOVERY_CONTRACT_INVALID",
    "Unsupported RecoveryContract schema version.",
  );
  assertNonEmptyString(input.contract_id, "RecoveryContract.contract_id");
  assertDigest(input.action_digest, "RecoveryContract.action_digest");
  assertNonEmptyString(input.action_class, "RecoveryContract.action_class");

  assertObject(input.scope, "RecoveryContract.scope");
  assertExactFields(input.scope, SCOPE_FIELDS, "RecoveryContract.scope");
  assertRequiredFields(input.scope, SCOPE_FIELDS, "RecoveryContract.scope");
  assertNonEmptyString(input.scope.connector, "RecoveryContract.scope.connector");
  assertNonEmptyString(input.scope.resource_type, "RecoveryContract.scope.resource_type");
  assert(
    input.scope.assurance_mode === "enforced" ||
      input.scope.assurance_mode === "cooperative",
    "RECOVERY_CONTRACT_INVALID",
    "RecoveryContract.scope.assurance_mode must be enforced or cooperative.",
  );
  for (const field of [
    "parameters_digest",
    "postcondition_digest",
    "evidence_plan_digest",
  ]) {
    assertDigest(input.scope[field], `RecoveryContract.scope.${field}`);
  }

  assertObject(input.recourse, "RecoveryContract.recourse");
  assertExactFields(input.recourse, RECOURSE_FIELDS, "RecoveryContract.recourse");
  assertRequiredFields(input.recourse, RECOURSE_FIELDS, "RecoveryContract.recourse");
  assert(
    ["reverse", "compensate", "escalate"].includes(input.recourse.kind),
    "RECOVERY_CONTRACT_INVALID",
    "RecoveryContract.recourse.kind is unsupported.",
  );
  assertNonEmptyString(input.recourse.capability, "RecoveryContract.recourse.capability");
  for (const field of [
    "implementation_digest",
    "reservation_digest",
    "capability_reference_digest",
    "connector_commitment_digest",
  ]) {
    assertDigest(input.recourse[field], `RecoveryContract.recourse.${field}`);
  }
  assert(
    RECOVERY_CLASSES.includes(input.recovery_class),
    "RECOVERY_CONTRACT_INVALID",
    "RecoveryContract.recovery_class is unsupported.",
  );

  assertObject(input.fixture, "RecoveryContract.fixture");
  assertExactFields(input.fixture, FIXTURE_FIELDS, "RecoveryContract.fixture");
  assertRequiredFields(input.fixture, FIXTURE_FIELDS, "RecoveryContract.fixture");
  assertNonEmptyString(input.fixture.adapter, "RecoveryContract.fixture.adapter");
  assertNonEmptyString(
    input.fixture.adapter_version,
    "RecoveryContract.fixture.adapter_version",
  );
  assertDigest(
    input.fixture.adapter_implementation_digest,
    "RecoveryContract.fixture.adapter_implementation_digest",
  );
  assertDigest(
    input.fixture.checkpoint_digest,
    "RecoveryContract.fixture.checkpoint_digest",
  );
  assert(
    FIXTURE_FIDELITIES.includes(input.fixture.fidelity),
    "RECOVERY_CONTRACT_INVALID",
    "RecoveryContract.fixture.fidelity is unsupported.",
  );
  assertObject(input.fixture.configuration, "RecoveryContract.fixture.configuration");
  digest(input.fixture.configuration);

  validateOperation(input.fault, "RecoveryContract.fault");
  validateOperation(input.procedure, "RecoveryContract.procedure");
  validateOperation(input.oracle, "RecoveryContract.oracle");

  const issuedAt = timestamp(input.issued_at, "RecoveryContract.issued_at");
  const expiresAt = timestamp(input.expires_at, "RecoveryContract.expires_at");
  assert(
    expiresAt > issuedAt,
    "RECOVERY_CONTRACT_INVALID",
    "RecoveryContract.expires_at must be after issued_at.",
  );
  assert(
    Number.isInteger(input.max_attestation_age_seconds) &&
      input.max_attestation_age_seconds > 0,
    "RECOVERY_CONTRACT_INVALID",
    "RecoveryContract.max_attestation_age_seconds must be a positive integer.",
  );

  return deepFreeze(deepClone(input));
}

function normalizeTrace(
  rawTrace,
  adapter,
  code = "RECOVERY_DRILL_INVALID",
  { requireIdentity = false } = {},
) {
  assertObject(rawTrace, "Recovery drill trace", code);
  assertExactFields(rawTrace, TRACE_FIELDS, "Recovery drill trace", code);
  assertRequiredFields(rawTrace, TRACE_RESULT_FIELDS, "Recovery drill trace", code);
  if (requireIdentity) {
    assertRequiredFields(rawTrace, TRACE_FIELDS, "Recovery drill trace", code);
  }
  for (const [field, expected] of [
    ["adapter_id", adapter.id],
    ["adapter_version", adapter.version],
    ["adapter_implementation_digest", adapter.implementationDigest],
  ]) {
    assert(
      !Object.hasOwn(rawTrace, field) || rawTrace[field] === expected,
      code,
      `Recovery drill trace ${field} does not match the adapter.`,
    );
  }
  const trace = {
    adapter_id: adapter.id,
    adapter_version: adapter.version,
    adapter_implementation_digest: adapter.implementationDigest,
    local_testable: rawTrace.local_testable,
    checkpoint_reference_digest: rawTrace.checkpoint_reference_digest ?? null,
    baseline_state: rawTrace.baseline_state ?? null,
    checkpoint_state: rawTrace.checkpoint_state ?? null,
    damaged_state: rawTrace.damaged_state ?? null,
    recovered_state: rawTrace.recovered_state ?? null,
    fault_observed: rawTrace.fault_observed,
    recovery_attempted: rawTrace.recovery_attempted,
    oracle_satisfied: rawTrace.oracle_satisfied,
    notes: rawTrace.notes,
  };
  for (const field of [
    "local_testable",
    "fault_observed",
    "recovery_attempted",
    "oracle_satisfied",
  ]) {
    assert(typeof trace[field] === "boolean", code, `Recovery drill trace ${field} must be boolean.`);
  }
  assert(
    trace.notes.every((item) => typeof item === "string"),
    code,
    "Recovery drill trace notes must be strings.",
  );
  digest(trace);
  return deepFreeze(deepClone(trace));
}

function deriveQualification(contract, trace) {
  if (!trace.local_testable || contract.fixture.fidelity !== "synthetic") {
    return "NOT_TESTABLE_LOCAL";
  }

  const checkpointIntact =
    trace.baseline_state !== null &&
    trace.checkpoint_state !== null &&
    trace.checkpoint_reference_digest === contract.fixture.checkpoint_digest &&
    digest(trace.baseline_state) === contract.fixture.checkpoint_digest &&
    digest(trace.checkpoint_state) === contract.fixture.checkpoint_digest;
  const faultObserved =
    trace.fault_observed &&
    trace.baseline_state !== null &&
    trace.damaged_state !== null &&
    digest(trace.baseline_state) !== digest(trace.damaged_state);

  if (!checkpointIntact || !faultObserved || !trace.recovery_attempted) {
    return "NOT_QUALIFIED";
  }

  if (
    contract.recovery_class === "exact" &&
    contract.oracle.kind === "exact-state-digest"
  ) {
    return trace.oracle_satisfied &&
      trace.recovered_state !== null &&
      digest(trace.baseline_state) === digest(trace.recovered_state)
      ? "QUALIFIED_EXACT"
      : "NOT_QUALIFIED";
  }

  if (contract.recovery_class === "compensation" && trace.oracle_satisfied) {
    return "REVIEW_COMPENSATED";
  }

  return "NOT_TESTABLE_LOCAL";
}

function expectedExpiry(contract, drilledAt) {
  const ageExpiry =
    new Date(drilledAt).getTime() + contract.max_attestation_age_seconds * 1_000;
  return new Date(
    Math.min(ageExpiry, new Date(contract.expires_at).getTime()),
  ).toISOString();
}

function buildAttestationCore(contract, trace, qualification, drilledAt) {
  return {
    schema_version: "consequence-rail/recovery-drill-attestation/v0.1",
    contract_digest: digest(contract),
    coverage_digest: digest(recoveryCoverage(contract)),
    adapter_digest: contract.fixture.adapter_implementation_digest,
    trace_digest: digest(trace),
    fixture_digest: digest(contract.fixture),
    checkpoint_digest: contract.fixture.checkpoint_digest,
    fault_digest: digest(contract.fault),
    damaged_state_digest:
      trace.damaged_state === null ? null : digest(trace.damaged_state),
    procedure_digest: digest(contract.procedure),
    oracle_digest: digest(contract.oracle),
    recovered_state_digest:
      trace.recovered_state === null ? null : digest(trace.recovered_state),
    recovery_class: contract.recovery_class,
    fixture_fidelity: contract.fixture.fidelity,
    qualification,
    drilled_at: drilledAt,
    expires_at: expectedExpiry(contract, drilledAt),
    limitations: LIMITATIONS,
  };
}

export async function runRecoveryPreflight({ contract, adapter, signer, clock }) {
  const validatedContract = validateRecoveryContract(contract);
  const adapterId = adapter?.id;
  const adapterVersion = adapter?.version;
  const adapterRun = adapter?.run;
  const declaredAdapterDigest = adapter?.implementationDigest;
  assert(
    adapter &&
      typeof adapterRun === "function" &&
      typeof declaredAdapterDigest === "string" &&
      signer &&
      clock,
    "RECOVERY_CONFIG_INVALID",
    "Recovery adapter, signer and clock are required.",
  );
  const adapterMeasurer = adapterId === "mock-refund-recovery"
    ? measureMockRefundRecoveryAdapterImplementation
    : null;
  const syntheticFixture = validatedContract.fixture.fidelity === "synthetic";
  const measuredAdapterDigest = syntheticFixture
    ? adapterMeasurer?.(adapterRun)
    : declaredAdapterDigest;
  assert(
    adapterId === validatedContract.fixture.adapter &&
      adapterVersion === validatedContract.fixture.adapter_version &&
      declaredAdapterDigest ===
        validatedContract.fixture.adapter_implementation_digest &&
      (!syntheticFixture ||
        measuredAdapterDigest ===
          validatedContract.fixture.adapter_implementation_digest),
    "RECOVERY_ADAPTER_MISMATCH",
    "Recovery adapter callable does not match the pinned registered implementation.",
  );
  const measuredAdapter = {
    id: adapterId,
    version: adapterVersion,
    implementationDigest: measuredAdapterDigest,
  };

  const drilledAt = clock.now();
  const drilledAtMilliseconds = timestamp(
    drilledAt,
    "Recovery drill timestamp",
    "RECOVERY_DRILL_INVALID",
  );
  assert(
    drilledAtMilliseconds >= new Date(validatedContract.issued_at).getTime() &&
      drilledAtMilliseconds < new Date(validatedContract.expires_at).getTime(),
    "RECOVERY_CONTRACT_EXPIRED",
    "RecoveryContract is not current at drill time.",
  );

  // The reference runner is deliberately synthetic-only. Enforce that boundary
  // here, before invoking even a custom adapter, so a fidelity label cannot turn
  // this evidence tool into a staging or production execution path.
  const rawTrace =
    validatedContract.fixture.fidelity === "synthetic"
      ? await Reflect.apply(adapterRun, adapter, [validatedContract])
      : {
          adapter_id: adapterId,
          adapter_version: adapterVersion,
          local_testable: false,
          checkpoint_reference_digest: null,
          baseline_state: null,
          checkpoint_state: null,
          damaged_state: null,
          recovered_state: null,
          fault_observed: false,
          recovery_attempted: false,
          oracle_satisfied: false,
          notes: ["NON_SYNTHETIC_FIXTURE_NOT_EXECUTED"],
        };
  const trace = normalizeTrace(rawTrace, measuredAdapter);
  const qualification = deriveQualification(validatedContract, trace);
  const core = buildAttestationCore(
    validatedContract,
    trace,
    qualification,
    drilledAt,
  );
  const attestation = signArtifact(
    {
      ...core,
      attestation_id: `rda_${digest(core).slice(0, 20)}`,
    },
    signer,
  );

  return deepFreeze({
    schema_version: "consequence-rail/recovery-drill-bundle/v0.1",
    recovery_contract: validatedContract,
    trace,
    drill_attestation: attestation,
    trust_hint: {
      key_id: signer.kid,
      public_key_pem: signer.publicKeyPem,
      warning: "An embedded key is not trusted automatically.",
    },
  });
}

export function verifyRecoveryPreflight(
  bundle,
  { trustedKeys = new Map(), now = null, requireCurrent = false } = {},
) {
  assertObject(bundle, "RecoveryDrillBundle", "RECOVERY_BUNDLE_INVALID");
  assertExactFields(
    bundle,
    BUNDLE_FIELDS,
    "RecoveryDrillBundle",
    "RECOVERY_BUNDLE_INVALID",
  );
  assertRequiredFields(
    bundle,
    BUNDLE_FIELDS,
    "RecoveryDrillBundle",
    "RECOVERY_BUNDLE_INVALID",
  );
  assert(
    bundle?.schema_version === "consequence-rail/recovery-drill-bundle/v0.1",
    "RECOVERY_BUNDLE_INVALID",
    "Unsupported recovery drill bundle version.",
  );
  const contract = validateRecoveryContract(bundle.recovery_contract);
  assertObject(
    bundle.trust_hint,
    "RecoveryDrillBundle.trust_hint",
    "RECOVERY_BUNDLE_INVALID",
  );
  assertExactFields(
    bundle.trust_hint,
    TRUST_HINT_FIELDS,
    "RecoveryDrillBundle.trust_hint",
    "RECOVERY_BUNDLE_INVALID",
  );
  assertRequiredFields(
    bundle.trust_hint,
    TRUST_HINT_FIELDS,
    "RecoveryDrillBundle.trust_hint",
    "RECOVERY_BUNDLE_INVALID",
  );
  for (const field of TRUST_HINT_FIELDS) {
    assert(
      typeof bundle.trust_hint[field] === "string" &&
        bundle.trust_hint[field].length > 0,
      "RECOVERY_BUNDLE_INVALID",
      `RecoveryDrillBundle.trust_hint.${field} must be a non-empty string.`,
    );
  }
  const attestation = bundle.drill_attestation;
  assertObject(
    attestation,
    "RecoveryDrillAttestation",
    "RECOVERY_BUNDLE_INVALID",
  );
  assertExactFields(
    attestation,
    ATTESTATION_FIELDS,
    "RecoveryDrillAttestation",
    "RECOVERY_BUNDLE_INVALID",
  );
  assertRequiredFields(
    attestation,
    ATTESTATION_FIELDS,
    "RecoveryDrillAttestation",
    "RECOVERY_BUNDLE_INVALID",
  );
  verifyArtifact(attestation, trustedKeys);

  const adapter = {
    id: bundle.trace?.adapter_id,
    version: bundle.trace?.adapter_version,
    implementationDigest: bundle.trace?.adapter_implementation_digest,
  };
  const trace = normalizeTrace(
    bundle.trace,
    adapter,
    "RECOVERY_BUNDLE_INVALID",
    { requireIdentity: true },
  );
  assert(
    adapter.id === contract.fixture.adapter &&
      adapter.version === contract.fixture.adapter_version &&
      adapter.implementationDigest ===
        contract.fixture.adapter_implementation_digest,
    "RECOVERY_BUNDLE_INVALID",
    "Recovery drill trace does not match the contract adapter.",
  );
  const drilledAtMilliseconds = timestamp(
    attestation.drilled_at,
    "RecoveryDrillAttestation.drilled_at",
    "RECOVERY_BUNDLE_INVALID",
  );
  assert(
    drilledAtMilliseconds >= new Date(contract.issued_at).getTime() &&
      drilledAtMilliseconds < new Date(contract.expires_at).getTime(),
    "RECOVERY_BUNDLE_INVALID",
    "RecoveryDrillAttestation was issued outside the contract window.",
  );
  const derivedQualification = deriveQualification(contract, trace);
  const core = buildAttestationCore(
    contract,
    trace,
    derivedQualification,
    attestation.drilled_at,
  );
  const expectedId = `rda_${digest(core).slice(0, 20)}`;
  for (const [field, expected] of Object.entries(core)) {
    assert(
      JSON.stringify(attestation[field]) === JSON.stringify(expected),
      "RECOVERY_BUNDLE_INVALID",
      `RecoveryDrillAttestation does not match derived ${field}.`,
    );
  }
  assert(
    attestation.attestation_id === expectedId,
    "RECOVERY_BUNDLE_INVALID",
    "RecoveryDrillAttestation identifier is invalid.",
  );
  assert(
    RECOVERY_QUALIFICATIONS.includes(attestation.qualification),
    "RECOVERY_BUNDLE_INVALID",
    "RecoveryDrillAttestation qualification is invalid.",
  );

  if (requireCurrent) {
    const nowMilliseconds = timestamp(
      now,
      "Recovery verification timestamp",
      "RECOVERY_BUNDLE_INVALID",
    );
    assert(
      nowMilliseconds >= new Date(attestation.drilled_at).getTime() &&
        nowMilliseconds < new Date(attestation.expires_at).getTime(),
      "RECOVERY_ATTESTATION_EXPIRED",
      "RecoveryDrillAttestation is not current.",
    );
  }

  return {
    valid: true,
    freshness_checked: requireCurrent,
    current: requireCurrent ? true : null,
    qualification: attestation.qualification,
    contract_digest: attestation.contract_digest,
    coverage_digest: attestation.coverage_digest,
    attestation_digest: digest(attestation),
    expires_at: attestation.expires_at,
    trusted_key_id: attestation.signature.key_id,
  };
}
