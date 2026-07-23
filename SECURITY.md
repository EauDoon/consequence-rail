# Security policy

Consequence Rail is an experimental reference implementation and is not
production-ready.

## Reporting

Report suspected vulnerabilities through GitHub's private vulnerability
reporting for this repository. If that option is unavailable, open a minimal
public issue requesting a private contact channel. Do not place credentials,
private data, exploit details, or affected-system identifiers in a public
issue.

## In scope

- action-digest binding
- permit replay or expiry bypass
- illegal state transitions
- ambiguous-execution retry
- ambiguous-remedy retry
- assurance-mode misrepresentation
- recourse-scope bypass
- evidence-binding or freshness bypass
- event-chain or receipt-verification bypass
- unintended sensitive-data exposure

## Known limitations

The deterministic rail and connector signing keys are public. State is
process-local and in-memory. The loopback API accepts an unauthenticated policy
decision. No external checkpoint, production key management, request-size
limit, rate control, persistent transaction boundary or independent evidence
trust adapter is implemented.

Read the [threat model](docs/threat-model.md) before evaluating security claims.
