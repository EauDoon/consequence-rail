import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRecoveryPreflightDemo } from "../src/recovery-demo.js";
import { demoRecoveryTrustedKeys } from "../src/signing.js";
import { verifyRecoveryFiles } from "../src/batch.js";

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
