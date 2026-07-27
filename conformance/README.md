# Conformance fixtures

The fixtures in this directory are synthetic and deterministic. They provide
portable inputs for implementations of the artifact model.

`refund-action.json` is the canonical positive `ActionProposal` example. A
conforming implementation must accept it, produce the same action digest for
any semantically identical object-key ordering, and reject any unknown
top-level field.

`refund-recovery-contract.json` is the canonical Recovery Preflight contract.
It pins a synthetic duplicate-refund fault, the actual mock connector remedy,
an exact declared-state oracle, the signed reservation and connector
commitment, capability reference, measured connector and adapter callables, a
precommitted checkpoint, and the complete action-envelope digests. The adapter
digest uses the registered callable-source v2 profile and includes the live
`run` callable that the runner captures before invocation.

The executable fault matrix lives in the Node.js test suite:

```text
node --test
```

The current vectors test digest binding, connector-backed recourse, permit
replay, action mutation, ambiguous execution, ambiguous remediation, stale
evidence, semantic verification, bounded remediation, recovery qualification
and tamper detection, including hostile object keys and HTTP boundary
rejections. No fixture contains real financial, customer or
infrastructure data.
