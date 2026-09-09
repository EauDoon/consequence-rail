import assert from "node:assert/strict";
import test from "node:test";
import { runRecoveryPreflightDemo, RECOVERY_DEMO_FAULTS } from "../src/recovery-demo.js";
import { demoRecoveryTrustedKeys } from "../src/signing.js";
import { reviewRecovery } from "../src/recovery-review.js";
const trust = () => ({ trustedKeys: demoRecoveryTrustedKeys() });

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
  bundle.trace.oracle_satisfied = false;
  assert.throws(() => reviewRecovery(bundle, trust()));
});
