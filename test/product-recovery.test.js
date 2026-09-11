import assert from "node:assert/strict";
import test from "node:test";
import { runRecoveryPreflightDemo } from "../src/recovery-demo.js";
import { demoRecoveryTrustedKeys } from "../src/signing.js";
import { reviewRecovery } from "../src/recovery-review.js";

test("recovery review explains its effective validity and measured age", async () => {
  const { bundle } = await runRecoveryPreflightDemo();
  const trust = { trustedKeys: demoRecoveryTrustedKeys() };
  const report = reviewRecovery(bundle, trust);
  const start = Date.parse(bundle.drill_attestation.drilled_at);
  assert.equal(report.validity_window.valid_for_ms, Date.parse(report.expires_at) - start);
  assert.equal(report.validity_window.age_at_check_ms, null);
  assert.equal(report.validity_window.max_attestation_age_seconds, bundle.recovery_contract.max_attestation_age_seconds);
  const now = new Date(start + 1000).toISOString();
  const current = reviewRecovery(bundle, { ...trust, requireCurrent: true, now });
  assert.equal(current.validity_window.age_at_check_ms, 1000);
  assert.equal(current.remaining_validity_ms + 1000, current.validity_window.valid_for_ms);
  assert.throws(() => reviewRecovery(bundle, { ...trust, requireCurrent: true, now: report.expires_at }), { code: "RECOVERY_ATTESTATION_EXPIRED" });
});
