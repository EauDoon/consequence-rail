import assert from "node:assert/strict";
import test from "node:test";
import { runRecoveryPreflightDemo, RECOVERY_DEMO_FAULTS } from "../src/recovery-demo.js";
import { demoRecoveryTrustedKeys, demoTrustedKeys, demoConnectorTrustedKeys } from "../src/signing.js";
import { runRefundDemo } from "../src/demo.js";
import { runInventoryDemo } from "../src/inventory-demo.js";
import { reviewRecovery, compareRecovery, linkRecovery } from "../src/recovery-review.js";
const trust = () => ({ trustedKeys: demoRecoveryTrustedKeys() });

test("offline recovery link distinguishes binding agreement from recorded acceptance", async () => {
  const settlement = (await runRefundDemo()).bundle, drill = (await runRecoveryPreflightDemo()).bundle;
  const keys = { trustedKeys: demoTrustedKeys(), trustedConnectorKeys: demoConnectorTrustedKeys(), trustedRecoveryKeys: demoRecoveryTrustedKeys() };
  const before = JSON.stringify([settlement, drill]);
  const report = linkRecovery(settlement, drill, keys);
  assert.equal(report.bindings_match, true); assert.equal(report.acceptance_event_recorded, false);
  assert.equal(JSON.stringify([settlement, drill]), before);
  const other = (await runInventoryDemo()).bundle;
  assert.equal(linkRecovery(other, drill, keys).bindings_match, false);
  assert.throws(() => linkRecovery(settlement, drill, { ...keys, trustedRecoveryKeys: new Map() }));
});

test("linked accepted drill is identified without additional connector calls", async () => {
  const { runtime, bundle: drill } = await runRecoveryPreflightDemo();
  const actionId = [...runtime.rail.actions.keys()][0];
  await runtime.rail.execute(actionId); await runtime.rail.verifyOutcome(actionId);
  const settlement = runtime.rail.exportBundle(actionId, { profile: "audit" });
  const calls = [runtime.connector.executeCalls, runtime.connector.remedyCalls];
  const report = linkRecovery(settlement, drill, {
    trustedKeys: demoTrustedKeys(), trustedConnectorKeys: demoConnectorTrustedKeys(), trustedRecoveryKeys: demoRecoveryTrustedKeys(),
  });
  assert.equal(report.bindings_match, true); assert.equal(report.acceptance_event_recorded, true);
  assert.deepEqual([runtime.connector.executeCalls, runtime.connector.remedyCalls], calls);
});

test("recovery comparison isolates failed recovery from coverage changes", async () => {
  const good = (await runRecoveryPreflightDemo()).bundle;
  const failed = (await runRecoveryPreflightDemo({ fault: "remedy-failure" })).bundle;
  assert.deepEqual(compareRecovery(good, good, trust()).changes, []);
  const result = compareRecovery(good, failed, trust());
  assert.equal(result.same_bundle, false); assert.equal(result.same_action, true);
  assert(result.changes.some(item => item.field === "qualification"));
  assert(!JSON.stringify(result).includes("ord_demo_42"));
  const tampered = structuredClone(failed); tampered.recovery_contract.scope.connector = "other";
  assert.throws(() => compareRecovery(good, tampered, trust()));
});

test("recovery diagnosis explains every synthetic qualification without raw state disclosure", async () => {
  for (const fault of RECOVERY_DEMO_FAULTS) {
    const { bundle } = await runRecoveryPreflightDemo({ fault });
    const before = JSON.stringify(bundle), report = reviewRecovery(bundle, trust());
    assert.equal(report.qualification, bundle.drill_attestation.qualification);
    if (report.qualification === "QUALIFIED_EXACT") assert.deepEqual(report.failed_checks, []);
    else assert(report.failed_checks.length > 0);
    assert.equal(report.current, null); assert.equal(report.remaining_validity_ms, null);
    assert(!JSON.stringify(report).includes("ord_demo_42"));
    assert.equal(JSON.stringify(bundle), before);
    assert.throws(() => reviewRecovery(bundle));
  }
});

test("recovery diagnosis uses explicit freshness and rejects expiry and tampering", async () => {
  const { bundle } = await runRecoveryPreflightDemo();
  const report = reviewRecovery(bundle, { ...trust(), requireCurrent: true, now: bundle.drill_attestation.drilled_at });
  assert.equal(report.current, true); assert(report.remaining_validity_ms > 0);
  assert.throws(() => reviewRecovery(bundle, { ...trust(), requireCurrent: true, now: bundle.drill_attestation.expires_at }), { code: "RECOVERY_ATTESTATION_EXPIRED" });
  const tampered = structuredClone(bundle); tampered.trace.oracle_satisfied = false;
  assert.throws(() => reviewRecovery(tampered, trust()));
});
