# Threat model

## Security objectives

The reference design aims to:

- reject action mutation after authorization
- reject permit replay and expiry
- bind execution to a reserved remedy
- prevent blind retry after ambiguous execution
- prevent blind retry after ambiguous remediation
- expose bypass risk through assurance mode
- validate evidence source, resource and freshness
- limit automatic remediation to the reserved scope
- detect event and receipt mutation under an explicitly trusted key
- avoid raw sensitive parameters in default inspection output

## Threats and current controls

### Credential bypass

Threat: another component calls the downstream API without the rail.

Control: `enforced` mode requires exclusive credential custody. Otherwise the
mode is `cooperative` or `observed`.

Residual risk: the reference connector only declares custody. A production
deployment must enforce it through target and network controls.

### Action mutation

Threat: parameters, target, postcondition or expiry change after approval.

Control: the permit binds the canonical `action_digest`. The rail recomputes
the digest immediately before connector invocation.

### Permit replay

Threat: a valid permit is used more than once.

Control: permits have `max_uses: 1`; consumption occurs synchronously before
the asynchronous connector call.

Residual risk: the in-memory store is a single-process demonstration. A
distributed deployment needs transactional shared consumption.

### Ambiguous timeout

Threat: the connector completed, but the response was lost and the rail
repeats the action.

Control: the rail records `UNKNOWN` and calls status using the bound
idempotency key. It never repeats `Execute` from `UNKNOWN`.

### False or stale evidence

Threat: evidence is wrong, incomplete, stale, or collusive.

Control: source, action digest, resource and freshness are checked. Signed
artifacts preserve what the rail captured.

Residual risk: signatures do not prove truth, independence or causality.

### Hollow remedy

Threat: a reservation names a remedy that cannot be executed.

Control: the connector signs an active reservation token bound to the exact
action, capability, scope, expiry and attempt limit. The rail verifies the
connector key and checks reservation status before permit issuance,
immediately before protected execution, and before remedy execution.
Terminal no-effect, expiry and revocation paths release or finalize the
reservation. A remedy is not considered complete until fresh evidence
verifies the resulting state.

Residual risk: capability advertisement can be dishonest or become
unavailable after reservation.

### Recourse revocation race

Threat: recourse is active when checked but expires or is revoked before the
protected side effect commits.

Control: the reference runtime checks status immediately before calling its
in-process mock connector and refuses execution without consuming the
connector action when the reservation is inactive.

Residual risk: a production network connector needs an atomic remote lease,
transaction, or target-enforced conditional operation. The reference
check-then-call sequence does not eliminate a remote time-of-check/time-of-use
race.

### Ambiguous remediation

Threat: the remedy completed, but the response was lost and the rail repeats
it.

Control: the rail records `REMEDY_UNKNOWN` and calls remedy status using the
bound remedy idempotency key. It never repeats the remedy from that state.

Residual risk: the connector's status response may itself be unavailable or
incorrect. The action then closes as disputed.

### Overbroad remediation

Threat: an error path creates wider authority than the original action.

Control: only the pre-reserved bounded remedy can run automatically.
Unanticipated or irreversible responses require a new action.

### Event rewriting

Threat: a local operator deletes, reorders or modifies event history.

Control: events are signed and hash-linked; receipts bind the chain head.

Residual risk: an operator controlling the signing key and every checkpoint
can rewrite local history. External checkpointing is deferred.

### Key compromise

Threat: an attacker signs false events or receipts.

Control: offline verification requires an explicit trusted-key set.

Residual risk: the deterministic demo rail and connector keys are public and
offer no production security. Production key management and rotation are not
implemented.

### Sensitive logs

Threat: action records disclose targets, identities, parameters or evidence
facts.

Control: inspection uses digests for resource identifiers and excludes raw
parameters. Event payloads contain digests and bounded metadata. The default
`receipt` bundle omits the full proposal and raw evidence.

Residual risk: an `audit` bundle contains the full proposal and outcome
evidence. The demo uses this profile only with synthetic data.

### Parser and resource attacks

Threat: hostile JSON causes denial of service or parser inconsistencies.

Control: the runtime uses the platform JSON parser, rejects unknown proposal
fields, and restricts postcondition operators.

Residual risk: request-size limits, fuzzing and production resource controls
are not yet implemented.

## Publication blockers

Do not describe the reference as production-ready while any of these remain:

- deterministic demo keys
- in-memory permit state
- no external checkpoint
- no production connector isolation
- no independent evidence trust adapter
- no request-size or rate controls
- incomplete cross-language canonicalization vectors
- no independent security review
