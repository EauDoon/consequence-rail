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
4. optionally verifies a separately produced Recovery Preflight bundle
5. issues and consumes a single-use permit
6. rechecks recourse immediately before invoking the protected connector
7. reconciles ambiguous execution and ambiguous remediation without retry
8. validates evidence and evaluates the configured postcondition
9. invokes the bounded remedy when needed
10. produces a signed technical settlement receipt

When Recovery Preflight is enabled, its contract is bound to the exact signed
reservation, capability-reference digest, connector-commitment digest,
measured connector recovery callables, and the registered adapter's live
`run` callable captured immediately before the drill, plus a checkpoint digest
committed before the drill. The Rail remeasures and rechecks those
bindings before permit and protected execution, and again before remediation.
The process-wide preflight requirement is monotonic; a policy decision can
enable it but cannot disable a requirement set by runtime configuration.

### Recovery Preflight runner

The runner is outside the live action path. It prepares an isolated synthetic
fixture, injects the contract fault, invokes the pinned recovery procedure,
observes the result, derives a bounded qualification, and signs a replayable
drill bundle with a distinct recovery key. The Rail verifies that evidence; it
does not execute fixture instructions or call the live remedy while issuing a
permit.

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

The settlement verifier receives a settlement bundle plus explicit rail and
connector trusted-key sets. Recovery Preflight has a separate verifier and
explicit recovery trusted-key set.

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
- bounded JSON bodies, headers, request time, connection reuse, concurrency,
  and in-memory action count
- same-origin loopback Host and Origin enforcement plus restrictive response
  headers
- rejection of unknown or repeated query parameters before request-body
  processing or route mutation
- one synthetic connector
- one isolated synthetic recovery adapter
- no external network calls

These boundaries make the behavior reproducible. They are not production
deployment guidance.
