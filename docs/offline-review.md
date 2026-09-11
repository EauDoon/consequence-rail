# Offline artifact review

These commands read local artifacts under the public demonstration keys. They
do not execute actions, admit permits, authenticate production identities or
establish the truth of evidence. Library calls require explicit trusted keys.

## Share a receipt profile

`crctl bundle receipt audit.json --out receipt.json` verifies the source before
removing its proposal and raw evidence. Signed artifacts and their bindings
remain unchanged. The output uses the existing receipt profile, whose review
checks integrity only. This is data minimization, not anonymization: signed
event metadata and connector commitments remain. Existing output files are
never overwritten. Keep the original audit file for semantic replay.
Serialized artifacts, including their final newline, must fit the same 1 MiB
loader cap. Large exports use compact JSON when indentation would exceed it;
if compact output is still too large, export fails before creating or changing
the destination. Signed data is unchanged by whitespace selection.

## Inspect evidence coverage

Settlement review JSON and Markdown distinguish artifact validity from attention:
`attention_reasons` identifies disputed outcomes, compensation, bypass exposure,
ambiguous history and omitted semantic replay. These are recorded review cues,
not a production risk score or permission to retry. A valid artifact may require attention.

`crctl bundle evidence audit.json` lists evidence digests, phase, source,
observation/acceptance times, age at acceptance, signer and derived satisfaction.
It omits raw facts, resource IDs and detailed evaluations. Receipt-only inputs
list manifest digests with `metadata_available: false`. Historical freshness
does not mean that the evidence remains current or is truthful.

## Examine recorded delays

`crctl bundle timing audit.json` requires audit semantic replay, then computes
each recorded state interval and the total through closure. It calls out
ambiguous execution/remedy states without recommending a retry. Values come
from signed event times, not an independent performance measurement; fixed
synthetic clocks can legitimately produce zero durations. Receipt profiles
are refused because their chronology has not received full semantic replay.

## Diagnose a recovery drill

`crctl recovery-preflight review drill.json --at 2035-01-01T00:00:00.000Z`
verifies replay and reports checkpoint integrity, fault observation, recovery
attempt, oracle result and exact state restoration. Raw fixture states are
omitted. An explicit instant requires current evidence and reports remaining
validity; expired evidence fails. Without it, freshness is explicitly unchecked.
These checks explain the existing qualification, not a new admission decision.

## Compare recovery coverage

`crctl recovery-preflight compare old.json new.json` independently verifies
both drills and distinguishes action/coverage identity from changed action or
recovery class, fixture, scope, recourse, fault, procedure, oracle, qualification
and validity window. Contract issuance, expiry and maximum attestation age are
listed separately from the drill's timestamps, even when the drill expiry is
unchanged. `same_coverage` compares the existing protocol coverage digest; it
does not mean all recovery-contract fields match. Protocol digest definitions
are unchanged.
Structured coverage contents are represented by digests to keep fixture data
out of reports. `--at` requires both drills to be current at the same instant.
A difference never selects the authoritative drill or accepts its recovery.

## Match a drill to a settlement

`crctl recovery-preflight link settlement.json drill.json` independently
verifies both artifacts and compares exact action, reservation, capability
reference and connector commitment bindings. It separately reports whether
the settlement recorded acceptance of this exact attestation and coverage.
Binding mismatch returns a nonzero CLI status. Matching does not reproduce
live reservation status, implementation measurement or permit admission.
Use `--at` to require drill freshness at an explicit instant.

## Verify a collection of drills

`crctl recovery-preflight verify-many one.json two.json --at 2035-01-01T00:00:00.000Z`
checks up to 64 bounded local files independently. It reports every failure
and returns a nonzero status if any input fails. A valid `NOT_QUALIFIED` drill
is still a valid replay artifact, not acceptable recovery. Without `--at`,
each result explicitly leaves freshness unchecked. Supplied filenames appear
in batch reports and may need removal before sharing.

## Detect duplicate and competing settlement records

`crctl bundle verify-many one.json two.json` now includes canonical bundle,
action and receipt digests for each valid input. Identical artifacts are
grouped as duplicates. Different signed receipts for one exact action set
`review_required` and a nonzero CLI exit status, even when both artifacts pass
integrity and semantic checks. Invalid files are excluded from comparison.
The report does not infer fraud or choose an authoritative receipt.

## Export a readable review

Add `--markdown` to `bundle review` or `recovery-preflight review` to print a
shareable report with explicit verification scope and limits. Redirect stdout
to a new local `.md` file as needed. Metadata punctuation and control characters
are encoded so signed strings cannot inject links, HTML, table rows or terminal
escapes. Raw evidence is omitted. `--json` and `--markdown` are mutually exclusive.
The Markdown report is derived output, not a signed protocol artifact.

## Pin every artifact under review

All single-artifact inspection and receipt-export commands accept
`--expect-digest` with an independently recorded canonical bundle digest.
For either comparison or recovery linking, that flag pins the first input;
`--expect-other-digest` pins the second. A mismatch emits no report and creates
no receipt output. Both files still receive their normal signature/replay
verification. Digest pins prevent substitution, not untrusted signer acceptance.
