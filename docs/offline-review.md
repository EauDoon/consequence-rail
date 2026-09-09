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

## Inspect evidence coverage

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
both drills and distinguishes action/coverage identity from changed fixture,
scope, recourse, fault, procedure, oracle, qualification and validity window.
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
