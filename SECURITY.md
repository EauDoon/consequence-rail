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
- recovery reservation, implementation, adapter, or checkpoint substitution
- evidence-binding or freshness bypass
- settlement-bundle schema or unsigned-field bypass
- loopback request-boundary bypass before state mutation
- event-chain or receipt-verification bypass
- unintended sensitive-data exposure

## Known limitations

The deterministic rail and connector signing keys are public. State is
process-local and in-memory. The bounded loopback API accepts an unauthenticated
policy decision. It is not an Internet-facing security boundary. No external
checkpoint, production key management, persistent transaction boundary, or
independent evidence trust adapter is implemented. The platform JSON parser
does not reject duplicate object members.

Read the [threat model](docs/threat-model.md) before evaluating security claims.
