# Consequence Rail v0.1 artifact model

This document defines the protocol vocabulary implemented by the reference
runtime. The terms `MUST`, `MUST NOT`, `SHOULD`, and `MAY` describe protocol
requirements.

## ActionProposal

An `ActionProposal` is an immutable, versioned description of one intended
external action. It includes:

- action type and version
- proposer subject
- target connector and resource
- action parameters
- action idempotency key
- request and expiry times
- assurance mode
- data-only postcondition
- declared evidence source and freshness window

Postconditions support strict `eq` and numeric `gte` and `lte` clauses. The
published ActionProposal v0.1 schema remains immutable. ActionProposal v0.2
formally requires each ordered threshold to be a finite JavaScript binary64
number from `-1.7976931348623157e+308` to `1.7976931348623157e+308`, inclusive.
The reference runtime applies that no-coercion rule to both proposal versions:
non-numeric evidence does not satisfy an ordered clause, and a non-numeric
ordered threshold is rejected. Existing v0.1 `eq` proposals retain their
strict-equality behavior. A v0.2 proposal is carried by a v0.2 settlement
bundle so the immutable v0.1 bundle schema continues to reference only the
v0.1 proposal schema. Its v0.2 settlement receipt signs the exact v0.2
proposal schema identifier, so receipt-profile bundles remain version-bound
even though they omit the proposal.

The `action_digest` is the SHA-256 digest, encoded as unpadded base64url
(43 characters), of the proposal's canonical JSON bytes. Artifact fields
named as digests, event hashes, and evidence manifests use that same
encoding. Ed25519 signature values are unpadded base64url encodings of the
64-byte signature (86 characters).

The reference canonicalization profile recursively sorts object keys, rejects
undefined values, non-finite numbers, prototype-sensitive keys, accessors,
exotic object prototypes, sparse arrays, and array extension fields. It
preserves array order and serializes the resulting JSON without insignificant whitespace. Protocol parameters that
represent money MUST use integer minor units.

The current implementation covers the interoperable subset exercised by the
conformance fixtures. A later standards-track version should adopt a complete
published canonicalization profile and a larger cross-language vector suite.

After authorization, the proposal MUST NOT change. A changed target,
parameter, postcondition, expiry, idempotency key, or assurance mode is a new
action.

## RecourseReservation

A `RecourseReservation` contains two signatures:

- a connector-signed commitment that reserves a bounded response capability
  for the exact action digest
- a rail signature that accepts and binds that connector commitment into the
  action lifecycle

It includes:

- exact action digest
- remedy kind: `reverse`, `compensate`, or `escalate`
- connector and named capability
- capability reference
- expiry and remedy window
- maximum attempts and scope
- digests of the capability reference and independent remedy idempotency key
- opaque connector reservation token
- connector commitment signature

The reservation validity MUST cover the permit expiry and the configured
remedy window.

A connector must expose reservation status and release operations. The rail
checks that the reservation remains active before issuing a permit,
immediately before consuming that permit, and before invoking the remedy.

Confirmed no-effect failure, permit expiry and revocation release or expire
the reservation. A disputed action may retain active recourse until its
deadline because the external effect remains unresolved. A receipt records
the reservation status observed at close.

A reservation establishes authenticated declared capability and scope. It
does not guarantee that the remedy will succeed.

## Recovery Preflight

Recovery Preflight is optional evidence consumed between recourse reservation
and permit issuance. It does not create a second remedy path or add lifecycle
states.

A `RecoveryContract` pins:

- the complete immutable action digest plus its class, connector, resource
  type and assurance mode
- digests of the action parameters, postcondition and evidence plan
- the recourse kind, named capability and connector implementation profile
  digest, measured from the live recovery callables
- the exact signed reservation digest, capability-reference digest, and
  connector-commitment digest
- recovery class
- adapter identity and measured implementation digest, fixture fidelity,
  fixture configuration, and checkpoint digest committed before execution
- injected fault, recovery procedure and oracle
- contract expiry and maximum attestation age

An isolated adapter executes the contract and produces a trace containing the
baseline, checkpoint, faulted and recovered observations. A separately trusted
recovery signer issues a `RecoveryDrillAttestation` over their digests and the
derived qualification. A `RecoveryDrillBundle` carries the contract, replay
trace and attestation for offline verification.

The result vocabulary is:

- `QUALIFIED_EXACT`: the fault was observed, the pinned checkpoint was intact,
  recovery ran, and the recovered observation exactly matched the baseline
  under the pinned digest oracle
- `REVIEW_COMPENSATED`: a compensation oracle was satisfied but automatic
  exact-recovery admission is not justified
- `NOT_QUALIFIED`: the local drill ran but a required condition failed
- `NOT_TESTABLE_LOCAL`: the declared recovery class or fixture could not be
  qualified by the local runner

The v0.2 reference runner qualifies only synthetic exact-recovery drills. It
does not invoke the recovery adapter when fixture fidelity is `staging` or
`production-like`.
Exact means exact within the declared evidence surface, not that every hidden
or historical state was restored. A Rail policy may require a current
`QUALIFIED_EXACT` attestation before the existing permit transition. The Rail
records only bounded qualification metadata in its action event chain; the
recovery bundle remains a separately verifiable artifact.

For a remote connector, a status check followed by execution still has a
time-of-check to time-of-use interval. Production connectors SHOULD expose an
atomic lease-consume or execute-with-reservation operation. The v0.1 mock
connector provides only an in-process demonstration of that boundary.

## ActionPermit

An `ActionPermit` is signed, expiring, bound to one action digest and one
reservation digest, and limited to one use.

It discloses:

- assurance mode
- whether bypass is possible
- issue and expiry times
- a unique token identifier
- maximum uses

Permit consumption MUST occur before the connector call and MUST be atomic
within the rail's execution boundary.

`observed` mode MUST NOT issue an `ActionPermit`.

## OutcomeEvidence

`OutcomeEvidence` contains declared observations about an external resource.
Before use, the rail checks:

- schema version
- exact action digest
- declared source
- exact target resource
- freshness
- allowed postcondition operators

The v0.1 reference connector returns evidence directly to the rail. The rail
then signs its captured artifact. That signature proves what the rail
captured, not that the originating system was honest or independent.

## SettlementReceipt

A `SettlementReceipt` may be issued only after an external effect is possible
and the action reaches `CLOSED`.

Its technical outcome is:

- `settled`: the configured postcondition was satisfied
- `compensated`: the initial postcondition failed, the reserved remedy ran, and
  fresh evidence satisfied the configured postcondition
- `disputed`: the resulting state or remedy could not be verified

A confirmed pre-execution denial, expiry, or no-effect failure does not
produce a settlement receipt.

The receipt binds:

- proposal schema version in SettlementReceipt v0.2
- action digest
- reservation digest
- connector commitment digest and final reservation status
- permit digest
- assurance disclosure
- evidence digests
- event-chain head
- close time

Published SettlementReceipt v0.1 bytes remain immutable. A v0.1 bundle MUST
carry a v0.1 receipt. A v0.2 bundle MUST carry a v0.2 receipt whose signed
`proposal_schema_version` is `consequence-rail/action-proposal/v0.2`. Verifiers
reject bundle, receipt, and included audit-proposal version substitutions.

`settlement` is a technical protocol term. It does not mean legal settlement,
financial finality, insurance coverage, or guaranteed recovery.

## Trust and signatures

The reference implementation uses separate Ed25519 keys for the rail and
connector. Verifiers MUST receive both trusted public-key sets through
explicit trust configuration. Public keys embedded in a bundle are only hints
and MUST NOT become trusted automatically.

The demo keys are deterministic and public. They are suitable only for
reproducible tests.

## Bundle profiles

The `receipt` profile omits the full proposal and raw evidence. It supports
signature, digest and event-chain integrity verification.

The `audit` profile includes the proposal and outcome evidence. Full semantic
verification additionally replays the state machine, validates every
cross-binding, reevaluates postconditions, checks evidence freshness and
derives the receipt outcome.

Integrity verification alone MUST NOT be described as semantic settlement
verification.
