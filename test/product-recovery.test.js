import assert from "node:assert/strict";
import test from "node:test";
import { runRecoveryPreflightDemo } from "../src/recovery-demo.js";
import { demoRecoveryTrustedKeys } from "../src/signing.js";
import { reviewRecovery } from "../src/recovery-review.js";
import { verifyRecoveryFiles } from "../src/batch.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("recovery collections distinguish duplicates from different signed drills", async t => {
  const dir = mkdtempSync(join(tmpdir(), "rail-drill-review-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const good = join(dir, "good.json"), failed = join(dir, "failed.json");
  writeFileSync(good, JSON.stringify((await runRecoveryPreflightDemo()).bundle));
  writeFileSync(failed, JSON.stringify((await runRecoveryPreflightDemo({ fault: "remedy-failure" })).bundle));
  const trust = { trustedKeys: demoRecoveryTrustedKeys() };
  const duplicate = verifyRecoveryFiles([good, good], trust);
  assert.equal(duplicate.duplicates.length, 1);
  assert.equal(duplicate.review_required, false);
  const differing = verifyRecoveryFiles([good, failed, join(dir, "missing.json")], trust);
  assert.equal(differing.passed, 2);
  assert.equal(differing.review_required, true);
  assert.equal(differing.differing_drills.length, 1);
  assert.equal(differing.differing_drills[0].attestation_digests.length, 2);
  assert.equal(differing.results[0].action_class, "demo.refund.issue/v1");
  assert.equal(differing.results[0].recovery_class, "exact");
});

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
