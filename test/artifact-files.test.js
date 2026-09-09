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
