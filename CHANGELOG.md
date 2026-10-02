# Changelog

## Unreleased

- Refund currency must be a string at both live proposal admission and offline
  bundle-shape validation. A one-element array can no longer pass through regular
  expression coercion. Existing string currencies and artifact bytes are unchanged.
- Portable proposal vectors cover types and closed fields in both proposal
  versions, with an HTTP refusal regression. Release and parser-boundary documents
  now describe the current source version, connectors, and duplicate-key handling.

## Early refusals close a declared unread body (28-09-2026)

- A request that declares a body and is refused before that body is read now
  gets the response and then a socket close. That includes method-not-allowed,
  an unknown route, an invalid action id, a busy server, a rate limit, and a
  rejected host or origin.
- Previously only a refusal inside the body reader closed the socket. A client
  could hold the connection open by withholding a body the sidecar had already
  rejected for another reason.
- A body that is fully read still leaves the socket reusable. No schema,
  signature, or canonical-byte change.

## Insufficient inventory is a confirmed failure (28-09-2026)

- When the inventory connector refuses an allocation before creating one, the
  rail now records `FAILED`, releases the reservation, and rethrows
  `INVENTORY_INSUFFICIENT`.
- That refusal was caught by the ambiguous-execution path. The action stayed
  `UNKNOWN`, reconciliation could not find an effect, and close recorded a
  disputed receipt while the unused reservation stayed active.
- An idempotency conflict is still `FAILED` for the same reason: the connector
  raised it before an effect. A lost response remains ambiguous. No schema,
  signature, or canonical-byte change.

## Inventory allocation rejects a non-positive quantity (28-09-2026)

- `createAllocation` now refuses a quantity that is not a positive safe integer,
  before it changes on-hand stock or records an allocation.
- A negative quantity previously passed the `quantity > available` check and
  increased stock by that amount. `NaN` did the same comparison and stored
  `NaN` as the on-hand balance.
- No schema, signature, or canonical-byte change.

## Refund execution rejects a non-positive amount (28-09-2026)

- The refund connector now refuses to create a refund unless `amount_minor`
  is a positive safe integer. The refusal happens before any refund is stored.
- `execute` previously stored a zero or negative amount, and a non-finite
  amount was stored and then failed while the execution was remembered, leaving
  the refund in place without a cached result.
- The measured connector digest changed, and the conformance recovery contract
  pins the new value. No schema, receipt format, or canonical-byte change.

## Recovery contracts bound the attestation age (28-09-2026)

- `max_attestation_age_seconds` must now be a safe integer from 1 through the
  same duration limit as an evidence plan, `floor(Number.MAX_SAFE_INTEGER / 1000)`.
- The field previously accepted any positive `Number.isInteger` value, including
  `2^53` and `1e20`. Multiplying those by 1000 is not an exact millisecond
  count, so the derived attestation expiry was not the age the contract named.
- No schema, signature, or canonical-byte change.

## Semantic verification binds evidence currency and SKU to the proposal (28-09-2026)

- An audit bundle is now `SEMANTIC_INVALID` when refund evidence reports a
  different currency than the proposal, or when allocation evidence reports a
  different SKU.
- The rail's observer copies those fields from the proposal. The verifier
  checked the resource id and re-ran the postcondition, which does not mention
  currency or SKU, so a USD refund could be settled on EUR evidence and an
  allocation of `sku_demo_1` could be settled on another SKU.
- No schema, signature, or canonical-byte change.

## Semantic verification binds the receipt close time to the terminal event (28-09-2026)

- An audit bundle is now `SEMANTIC_INVALID` when `settlement_receipt.closed_at`
  is not the `recorded_at` of the terminal `CLOSED` event.
- The rail writes both from the same clock read. The verifier checked the
  chain ended in `CLOSED` and that the receipt signature was valid, so a
  re-signed receipt could claim the action closed a year later.
- No schema, signature, or canonical-byte change.

## Semantic verification binds the permit window to the proposal (28-09-2026)

- An audit bundle is now `SEMANTIC_INVALID` when the permit expires at a
  different instant than the proposal, or when the permit was issued before
  the proposal was requested.
- The rail copies `proposal.expires_at` onto the permit and will not issue a
  permit outside that window. The verifier only checked that execution fell
  inside whatever window the permit itself declared, so a longer permit or an
  earlier issue time still verified.
- Execution at `issued_at` remains inside the window, and execution at
  `expires_at` remains outside it. No schema, signature, or canonical-byte change.

## Semantic verification requires the reserved scope to cover the proposal (28-09-2026)

- An audit bundle whose reservation or connector commitment is scoped below
  the proposed refund amount or allocation quantity is now `SEMANTIC_INVALID`.
- The rail already refuses that reservation at admission. The verifier only
  checked that the commitment and reservation named the same scope field, so
  a re-signed bundle could settle a 12000 refund under a scope of 1.
- No schema, signature, or canonical-byte change.

## HTTP requests reject duplicate JSON members (28-09-2026)

- The reference server now parses request bodies with the same duplicate-member
  rejection artifact files already use. A repeated object key, including one
  written with a different escape sequence, is `JSON_DUPLICATE_KEY`.
- `JSON.parse` kept the last value, so a proposal could carry two amounts and
  the sidecar would admit whichever came last.
- No schema, signature, or canonical-byte change.

## Early HTTP refusals close the unread body candidate (28-09-2026)

- A request refused before its body is read now gets the response and then
  a socket close. That covers an unsupported content encoding, an invalid
  content length, an unsupported media type, and a body on a route that
  does not accept one.
- Previously only an oversized declared length closed the socket. The other
  refusals left the client able to hold the connection open by not sending
  the body the sidecar had already rejected.
- No schema, signature, or canonical-byte change.

## Recovery link checks the proposal scope candidate (28-09-2026)

- `linkRecovery` now compares a drill's scope with the audit proposal:
  connector, resource type, assurance mode, and the parameter, postcondition,
  and evidence-plan digests. `bindings_match` is false when any of those
  differ.
- Previously a drill could name the settlement's action digest and still
  carry a parameters digest for a different payload. The report said the
  bindings matched. Live admission already rejects that drill.
- A receipt profile has no proposal, so those scope fields stay unchecked.
  No schema, signature, or canonical-byte change.

## Execution at permit expiry is outside the window candidate (28-09-2026)

- Semantic verification now rejects an execution whose recorded time is the
  permit's `expires_at`. The rail already treats that instant as expired
  (`isExpired` is true when the clock is equal to the expiry).
- The verifier previously used an inclusive upper bound, so a signed bundle
  could show an execution that the reference rail would have refused.
- Execution at `issued_at` is still accepted. No schema, signature, or
  canonical-byte change.

## Idempotency keys are bound to one action candidate (28-09-2026)

- Reusing an execution or remedy idempotency key for a different proposal is
  now `IDEMPOTENCY_CONFLICT`. The same proposal still replays the stored
  result. The rail records execution conflicts as `FAILED` and releases
  recourse, and records remedy conflicts as disputed, instead of treating
  the refusal as an ambiguous timeout and adopting the other action's result.
- Previously both connectors returned the cached result for the key alone.
  A second action with the same key was reported executed, or a second
  remedy was reported remediated, without performing that action.
- The measured refund-connector digest changed, and the conformance recovery
  contract pins the new value. No schema, receipt format, or canonical-byte
  change.

## Recovery trace notes must be an array candidate (28-09-2026)

- `verifyRecoveryPreflight` now rejects a drill trace whose `notes` field is
  not an array of strings, with `RECOVERY_BUNDLE_INVALID`.
- A string, `null`, or object in that field threw `TypeError` from
  `notes.every` before the trace digest was checked. Callers reported an
  internal failure instead of a rejected bundle.
- No schema, signature, or canonical-byte change.

## Refund recourse requires a refund action candidate (28-09-2026)

- The refund connector now refuses to reserve `void-duplicate-refund` unless
  the proposal action type is `demo.refund.issue/v1` and both the requested
  scope and the proposal amount are safe integers.
- An email proposal aimed at this connector previously reserved a refund
  remedy. The amount check compared the request with `undefined` and passed,
  so the connector signed an active commitment for an action it cannot refund.
- The measured connector digest changed, and the conformance recovery
  contract pins the new value. No schema, receipt format, or canonical-byte
  change.

## Refund remedy stays on its own action candidate (28-09-2026)

- A refund remedy now voids only an active refund created for that action's
  proposal idempotency key. When the action has a duplicate, the later of
  its own refunds is voided and its primary refund stays active.
- Previously the connector voided the last active refund on the order. A
  later refund from another action on the same order was voided instead, and
  the action's own duplicate stayed active.
- The measured refund-connector digest changed with that source, and the
  conformance recovery contract now pins the new digest. No schema, receipt
  format, or canonical-byte change.

## Inventory remedy consumes its reservation candidate (28-09-2026)

- A successful inventory remedy now marks the connector reservation
  `consumed`, including when the remedy response is lost after the release
  commits.
- Previously the reservation stayed `active`, and closing a compensated
  allocation released it. The receipt then said `released`, which is the
  status of an unused reservation, even though the extra allocation had
  already been returned.
- The refund connector already recorded `consumed` for the same success path.
  Settled allocations that never start a remedy still release the reservation.
  No schema or canonical-byte change.

## Receipt profile proposal exclusion candidate (28-09-2026)

- `verifyBundle` now rejects a `receipt` profile bundle that carries
  `action.proposal`, with `BUNDLE_TAMPERED`, the same way it already rejects one
  that carries raw `outcome_evidence`.
- The rail's own receipt export omits the proposal and `receiptBundle` deletes
  it, so no artifact this repository produces is affected. A bundle assembled
  elsewhere could carry the subject, parameters and evidence plan inside a file
  labelled `receipt`, and every downstream report still stated that the proposal
  was omitted.
- Tightening only. No schema, receipt format or CLI flag change, so the version
  goes to 0.2.2.

## Canonical key order candidate (28-09-2026)

- `canonicalJson` now emits object keys in the UTF-16 code unit order that
  `spec/model.md` documents, instead of handing the sorted copy to
  `JSON.stringify` and letting it re-sort array-index-like keys (`"0"`, `"1"`,
  `"10"`) into ascending numeric order.
- Same input, different key order and different process still produce identical
  bytes, as before. The change is that the bytes now equal the documented
  profile, so an independent implementation of that profile computes the same
  digests and the same signed payloads.
- Canonical bytes change for any object that has an array-index-like own key.
  Artifacts produced by this repository contain none, so existing signatures and
  receipt digests are unchanged; a third-party artifact with such a key changes
  digest. This is the receipt format changing, so the version goes to 0.2.1.
- Leaf encoding is still delegated to `JSON.stringify`, so string escaping and
  number formatting are byte-identical. No validation rule is relaxed.

## Irreversible scenario refusal cause candidate (28-09-2026)

- `runIrreversibleDemo` now sends a complete recourse request, so the refusal
  comes from the connector capability gate the scenario describes rather than
  from a missing request field, and reports the refusal `detail` so the stated
  reason is checkable.
- `crctl demo irreversible` prints the new `detail` line.
- The refusal code stays `RECOURSE_INVALID`; the scenario catalogue, matrix and
  `admitted: false` expectation are unchanged. No schema or receipt change.

## State machine spec sync check candidate (28-09-2026)

- Add a conformance test that parses the fenced transition table in
  `spec/state-machine.md` and requires it to list exactly the transitions in
  `ALLOWED_TRANSITIONS`, with no edge in either direction and no duplicates.
- Test only. No runtime, schema, receipt or CLI change.

## OpenAPI boundary response coverage candidate (28-09-2026)

- Every operation in `api/openapi.json` now declares the boundary statuses the
  reference server can return before route-specific processing: 400, 403, 413,
  415, 429, 500 and 503, plus 404 and 409 where the route can reach them.
- The document already described those statuses in `info.description` but
  declared none of them per operation.
- Add a test that asserts each boundary status is declared on every operation
  and that the statuses the server actually returns for a rejected request are
  declared for that route.
- Documentation and test only. No server, schema or CLI behaviour change.

## Event chain action binding candidate (28-09-2026)

- `verifyEventChain` now requires every event in a chain to carry the same
  `action_id` and reports `BUNDLE_TAMPERED` when it does not.
- Previously only sequence and `previous_hash` linkage were checked, so a
  locally consistent chain assembled from two actions verified as one history.
- No schema, receipt format or CLI change. Already-signed v0.1 event chains are
  unaffected because the rail always records one action per chain.

## Action proposal version narrowing enforcement candidate (28-09-2026)

- The rail and the offline bundle validator now enforce the published
  `ActionProposal.action_type` enum per schema version. Allocation is a
  v0.1-only action type, matching
  `spec/schemas/action-proposal-v0.2.schema.json`.
- Previously both admitted allocation under v0.2, so the rail could sign and
  the verifier could accept a v0.2 settlement bundle carrying an action type
  the published v0.2 proposal schema rejects.
- No schema, receipt format or CLI change. Existing v0.1 allocation artifacts are
  unaffected.

## Remedy scope field single source candidate (28-09-2026)

- `validateSettlementBundle` and `verifySemantics` now call the existing
  `recourseScopeField` helper instead of repeating its action-type rule, so
  the producer and both verifiers select the remedy scope field from one
  definition.
- Internal refactor. No observable behaviour, schema, receipt or CLI change.

## Sidecar bind failure reporting candidate (28-09-2026)

- The sidecar now reports a listener that cannot bind through the same
  structured single-line error contract as a usage failure, with exit status 1,
  instead of an unhandled `error` event and a Node stack trace.
- Document the sidecar exit statuses in `rail --help`.
- No protocol, schema, receipt or verification behaviour changes.

## State machine spec sync candidate (28-09-2026)

- Record the `REMEDY_DUE -> REVIEW_REQUIRED` guard in the normative transition
  table and in the Remediation section of the artifact spec.
- The edge is taken when the reserved recourse has expired or the connector no
  longer reports the reservation as active, before any remedy invocation.
- No runtime behaviour, schema, CLI surface or receipt bytes change.

## Recovery evidence snapshot candidate (26-09-2026)

- Validate the complete recovery bundle's canonical JSON boundary before replay,
  including unsigned hints, hidden fields and aggregate resource limits.
- Prepare and freeze recovery evidence before recording acceptance, preventing
  rejected input from leaving an acceptance event without retained evidence and
  preserving the verified snapshot across event-store callbacks.
- Add an executable synthetic export, independent verification and permit-refusal
  walkthrough; clarify the existing `--at` CLI freshness option.
- Preserve signed artifact bytes, v0.1/v0.2 schemas, receipt/audit profiles and
  separately configured trust anchors. No live connectors are added.

## Offline review triage candidate (11-09-2026)

- Distinguish verified artifact integrity from settlement attention reasons.
- Locate failed evidence clauses by index without disclosing paths or values.
- Aggregate recorded state dwell and mark terminal duration as unknown.
- Compare evidence membership, action class and verification context.
- Explain effective recovery validity and its limiting signed constraints.
- Detect duplicate bundles and differing signed drills in recovery collections.
- Summarize settlement collection outcomes, assurance modes and attention.
- Add explicit expected-outcome and exact-qualified-drill CLI gates while keeping
  validity, freshness and execution authority separate.
- Export verified JSON and Markdown reviews through bounded exclusive file creation.
- Preserve protocol schemas, signed artifacts, reference runtime admission and
  demonstration-key trust boundaries. Recovery batch CLI now returns exit 1 for
  differing signed attestations for the same action, even when both verify.

## Offline review workflow candidate (10-09-2026)

- Project verified audit bundles into the existing receipt profile without raw
  proposal/evidence disclosure or changes to signed artifacts.
- Inspect evidence provenance and recorded lifecycle durations; retain explicit
  receipt-profile, clock, evidence-truth and no-execution limitations.
- Diagnose recovery drills, compare coverage, link exact settlement bindings and
  verify bounded drill collections with optional explicit freshness.
- Flag duplicate bundles and differing receipts for one action in batch review.
- Render safe Markdown reviews and pin every inspected or exported artifact.
- Preserve protocol versions, runtime gates, zero dependencies and synthetic-only
  examples. No production trust, admission or recovery guarantee is added.

## Unreleased corrective candidate

- Added verified metadata review, independently verified bundle comparison, bounded
  batch audit verification, and canonical digest pins for offline artifact review.
- Added a synthetic scenario catalog and a deterministic 31-case fault matrix with
  explicit no-replay, tamper detection, recovery-gate and isolation checks.
- Added explicit recovery freshness verification at a caller-selected timestamp.
- Bounded canonical traversal and artifact file reads, rejected cycles, hidden
  fields, invalid UTF-8 and duplicate JSON members, and detached signed inputs
  from caller-owned objects. Existing accepted artifact bytes remain compatible.

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

- New bounded synthetic inventory-allocation domain (`demo.inventory.allocate/v1`): a synthetic order allocation of a declared SKU quantity with a pre-reserved remedy that reverses only the allocation bound to the action. Inventory never goes negative, an allocation is never restored twice, another order's allocation is never released, and unknown outcomes reconcile instead of retrying. Available as `crctl demo inventory` and `runInventoryDemo`.
- The remedy scope field is now domain-specific: `max_quantity` for inventory allocations, `max_amount_minor` for refunds and email. Bundle validation, semantic verification, and the published schemas require exactly the scope field matching the action type, so no domain can pass as another.
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
