# Release status

Current public state: experimental v0.2.0 source release with Recovery
Preflight.

## GitHub metadata

- Repository: `oonyl/consequence-rail`
- Visibility: public
- Default branch: `main`
- About: `Recourse-gated execution, recovery preflight, and signed settlement receipts for autonomous actions.`
- Homepage: none
- Public identity: Oonyl
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
- one synthetic connector
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
