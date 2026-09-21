// Canonicalization, event-store snapshot, and failure-atomic append tests
// for the consequence-rail module. Split from test/rail.test.js.

import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, deepClone, digest } from "../src/canonical.js";
import { ManualClock } from "../src/clock.js";
import { buildRefundProposal, prepareRefund } from "../src/demo.js";
import { MemoryEventStore, verifyEventChain } from "../src/event-store.js";
import { createDemoSigner, demoTrustedKeys } from "../src/signing.js";
import {
  createFailingAtomicEventStore,
  createRuntimeWithEventStore,
  createToggleEventStore,
} from "../src/rail-test-helpers.js";

test("canonical action digest is independent of object key order", () => {
  const left = {
    alpha: 1,
    beta: {
      first: true,
      second: "value",
    },
  };
  const right = {
    beta: {
      second: "value",
      first: true,
    },
    alpha: 1,
  };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(digest(left), digest(right));
});

test("canonicalization rejects prototype-sensitive fields without collisions", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const hostile = JSON.parse(`{"${key}":{"changed":true}}`);
    assert.throws(
      () => digest(hostile),
      (error) => error.code === "CANONICALIZATION_FAILED",
    );
  }
  assert.notEqual(
    JSON.stringify(JSON.parse('{"__proto__":{"changed":true}}')),
    JSON.stringify({}),
  );
});

test("canonicalization rejects proxies without invoking their traps", () => {
  for (const target of [{ safe: true }, [true]]) {
    let trapCalls = 0;
    const proxy = new Proxy(target, {
      getPrototypeOf() {
        trapCalls += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys() {
        trapCalls += 1;
        return Reflect.ownKeys(target);
      },
    });
    for (const operation of [canonicalJson, deepClone]) {
      assert.throws(
        () => operation(proxy),
        (error) => error.code === "CANONICALIZATION_FAILED",
      );
    }
    assert.equal(trapCalls, 0);
  }
});

test("event store snapshots cannot be mutated through inputs or returned events", () => {
  const signer = createDemoSigner();
  const store = new MemoryEventStore(signer, new ManualClock());
  const payload = { result: { status: "recorded" } };
  const appended = store.append("act_snapshot_test", "TEST_RECORDED", "test", payload);

  payload.result.status = "mutated-input";
  assert.equal(payload.result.status, "mutated-input");
  appended.payload.result.status = "mutated-return";
  const listed = store.list("act_snapshot_test");
  listed[0].payload.result.status = "mutated-list";

  const reread = store.list("act_snapshot_test");
  assert.equal(reread[0].payload.result.status, "recorded");
  assert.deepEqual(verifyEventChain(reread, demoTrustedKeys()), {
    valid: true,
    event_count: 1,
    chain_head: reread[0].event_hash,
  });
});

test("MemoryEventStore append failures cannot advance the event revision", () => {
  const clock = new ManualClock();
  const store = new MemoryEventStore(createDemoSigner(), clock);
  assert.equal(store.failureAtomicAppend, true);
  assert.throws(
    () => store.append("act_clone_failure", "TEST_RECORDED", "test", {
      invalid: undefined,
    }),
    (error) => error.code === "CANONICALIZATION_FAILED",
  );
  assert.deepEqual(store.list("act_clone_failure"), []);

  const signingFailureStore = new MemoryEventStore({ kid: "missing-private-key" }, clock);
  assert.throws(
    () => signingFailureStore.append(
      "act_signing_failure",
      "TEST_RECORDED",
      "test",
      { valid: true },
    ),
    (error) => error.code === "SIGNING_INVALID",
  );
  assert.deepEqual(signingFailureStore.list("act_signing_failure"), []);
});

test("a declared failure-atomic transition append preserves state and revision", () => {
  const runtime = createRuntimeWithEventStore(createFailingAtomicEventStore);
  const proposed = runtime.rail.propose(buildRefundProposal(runtime.clock));
  const before = runtime.rail.inspect(proposed.action_id);
  assert.equal(runtime.rail.eventStore.failureAtomicAppend, true);
  assert.equal(Object.isFrozen(runtime.rail.eventStore), true);
  assert.throws(
    () => { runtime.rail.eventStore.append = () => {}; },
    TypeError,
  );
  assert.throws(
    () => { runtime.rail.eventStore = createFailingAtomicEventStore; },
    TypeError,
  );

  assert.throws(
    () => runtime.rail.authorize(proposed.action_id, {
      allow: true,
      policy_id: "demo-refund-policy/v1",
      policy_digest: digest({ max_amount_minor: 25_000, currency: "USD" }),
    }),
    /event store unavailable/,
  );
  assert.deepEqual(runtime.rail.inspect(proposed.action_id), before);
});

test("failed permit-consumed append cannot retain the use count", async () => {
  const runtime = createRuntimeWithEventStore(createToggleEventStore);
  const { actionId } = prepareRefund(runtime);
  const before = runtime.rail.inspect(actionId);
  runtime.eventStore.failOn.add("STATE_TRANSITION");
  await assert.rejects(
    () => runtime.rail.execute(actionId),
    /event store unavailable/,
  );
  assert.deepEqual(runtime.rail.inspect(actionId), before);
});

test("failed execution-transition append cannot retain the connector result", async () => {
  const runtime = createRuntimeWithEventStore(createToggleEventStore);
  const { actionId } = prepareRefund(runtime);
  runtime.eventStore.skipTransitions = 1;
  runtime.eventStore.failOn.add("STATE_TRANSITION");
  await assert.rejects(
    () => runtime.rail.execute(actionId),
    /event store unavailable/,
  );
  const record = runtime.rail.get(actionId);
  assert.equal(record.state, "EXECUTING");
  assert.equal(record.permit_uses, 1);
  assert.equal(record.execution, undefined);
});

test("failed ambiguous-execution append cannot retain the unknown result", async () => {
  const runtime = createRuntimeWithEventStore(createToggleEventStore);
  const { actionId } = prepareRefund(runtime);
  runtime.rail.connector.execute = async () => { throw new Error("timeout"); };
  runtime.eventStore.failOn.add("STATE_TRANSITION");
  await assert.rejects(
    () => runtime.rail.execute(actionId),
    /event store unavailable/,
  );
  const record = runtime.rail.get(actionId);
  assert.equal(record.state, "PERMITTED");
  assert.equal(record.execution, undefined);
});

test("failed evidence append cannot retain uncommitted evidence", async () => {
  const runtime = createRuntimeWithEventStore(createToggleEventStore);
  const { actionId } = prepareRefund(runtime);
  await runtime.rail.execute(actionId);
  runtime.eventStore.failOn.add("EVIDENCE_ACCEPTED");
  await assert.rejects(
    () => runtime.rail.verifyOutcome(actionId),
    /event store unavailable/,
  );
  assert.equal(runtime.rail.get(actionId).evidence.length, 0);
});

test("failed remedy-started append cannot retain the attempt count", async () => {
  const runtime = createRuntimeWithEventStore(createToggleEventStore);
  const { actionId } = prepareRefund(runtime);
  await runtime.rail.execute(actionId, { fault: "duplicate" });
  await runtime.rail.verifyOutcome(actionId);
  const before = runtime.rail.inspect(actionId);
  runtime.eventStore.failOn.add("STATE_TRANSITION");
  await assert.rejects(
    () => runtime.rail.remediate(actionId),
    /event store unavailable/,
  );
  assert.deepEqual(runtime.rail.inspect(actionId), before);
});

test("failed remedy-unknown append cannot retain the unknown result", async () => {
  const runtime = createRuntimeWithEventStore(createToggleEventStore);
  const { actionId } = prepareRefund(runtime);
  await runtime.rail.execute(actionId, { fault: "duplicate" });
  await runtime.rail.verifyOutcome(actionId);
  runtime.rail.connector.remediate = async () => { throw new Error("timeout"); };
  runtime.eventStore.skipTransitions = 1;
  runtime.eventStore.failOn.add("STATE_TRANSITION");
  await assert.rejects(
    () => runtime.rail.remediate(actionId),
    /event store unavailable/,
  );
  const record = runtime.rail.get(actionId);
  assert.equal(record.state, "REMEDIATING");
  assert.equal(record.remedy_attempts, 1);
  assert.equal(record.remedy_result, undefined);
});

test("failed remedy-evidence append cannot retain uncommitted evidence", async () => {
  const runtime = createRuntimeWithEventStore(createToggleEventStore);
  const { actionId } = prepareRefund(runtime);
  await runtime.rail.execute(actionId, { fault: "duplicate" });
  await runtime.rail.verifyOutcome(actionId);
  const before = runtime.rail.get(actionId).evidence.length;
  runtime.eventStore.failOn.add("REMEDY_EVIDENCE_ACCEPTED");
  await assert.rejects(
    () => runtime.rail.remediate(actionId),
    /event store unavailable/,
  );
  assert.equal(runtime.rail.get(actionId).evidence.length, before);
});

test("failed reconciled-status append cannot retain the observed result", async () => {
  const runtime = createRuntimeWithEventStore(createToggleEventStore);
  const { actionId } = prepareRefund(runtime);
  runtime.rail.connector.execute = async () => { throw new Error("timeout"); };
  await runtime.rail.execute(actionId);
  assert.equal(runtime.rail.get(actionId).state, "UNKNOWN");
  const before = runtime.rail.inspect(actionId);
  runtime.eventStore.failOn.add("STATE_TRANSITION");
  await assert.rejects(
    () => runtime.rail.reconcile(actionId),
    /event store unavailable/,
  );
  assert.deepEqual(runtime.rail.inspect(actionId), before);
});

test("failed authorization append cannot retain recovery-preflight side effects", () => {
  const runtime = createRuntimeWithEventStore(createFailingAtomicEventStore, {
    requireRecoveryPreflight: true,
  });
  const proposed = runtime.rail.propose(buildRefundProposal(runtime.clock));
  const before = runtime.rail.inspect(proposed.action_id);

  assert.throws(
    () => runtime.rail.authorize(proposed.action_id, {
      allow: true,
      policy_id: "demo-refund-policy/v1",
      policy_digest: digest({ max_amount_minor: 25_000, currency: "USD" }),
    }),
    /event store unavailable/,
  );
  assert.deepEqual(runtime.rail.inspect(proposed.action_id), before);
});

test("ambiguous or incomplete event stores are rejected before append", () => {
  for (const eventStore of [
    {
      appendCalls: 0,
      append(...args) {
        this.appendCalls += 1;
        this.events.push(args);
        throw new Error("post-write failure");
      },
      events: [],
      list() { return deepClone(this.events); },
    },
    {
      failureAtomicAppend: false,
      appendCalls: 0,
      append(...args) {
        this.appendCalls += 1;
        this.events.push(args);
        throw new Error("post-write failure");
      },
      events: [],
      list() { return deepClone(this.events); },
    },
    { failureAtomicAppend: true, append() {} },
    { failureAtomicAppend: true, list() { return []; } },
  ]) {
    assert.throws(
      () => createRuntimeWithEventStore(() => eventStore),
      (error) => error.code === "CONFIG_INVALID",
    );
    assert.equal(eventStore.appendCalls ?? 0, 0);
    assert.deepEqual(eventStore.events ?? [], []);
  }
});
