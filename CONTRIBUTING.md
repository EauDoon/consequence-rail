# Contributing

Consequence Rail is intentionally narrow. Contributions should strengthen the
action-to-recourse-to-outcome contract without turning the project into a
general governance platform or API gateway.

## Before proposing a change

- Read the [artifact model](spec/model.md).
- Read the [state machine](spec/state-machine.md).
- Read the [threat model](docs/threat-model.md).
- State the protocol invariant affected by the change.
- Add deterministic tests for success, failure and ambiguous execution.
- For boundary changes, add adversarial tests for unknown and inherited fields,
  reserved object keys, digest or signature substitution, resource limits, and
  zero state mutation on rejected HTTP requests.
- Use synthetic data only.
- Do not add network dependencies to the default test path.

## Local checks

```text
node ./scripts/check.js
node --test
```

Changes to artifact fields or lifecycle behavior must update the JSON Schemas,
OpenAPI document, conformance fixtures and relevant documentation in the same
change.

## Releasing

1. Bump `version` in `package.json`, `info.version` in `api/openapi.json`, and
   the "experimental vX.Y.Z source release" line in `README.md` and
   `docs/release-status.md`.
2. Move the `## [Unreleased]` entries in `CHANGELOG.md` under a new
   `## [X.Y.Z] - YYYY-MM-DD` heading (UTC merge date), leave an empty
   `## [Unreleased]`, and update the link references.
3. Run `npm run check`.
4. Merge the pull request with a merge commit.
5. Tag the merge commit and push the tag:

   ```text
   git tag -a vX.Y.Z -m "Consequence Rail X.Y.Z" <merge commit>
   git push origin vX.Y.Z
   ```

The release workflow verifies the tagged tree and publishes the GitHub
Release from the `CHANGELOG.md` section. `node scripts/release-notes.js vX.Y.Z`
prints the same notes locally.

## Public prose

Keep claims technical and reproducible. Do not claim guaranteed recovery,
insurance, legal settlement, universal accountability, tamper-proof history or
production readiness.

## Security reports

Do not open a public issue containing a suspected vulnerability or sensitive
data. Follow [SECURITY.md](SECURITY.md).
