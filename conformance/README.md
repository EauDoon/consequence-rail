# Conformance fixtures

The fixtures in this directory are synthetic and deterministic. They provide
portable inputs for implementations of the v0.1 artifact model.

`refund-action.json` is the canonical positive `ActionProposal` example. A
conforming implementation must accept it, produce the same action digest for
any semantically identical object-key ordering, and reject any unknown
top-level field.

The executable fault matrix lives in the Node.js test suite:

```text
node --test
```

The current vectors test digest binding, connector-backed recourse, permit
replay, action mutation, ambiguous execution, ambiguous remediation, stale
evidence, semantic verification, bounded remediation and tamper detection. No
fixture contains real financial, customer or infrastructure data.
