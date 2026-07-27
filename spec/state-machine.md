# Consequence Rail v0.1 state machine

Every transition is recorded as a signed event. Any transition not listed
below MUST fail with `ILLEGAL_TRANSITION` before a connector is invoked.

```text
PROPOSED
  -> DENIED
  -> AUTHORIZED

AUTHORIZED
  -> EXPIRED
  -> REVOKED
  -> RECOURSE_RESERVED

RECOURSE_RESERVED
  -> EXPIRED
  -> REVOKED
  -> PERMITTED

PERMITTED
  -> EXPIRED
  -> REVOKED
  -> EXECUTING

EXECUTING
  -> EXECUTED
  -> FAILED
  -> UNKNOWN

UNKNOWN
  -> EXECUTED
  -> FAILED
  -> REVIEW_REQUIRED

EXECUTED
  -> VERIFYING

VERIFYING
  -> SATISFIED
  -> BREACHED
  -> INCONCLUSIVE

BREACHED
  -> REMEDY_DUE

REMEDY_DUE
  -> REMEDIATING

REMEDIATING
  -> REMEDY_FAILED
  -> REMEDY_UNKNOWN
  -> REMEDY_VERIFYING

REMEDY_UNKNOWN
  -> REMEDY_FAILED
  -> REVIEW_REQUIRED
  -> REMEDY_VERIFYING

REMEDY_VERIFYING
  -> REMEDIATED
  -> REMEDY_FAILED
  -> REMEDY_INCONCLUSIVE

SATISFIED
  -> CLOSED(settled)

REMEDIATED
  -> CLOSED(compensated)

INCONCLUSIVE
  -> CLOSED(disputed)

REMEDY_INCONCLUSIVE
  -> CLOSED(disputed)

REVIEW_REQUIRED
  -> CLOSED(disputed)

REMEDY_FAILED
  -> CLOSED(disputed)
```

Recovery Preflight does not add a state. While an action remains
`RECOURSE_RESERVED`, the Rail may accept a signed
`RECOVERY_PREFLIGHT_ACCEPTED` evidence event. If the authorization decision
requires preflight, the transition to `PERMITTED` MUST fail unless that
attestation is current, explicitly trusted, `QUALIFIED_EXACT`, and matched to
the action and recourse envelope. Running a drill against the live connector
is outside the state machine and MUST NOT occur as part of permit issuance.

## Ambiguous execution

A transport timeout after a connector call does not establish whether an
external effect occurred. The rail records `UNKNOWN`.

While in `UNKNOWN`, the rail MUST NOT call `Execute` again. It may call only
the connector's status or reconciliation operation using the bound
idempotency key.

- Confirmed external effect transitions to `EXECUTED`.
- Confirmed no effect transitions to `FAILED`.
- Unresolved status transitions to `REVIEW_REQUIRED`, then closes as
  `disputed`.

A confirmed no-effect `FAILED` state releases reserved recourse. An expired
or revoked permit path also finalizes the reservation without executing the
connector.

## Remediation

The rail may automatically invoke only the exact remedy reserved before
execution. It checks expiry, capability, maximum scope, maximum attempts and
the remedy idempotency key.

A successful connector response is not enough. Fresh post-remedy evidence
must satisfy the configured postcondition before the action can close as
`compensated`.

An unanticipated or irreversible remedy becomes a new child action with its
own proposal, authorization, reservation and permit.

## Ambiguous remediation

A remedy timeout has the same uncertainty problem as an action timeout. The
rail records `REMEDY_UNKNOWN` and MUST NOT call the remedy operation again.

It calls the connector's remedy-status operation using the bound remedy
idempotency key:

- confirmed remedy effect transitions to `REMEDY_VERIFYING`
- confirmed no effect transitions to `REMEDY_FAILED`
- unresolved status transitions to `REVIEW_REQUIRED`

Fresh post-remedy evidence is still required after a confirmed effect. Stale,
invalid or unsatisfied evidence transitions to `REMEDY_INCONCLUSIVE`, then
closes as `disputed`.

When a disputed outcome leaves the external effect unresolved, active recourse
may remain reserved until its connector deadline. The receipt records that
status rather than implying the remedy was released.

## Event-chain construction

Each event contains:

- action id
- zero-based sequence
- previous event hash
- event type and actor
- recorded time
- privacy-minimized payload
- Ed25519 signature
- event hash

The event hash covers the signed event. The next event binds that hash through
`previous_hash`.

The chain is tamper-evident under the trusted key and retained chain head. A
privileged operator who controls the key and every checkpoint can rewrite
local history. The reference implementation does not claim otherwise.
