# Changelog

## Unreleased corrective candidate

- Added opt-in ActionProposal, SettlementReceipt, and SettlementBundle v0.2 schemas that bound
  ordered `gte` and `lte` thresholds to finite JavaScript binary64 numbers.
  The v0.2 receipt signs its proposal schema version, and verification rejects
  bundle, receipt, or audit-proposal version substitution.
  Published v0.1 schema bytes and default v0.1 artifact hashes remain
  unchanged. Existing v0.1 `eq` and finite numeric ordered clauses remain
  compatible; non-numeric ordered thresholds or evidence now fail closed
  instead of using JavaScript coercion.
- The loopback sidecar now uses the host clock by default so current-time proposals are admissible, and accepts `--clock demo|system` plus `CONSEQUENCE_RAIL_PORT` / `CONSEQUENCE_RAIL_CLOCK` when flags are omitted.
- ActionProposal and RecourseReservation parsers now reject unsafe, non-integral, and overflow-scale duration values so evidence freshness and remedy-window arithmetic stay exact.
- HTTP sidecar failures now include a `request_id` (and the action id when the route named one). Unexpected exceptions are logged to stderr and returned as `INTERNAL_ERROR` instead of being swallowed as `REQUEST_INVALID`.
- CLI usage now rejects missing flag values, unknown commands and flags, and empty or unreadable JSON files; `crctl --help` lists valid faults and modes, and `rail --help` prints usage instead of starting the sidecar.
- JSON Schemas and OpenAPI now type digest and signature fields as the runtime's unpadded SHA-256 and Ed25519 base64url encodings, and the repository check rejects regressions.
- Connector observation failures now fail closed into a signed disputed receipt with bounded `EVIDENCE_UNAVAILABLE` or `REMEDY_EVIDENCE_UNAVAILABLE` diagnostics instead of stranding verification states.
- Added an offline `bundle timeline` verifier that reuses settlement-bundle integrity and audit-profile lifecycle semantics before emitting a metadata-only event timeline.
- Added Windows CI coverage for the supported Node.js matrix.
- Integrity verification now rejects settlement receipts whose technical claim or limitations overreach the protocol's bounded language, including receipt-profile bundles.
- Added tests that a recovery-gated rail refuses expired, review-compensated, and HTTP-submitted failed drills before permit or execution.

## Version 0.2.0 - 27 July 2026

- Added Recovery Preflight contracts, trace-bound signed drill attestations
  and replayable drill bundles.
- Added a synthetic isolated adapter that exercises the existing refund remedy
  implementation without touching the live connector instance.
- Added exact, review, unqualified and locally untestable result classes.
- Added a policy-selectable Rail gate that refuses permit issuance without a
  current, trusted and coverage-matched exact-recovery qualification.
- Added negative controls for missing or corrupt checkpoints, absent faults,
  failed remedies, unsupported local fixtures, expiry, tampering and scope
  mismatch.
- Preserved the existing v0.1 permit and settlement-bundle formats. Recovery
  drill evidence remains a separately verifiable artifact in this release.
- Bound qualifications to the exact signed reservation, capability reference,
  connector commitment, measured recovery callables, measured adapter, and a
  precommitted checkpoint.
- Added registered live adapter-callable measurement and capture before drill
  execution, and made the process-wide preflight requirement non-downgradable.
- Removed caller-supplied outcome evidence and added exact nested runtime input
  validation.
- Hardened canonicalization against prototype-sensitive keys, exotic objects,
  accessors, and sparse arrays; postconditions now traverse own safe fields
  only.
- Added bounded loopback HTTP request, origin, method, content, concurrency,
  connection, and response-header controls.
- Added exact closed-object validation for settlement bundles and rejection of
  unknown or repeated query parameters before route mutation.
- Added immutable hashes proving that default v0.1 permit, event, action-view,
  and clean and duplicate audit-bundle bytes remain unchanged.

Public source release on 27 July 2026.

## Version 0.1.0

- Defined five versioned protocol artifacts and a technical settlement bundle.
- Implemented action-digest binding and signed single-use permits.
- Added connector-signed recourse commitments and status checks.
- Added immediate pre-execution recourse revalidation.
- Added expiry handling and terminal reservation release/finalization.
- Added enforced, cooperative and observed assurance boundaries.
- Added deterministic execution ambiguity and status reconciliation.
- Added independent remedy ambiguity and status reconciliation.
- Added postcondition evaluation and bounded verified remediation.
- Added settled, compensated and disputed technical receipts.
- Added receipt and audit bundle profiles.
- Added separate integrity and lifecycle-semantic verification.
- Added signed hash-linked events and explicit rail and connector trust.
- Added a loopback reference API and CLI.
- Added synthetic fault demos, JSON Schemas, OpenAPI and conformance tests.

Initial public source release on 23 July 2026.
