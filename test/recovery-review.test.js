import assert from "node:assert/strict";
import test from "node:test";
import { runRecoveryPreflightDemo, RECOVERY_DEMO_FAULTS } from "../src/recovery-demo.js";
import { demoRecoveryTrustedKeys, demoTrustedKeys, demoConnectorTrustedKeys, createDemoRecoverySigner } from "../src/signing.js";
import { runRefundDemo } from "../src/demo.js";
import { runInventoryDemo } from "../src/inventory-demo.js";
import { reviewRecovery, compareRecovery, linkRecovery } from "../src/recovery-review.js";
import { runRecoveryPreflight, recoveryCoverage } from "../src/recovery-preflight.js";
import { ManualClock } from "../src/clock.js";
import { MockRefundRecoveryAdapter } from "../src/mock-refund-recovery-adapter.js";
import { digest } from "../src/canonical.js";
const trust = () => ({ trustedKeys: demoRecoveryTrustedKeys() });

test("comparison reports recovery class changes while preserving protocol coverage identity", async () => {
  const original = (await runRecoveryPreflightDemo({ fault: "missing-checkpoint" })).bundle;
  const contract = structuredClone(original.recovery_contract); contract.recovery_class = "compensation";
  const clock = new ManualClock();
  const changed = await runRecoveryPreflight({ contract, clock,
    adapter: new MockRefundRecoveryAdapter(clock, { drillFault: "missing-checkpoint" }), signer: createDemoRecoverySigner() });
  assert.equal(reviewRecovery(changed, trust()).qualification, original.drill_attestation.qualification);
  assert.equal(digest(recoveryCoverage(contract)), digest(recoveryCoverage(original.recovery_contract)));
  const before = JSON.stringify([original, changed]);
  const result = compareRecovery(original, changed, trust());
  assert.equal(result.same_coverage, true); assert.equal(result.same_bundle, false);
  assert.deepEqual(result.changes, [{ field: "recovery_class", left: "exact", right: "compensation" }]);
  assert.equal(JSON.stringify([original, changed]), before);
});

test("comparison includes action class and contract validity fields even when attestation expiry is unchanged", async () => {
  const template = (await runRecoveryPreflightDemo({ fault: "missing-checkpoint" })).bundle.recovery_contract;
  const build = async contract => {
    const clock = new ManualClock();
    return runRecoveryPreflight({ contract, clock,
      adapter: new MockRefundRecoveryAdapter(clock, { drillFault: "missing-checkpoint" }), signer: createDemoRecoverySigner() });
  };
  for (const [field, value, displayed] of [
    ["action_class", "demo.other/v1", "action_class"],
    ["issued_at", "2034-12-31T23:59:59.000Z", "contract_issued_at"],
    ["expires_at", "2035-01-03T00:00:00.000Z", "contract_expires_at"],
    ["max_attestation_age_seconds", 600, "max_attestation_age_seconds"],
  ]) {
    const originalContract = structuredClone(template);
    if (field === "max_attestation_age_seconds") originalContract.expires_at = "2035-01-01T00:02:00.000Z";
    const changedContract = { ...originalContract, [field]: value };
    const original = await build(originalContract), changed = await build(changedContract);
    assert.equal(changed.drill_attestation.expires_at, original.drill_attestation.expires_at);
    const result = compareRecovery(original, changed, trust());
    const expected = [{ field: displayed, left: originalContract[field], right: value }];
    if (changed.drill_attestation.qualification !== original.drill_attestation.qualification) {
      expected.push({ field: "qualification", left: original.drill_attestation.qualification, right: changed.drill_attestation.qualification });
    }
    assert.deepEqual(result.changes, expected);
    assert.equal(result.same_coverage, field !== "action_class");
  }
});

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
