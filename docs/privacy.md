# Privacy model

Consequence Rail does not need raw prompts, chain-of-thought, model telemetry,
customer records, or full API payloads to express its core protocol.

## Data minimization rules

- Default inspection returns resource digests, not raw resource identifiers.
- Event payloads contain state, reason codes, digests and bounded metadata.
- The action digest binds full parameters without repeating them in events.
- Evidence must include only facts required by the configured postcondition.
- A settlement receipt carries evidence digests, not full evidence facts.
- Connector implementations should avoid logging request and response bodies.
- No telemetry or network export is enabled by the reference runtime.

## Bundle exports

The default `receipt` profile omits the full proposal and raw evidence. It
contains the evidence manifest, signed receipt and event chain for integrity
verification. The signed reservation contains digests of its capability
reference and remedy idempotency key rather than their raw values.

The `audit` profile contains the full proposal and outcome evidence so a
verifier can replay lifecycle semantics and postcondition evaluation. The
deterministic demo uses this profile only with synthetic data.

Production integrations should restrict audit-bundle access, use encrypted or
separately controlled action payloads, and keep only digests in broadly
portable receipts.

## Synthetic fixtures

All committed examples use:

- recipient and resource identifiers containing `demo`
- a mock connector
- fictional orders and messages
- integer test amounts
- public deterministic rail and connector signing keys

No fixture should contain a real person, organization, account, hostname,
credential, customer record or infrastructure endpoint.

## Retention

The v0.1 sidecar stores state only in memory. It has no retention scheduler or
deletion API. A persistent adapter must define retention, access, deletion and
legal requirements before use.
