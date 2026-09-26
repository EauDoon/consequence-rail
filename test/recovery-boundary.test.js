import assert from "node:assert/strict";
import test from "node:test";
import { deepClone, digest, JSON_LIMITS } from "../src/canonical.js";
import { buildRefundProposal, buildRefundReservation, createDemoRuntime } from "../src/demo.js";
import { runRecoveryPreflightDemo } from "../src/recovery-demo.js";
import { verifyRecoveryPreflight } from "../src/recovery-preflight.js";
import { demoRecoveryTrustedKeys } from "../src/signing.js";
import { MemoryEventStore } from "../src/event-store.js";
import { ConsequenceRail } from "../src/rail.js";

function prepare(onAcceptance = () => {}) {
  const runtime = createDemoRuntime({ requireRecoveryPreflight: true });
  const eventStore = new MemoryEventStore(runtime.signer, runtime.clock);
  const append = eventStore.append.bind(eventStore);
  eventStore.append = (...args) => {
    if (args[1] === "RECOVERY_PREFLIGHT_ACCEPTED") onAcceptance();
    return append(...args);
  };
  runtime.rail = new ConsequenceRail({
    signer: runtime.signer, clock: runtime.clock, connector: runtime.connector,
    connectorTrustedKeys: runtime.connector.trustedKeys(), recoveryTrustedKeys: demoRecoveryTrustedKeys(),
    requireRecoveryPreflight: true, measureRecoveryImplementation: runtime.rail.measureRecoveryImplementation, eventStore,
  });
  const proposal = buildRefundProposal(runtime.clock);
  const { action_id: actionId, action_digest: actionDigest } = runtime.rail.propose(proposal);
  runtime.rail.authorize(actionId, {
    allow: true, policy_id: "snapshot-test/v1", policy_digest: digest({ allow: true }),
  });
  runtime.rail.reserveRecourse(actionId, buildRefundReservation(actionDigest, proposal, runtime.clock));
  return { ...runtime, actionId };
}

test("recovery verification validates the complete JSON boundary before reading evidence", async t => {
  const { bundle } = await runRecoveryPreflightDemo();
  let accessorCalls = 0;
  const cases = [
    ["hidden bundle field", value => Object.defineProperty(value, "local_metadata", { value: true })],
    ["hidden trust hint field", value => Object.defineProperty(value.trust_hint, "local_metadata", { value: true })],
    ["symbol bundle field", value => { value[Symbol("metadata")] = true; }],
    ["symbol trace field", value => { value.trace[Symbol("metadata")] = true; }],
    ["accessor trace", value => {
      const trace = value.trace;
      Object.defineProperty(value, "trace", { enumerable: true, get() { accessorCalls += 1; return trace; } });
    }],
    ["proxy bundle", value => new Proxy(value, { get(target, key) { accessorCalls += 1; return target[key]; } })],
    ["inherited hint field", value => Object.setPrototypeOf(value.trust_hint, { local_metadata: true })],
    ["reserved hint field", value => Object.defineProperty(value.trust_hint, "__proto__", { value: {}, enumerable: true })],
    ["over-budget hint", value => { value.trust_hint.warning = "x".repeat(JSON_LIMITS.maxStringUnits + 1); }],
  ];
  for (const [name, modify] of cases) {
    await t.test(name, () => {
      let input = deepClone(bundle);
      const replacement = modify(input);
      if (name === "proxy bundle") input = replacement;
      assert.throws(() => verifyRecoveryPreflight(input, {
        trustedKeys: demoRecoveryTrustedKeys(), requireCurrent: true, now: bundle.drill_attestation.drilled_at,
      }), { code: "CANONICALIZATION_FAILED" });
      const runtime = prepare();
      const before = runtime.rail.eventStore.list(runtime.actionId);
      assert.throws(() => runtime.rail.acceptRecoveryQualification(runtime.actionId, input), { code: "CANONICALIZATION_FAILED" });
      assert.deepEqual(runtime.rail.eventStore.list(runtime.actionId), before);
      assert.equal(runtime.rail.get(runtime.actionId).recovery_preflight, undefined);
      assert.equal(runtime.rail.get(runtime.actionId).recovery_preflight_verification, undefined);
      assert.equal(runtime.rail.inspect(runtime.actionId).state, "RECOURSE_RESERVED");
      assert.throws(() => runtime.rail.issuePermit(runtime.actionId), { code: "RECOVERY_PREFLIGHT_REQUIRED" });
      assert.equal(runtime.connector.executeCalls, 0);
      assert.equal(runtime.connector.remedyCalls, 0);
    });
  }
  assert.equal(accessorCalls, 0);
});

test("recovery acceptance retains the exact verified snapshot across event append", async () => {
  const { bundle } = await runRecoveryPreflightDemo();
  const input = deepClone(bundle);
  const runtime = prepare(() => { input.trace.oracle_satisfied = false; });
  runtime.rail.acceptRecoveryQualification(runtime.actionId, input);
  const retained = runtime.rail.get(runtime.actionId).recovery_preflight;
  assert.equal(input.trace.oracle_satisfied, false);
  assert.equal(digest(retained), digest(bundle));
  assert(Object.isFrozen(retained.trace));
  const event = runtime.rail.eventStore.list(runtime.actionId).at(-1);
  assert.equal(event.payload.attestation_digest, digest(retained.drill_attestation));
  assert.equal(verifyRecoveryPreflight(retained, { trustedKeys: demoRecoveryTrustedKeys() }).valid, true);
  runtime.rail.issuePermit(runtime.actionId);
  assert.equal(runtime.rail.inspect(runtime.actionId).state, "PERMITTED");
  assert.equal(runtime.connector.executeCalls, 0);
  assert.equal(runtime.connector.remedyCalls, 0);
});

test("failed acceptance append retains neither evidence nor an acceptance event", async () => {
  const { bundle } = await runRecoveryPreflightDemo();
  const runtime = prepare(() => { throw new Error("synthetic append failure"); });
  const before = runtime.rail.eventStore.list(runtime.actionId);
  assert.throws(() => runtime.rail.acceptRecoveryQualification(runtime.actionId, bundle), /synthetic append failure/);
  assert.deepEqual(runtime.rail.eventStore.list(runtime.actionId), before);
  assert.equal(runtime.rail.get(runtime.actionId).recovery_preflight, undefined);
  assert.equal(runtime.rail.get(runtime.actionId).recovery_preflight_verification, undefined);
  assert.throws(() => runtime.rail.issuePermit(runtime.actionId), { code: "RECOVERY_PREFLIGHT_REQUIRED" });
  assert.equal(runtime.connector.executeCalls, 0);
  assert.equal(runtime.connector.remedyCalls, 0);
});
