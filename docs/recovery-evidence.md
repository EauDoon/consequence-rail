# Export and verify synthetic recovery evidence

Run this dependency-free example from the repository root with Node.js 20 or
later. The destination must not already exist; the example never overwrites it.

```sh
node examples/recovery-evidence.js .consequence-rail-evidence
```

It writes `drill.json`, `missing-checkpoint.json`, `altered.json` and `report.json`.
Each drill uses fresh isolated mock refund connectors. The example then reloads
the exported files and prepares a separate recovery-gated Rail for each case.
Only the successful case receives a synthetic permit. None of these cases calls
the action connector's execute or remedy operation.

## Independently verify the export

```sh
node cmd/crctl.js recovery-preflight verify .consequence-rail-evidence/drill.json --at 2035-01-01T00:00:00.000Z --require-qualified --json
```

Expect `valid: true`, `freshness_checked: true`, `current: true` and
`qualification_expectation_met: true`, with exit status 0. The CLI obtains the
public demonstration recovery key from local configuration, never the artifact's
`trust_hint`. The example also uses a separately configured trusted key map and
includes an empty-map refusal. Demo keys are public and cannot authenticate a
production operator. A library adopter must configure its own trusted recovery
keys independently of the submitted bundle.

The demo clock starts at `2035-01-01T00:00:00.000Z`. `--at` checks the instant you
supply; it does not attest to the current wall clock. The valid interval includes
drill time and excludes expiry. Omitting `--at` intentionally leaves freshness
unchecked, even when `--require-qualified` is present. Add `--expect-digest` with
an independently retained canonical bundle digest to detect artifact substitution.
`report.json` records the example's digest for a repeatable check, but a digest
copied from untrusted evidence is not an independent pin or trust anchor.

These commands return exit status 1:

```sh
node cmd/crctl.js recovery-preflight verify .consequence-rail-evidence/drill.json --at 2035-01-01T00:05:00.000Z --require-qualified
node cmd/crctl.js recovery-preflight verify .consequence-rail-evidence/missing-checkpoint.json --at 2035-01-01T00:00:00.000Z --require-qualified
node cmd/crctl.js recovery-preflight verify .consequence-rail-evidence/altered.json --at 2035-01-01T00:00:00.000Z
node cmd/crctl.js recovery-preflight verify .consequence-rail-evidence/absent.json --at 2035-01-01T00:00:00.000Z
```

An authentic failed drill can have `valid: true` while qualification fails. Replay
validity checks the evidence's integrity and declared bindings; a permit also
requires exact qualification, the intended action, the exact signed reservation,
current freshness and measured live recovery bindings. The Rail rechecks those
requirements before execution. An offline result cannot authorize an action.

## Inspect the admission results

The example asserts these results and records zero action-connector execution
and remedy calls for every case:

| Case | Result |
| --- | --- |
| Current exact recovery | Synthetic permit issued |
| At expiry or before drill time | `RECOVERY_ATTESTATION_EXPIRED` |
| No recovery evidence | `RECOVERY_PREFLIGHT_REQUIRED` |
| Missing checkpoint | `RECOVERY_PREFLIGHT_NOT_QUALIFIED` |
| Altered replay trace | `RECOVERY_BUNDLE_INVALID` |
| Different complete action | `RECOVERY_COVERAGE_MISMATCH` |
| Signer absent from configured trust | `UNTRUSTED_KEY` |
| Hidden metadata in a library input | `CANONICALIZATION_FAILED` |

The final case is an in-memory library control; hidden fields cannot be encoded
in JSON. The complete bundle now passes canonical input validation before any
acceptance event is recorded. Admission freezes the verified snapshot before
calling the event store, so later changes to the caller's object cannot change
the evidence retained by the Rail. Failed atomic event append still retains no
qualification. Existing valid artifact encodings and signatures are unchanged.

These are technical checks over synthetic, declared evidence. They do not prove
production recoverability, truth of an external environment, guaranteed recovery
or real financial settlement.
