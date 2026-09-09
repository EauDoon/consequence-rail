import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ARTIFACT_BYTES, readArtifactFile } from "../src/artifact-files.js";

test("artifact files accept UTF-8 JSON and reject oversized, invalid encoding and nonfiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "rail-artifact-"));
  const file = join(dir, "artifact.json");
  try {
    writeFileSync(file, '{"message":"hello"}');
    assert.deepEqual(readArtifactFile(file), { message: "hello" });
    writeFileSync(file, Buffer.from([0x22, 0xff, 0x22]));
    assert.throws(() => readArtifactFile(file), { code: "ARTIFACT_ENCODING_INVALID" });
    writeFileSync(file, " ".repeat(MAX_ARTIFACT_BYTES + 1));
    assert.throws(() => readArtifactFile(file), { code: "ARTIFACT_TOO_LARGE" });
    assert.throws(() => readArtifactFile(dir));
    writeFileSync(file, '{"__proto__":{"polluted":true}}');
    assert.throws(() => readArtifactFile(file), { code: "CANONICALIZATION_FAILED" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
import { verifyArtifactFiles } from "../src/batch.js";
import { runRefundDemo } from "../src/demo.js";
import { demoTrustedKeys, demoConnectorTrustedKeys } from "../src/signing.js";

test("batch verification isolates failures and requires full audit semantics", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rail-batch-"));
  try {
    const { bundle, runtime, summary } = await runRefundDemo();
    const good = join(dir, "good.json"), bad = join(dir, "bad.json"), receipt = join(dir, "receipt.json");
    writeFileSync(good, JSON.stringify(bundle));
    writeFileSync(bad, "{");
    writeFileSync(receipt, JSON.stringify(runtime.rail.exportBundle(summary.action_id)));
    const result = verifyArtifactFiles([good, bad, receipt, good], { trustedKeys: demoTrustedKeys(), trustedConnectorKeys: demoConnectorTrustedKeys() });
    assert.equal(result.valid, false);
    assert.equal(result.passed, 2);
    assert.equal(result.failed, 2);
    assert.equal(result.results[2].code, "SEMANTIC_INVALID");
    assert.equal(result.results[3].valid, true);
    for (const paths of [[], Array(65).fill(good), [null]]) assert.throws(() => verifyArtifactFiles(paths), { code: "BATCH_INVALID" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
