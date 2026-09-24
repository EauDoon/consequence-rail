# consequence-rail regression baseline: 2026-09-23

## Scope
Post-monolith-split project `consequence-rail`. Test target invoked:
`npm test`, which runs `node --test` against the project test tree.

## Environment
- Default branch: `main`.
- Toolchain: Node v24.18.0, npm 12.0.2 on Windows.
- Audit branch: `imp/portfolio-triage-phase9-2026-09-23`.
- No dependency install required (zero declared dependencies).

## Results
- tests: 210
- pass: 210
- fail: 0
- skipped: 0
- error: 0
- duration_ms: 3,130.2

## Verdict
- All 210 node:test cases passed cleanly. No skips, no failures, no cancelled
  runs, no errors.
- Audit branch is a no-op against source, tests, and schemas. Only this report
  is added under `audits/`.

## Follow-ups (out of scope for this commit)
- No PR is opened by this worker; the human opens the PR per the standing rule.