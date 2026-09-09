import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRecoveryPreflightDemo } from "../src/recovery-demo.js";
import { demoRecoveryTrustedKeys, demoTrustedKeys, demoConnectorTrustedKeys } from "../src/signing.js";
import { runRefundDemo } from "../src/demo.js";
import { verifyRecoveryFiles, verifyArtifactFiles } from "../src/batch.js";

test("settlement collections distinguish duplicate files from different signed receipts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rail-settlement-batch-"));
  const good = join(dir, "settled.json"), other = join(dir, "compensated.json"), invalid = join(dir, "invalid.json");
  writeFileSync(good, JSON.stringify((await runRefundDemo()).bundle));
  writeFileSync(other, JSON.stringify((await runRefundDemo({ fault: "duplicate" })).bundle));
  writeFileSync(invalid, "{}");
  const options = { trustedKeys: demoTrustedKeys(), trustedConnectorKeys: demoConnectorTrustedKeys() };
  const duplicate = verifyArtifactFiles([good, good], options);
  assert.equal(duplicate.duplicates.length, 1); assert.equal(duplicate.review_required, false);
  const different = verifyArtifactFiles([good, other], options);
  assert.equal(different.valid, true); assert.equal(different.review_required, true);
  assert.equal(different.differing_receipts.length, 1);
  assert.equal(different.differing_receipts[0].receipt_digests.length, 2);
  const bad = verifyArtifactFiles([good, invalid], options);
  assert.equal(bad.valid, false); assert.deepEqual(bad.differing_receipts, []);
});

test("recovery batch continues after invalid files and requires current evidence when requested", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rail-recovery-batch-"));
  const good = join(dir, "good.json"), bad = join(dir, "bad.json"), failed = join(dir, "failed.json");
  const bundle = (await runRecoveryPreflightDemo()).bundle;
  writeFileSync(good, JSON.stringify(bundle)); writeFileSync(bad, "{");
  writeFileSync(failed, JSON.stringify((await runRecoveryPreflightDemo({ fault: "remedy-failure" })).bundle));
  const options = { trustedKeys: demoRecoveryTrustedKeys() };
  const result = verifyRecoveryFiles([bad, good, failed], options);
  assert.equal(result.valid, false); assert.equal(result.passed, 2);
  assert.equal(result.results[2].qualification, "NOT_QUALIFIED");
  assert.equal(result.results[1].current, null);
  const expired = verifyRecoveryFiles([good], { ...options, requireCurrent: true, now: bundle.drill_attestation.expires_at });
  assert.equal(expired.results[0].code, "RECOVERY_ATTESTATION_EXPIRED");
  assert.throws(() => verifyRecoveryFiles([], options), { code: "BATCH_INVALID" });
  assert.throws(() => verifyRecoveryFiles(Array(65).fill(good), options), { code: "BATCH_INVALID" });
});
