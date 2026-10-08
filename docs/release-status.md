# Release status

Current public state: experimental v0.3.0 source release with Recovery
Preflight and synthetic refund and inventory connectors. The source version is
recorded in `package.json`; the source repository remains the release channel.

## GitHub metadata

- Repository: `EauDoon/consequence-rail`
- Visibility: public
- Default branch: `main`
- About: `Recourse-gated execution, recovery preflight, and signed settlement receipts for autonomous actions.`
- Homepage: none
- Public identity: EauDoon
- Primary profile category: flagship systems
- Profile role: featured project and first pin

Topics:

```text
ai-agents
autonomous-agents
compensating-transactions
event-sourcing
json-schema
openapi
recourse
recovery-testing
runtime-safety
```

## Maintenance promise

- one language-neutral artifact model
- one Node.js reference runtime
- two synthetic connectors, refund and inventory allocation
- deterministic conformance and fault tests
- adversarial canonicalization, exact-binding, checkpoint, implementation
  substitution, and loopback request-boundary regressions
- one isolated synthetic recovery-drill adapter and replay verifier
- no hosted service or support-level promise
- no production-readiness claim

## Rights and license

The package contains original source, specification text and synthetic
fixtures prepared for this project. It contains no third-party runtime
dependencies or bundled external assets.

The project is licensed under Apache-2.0, covering both the protocol
specification and reference implementation.

## Release channel

The GitHub source repository is the release channel. The project does not
publish an npm package or operate a hosted service. Run the reference
implementation directly from a reviewed source checkout.

Every change to `main` must pass the repository integrity check and the
deterministic test suite on each supported Node.js release line.

- `package.json` is the single source of the implementation version. The
  OpenAPI `info.version`, this page, the README and the top released
  `CHANGELOG.md` heading must agree with it; `scripts/check.js` enforces that.
- A release is an annotated `vX.Y.Z` tag on a commit on `main`.
- Pushing the tag runs `.github/workflows/release.yml`. It reruns the
  integrity check (which then also requires the tag to equal `v` plus the
  package version) and the test suite on every supported platform, then
  publishes a GitHub Release whose notes are that version's `CHANGELOG.md`
  section. A tag that is not on `main` is not published.
