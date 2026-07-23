# Assurance modes

Assurance mode is part of the immutable `ActionProposal`, the signed
`ActionPermit`, and the signed `SettlementReceipt`.

## Enforced

Requirements:

- the rail exclusively controls the downstream credential
- the target or network rejects direct bypass
- recourse is active immediately before the protected call
- permit consumption occurs before the connector call
- the connector uses the action's bound idempotency key

Only this mode can claim that the reference execution path was gated.

The v0.1 mock connector declares exclusive credential custody for test
purposes. That declaration is synthetic.

The reference runtime rechecks recourse immediately before execution. Across
a real network boundary, the recourse lease and protected side effect must be
made atomic by the connector or target. A separate status check alone leaves
a time-of-check/time-of-use race and cannot support a strong enforced claim.

## Cooperative

The application asks the rail before executing, but another component may
retain a target credential or alternate route.

The permit and receipt MUST contain:

```json
{
  "assurance_mode": "cooperative",
  "bypass_possible": true
}
```

Cooperative mode can test the protocol and improve discipline. It cannot
claim that bypass was prevented.

## Observed

Observed mode records or inspects activity without controlling execution. It
MUST NOT:

- reserve execution recourse through the v0.1 rail
- issue an execution permit
- call the protected execution connector
- claim that the action was gated

The current reference runtime does not create settlement receipts for
observed activity.

## Downgrade rule

An integration must report the weakest mode supported by its real credential
and network boundary. Configuration labels do not create enforcement.
