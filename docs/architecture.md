# Architecture

## Components

### Proposer

An agent, workflow or service submits a versioned `ActionProposal`. It does not
receive a downstream credential.

### Policy adapter

An external policy system decides whether the proposal may proceed. The rail
records the policy identifier, policy digest and optional evaluation-input
digest. The rail is not a general policy engine.

The loopback v0.1 API accepts an unsigned caller-supplied policy decision. This
is suitable only for the mock connector. Any real connector requires an
authenticated policy adapter and caller authorization.

### Rail

The rail:

1. validates and digests the immutable action
2. binds the external authorization decision
3. requests and verifies a connector-signed recourse commitment
4. issues and consumes a single-use permit
5. rechecks recourse immediately before invoking the protected connector
6. reconciles ambiguous execution and ambiguous remediation without retry
7. validates evidence and evaluates the configured postcondition
8. invokes the bounded remedy when needed
9. produces a signed technical settlement receipt

### Connector

A connector exposes these logical operations:

```text
Capabilities()
ReserveRecourse(action, requested_scope)
RecourseStatus(reservation_token)
ReleaseRecourse(reservation_token)
Execute(action, idempotency_key)
Status(idempotency_key)
Remediate(action, reservation, idempotency_key)
RemedyStatus(idempotency_key)
```

The v0.1 implementation includes only a synthetic refund connector. It does
not provide an arbitrary URL executor.

### Evidence source

The evidence source reports the relevant external resource state. Source
identity, resource identity and freshness are checked before postcondition
evaluation.

### Offline verifier

The verifier receives a settlement bundle plus explicit rail and connector
trusted-key sets.

Integrity verification checks signatures, event order, hash linkage, artifact
digests, assurance disclosure and the final receipt.

Full semantic verification requires an `audit` bundle. It also replays legal
state transitions, validates connector commitment bindings, checks evidence
source, resource and freshness, reevaluates postconditions and derives the
receipt outcome.

An embedded public key is never trusted automatically.

## Trust boundaries

In `enforced` mode, the rail must be the only component able to use the
downstream credential. Network and target controls should reject bypass
paths.

In `cooperative` mode, the application can retain another route to the target.
Every permit and receipt therefore discloses `bypass_possible: true`.

In `observed` mode, the rail cannot issue permits or claim prevention.

Recourse status is checked at permit issuance, immediately before execution,
and before remediation. The mock connector performs these checks in one
process. A production connector needs an atomic remote lease, transaction, or
equivalent primitive to prevent revocation or expiry between the final status
check and the protected side effect.

## Reference implementation boundaries

- Node.js 20 or newer
- no third-party runtime packages
- in-memory action and event state
- deterministic public demo rail and connector signing keys
- loopback HTTP server
- one synthetic connector
- no external network calls

These boundaries make the behavior reproducible. They are not production
deployment guidance.
