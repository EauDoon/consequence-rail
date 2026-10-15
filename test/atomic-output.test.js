import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { MAX_ARTIFACT_BYTES, writeExclusiveArtifactText } from "../src/artifact-files.js";

const cli = fileURLToPath(new URL("../cmd/crctl.js", import.meta.url));

test("CLI partial output failure leaves no destination and can be retried", () => {
  const dir = mkdtempSync(join(tmpdir(), "rail atomic # output-"));
  try {
    const output = join(dir, "result.json"), injection = join(dir, "fail-write.mjs");
    writeFileSync(injection, `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const original = fs.writeFileSync;
      fs.writeFileSync = (path, data, options) => {
        original(path, data.slice(0, 10), options);
        throw Object.assign(new Error("synthetic disk full"), { code: "ENOSPC" });
      };
      syncBuiltinESMExports();
    `);
    const failed = spawnSync(process.execPath, ["--import", pathToFileURL(injection).href, cli, "demo", "refund", "--out", output, "--json"], { encoding: "utf8", timeout: 5000 });
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stderr, /Could not write file/);
    assert.equal(existsSync(output), false);
    assert.deepEqual(readdirSync(dir), ["fail-write.mjs"]);
    const retried = spawnSync(process.execPath, [cli, "demo", "refund", "--out", output, "--json"], { encoding: "utf8", timeout: 5000 });
    assert.equal(retried.status, 0, retried.stderr);
    assert.equal(JSON.parse(readFileSync(output, "utf8")).profile, "audit");
    assert.deepEqual(readdirSync(dir).sort(), ["fail-write.mjs", "result.json"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("atomic publication preserves existing output and removes staging files", () => {
  const dir = mkdtempSync(join(tmpdir(), "rail-atomic-existing-"));
  try {
    const output = join(dir, "result.txt");
    writeExclusiveArtifactText(output, "complete result\n");
    assert.throws(() => writeExclusiveArtifactText(output, "replacement"), /Refusing to overwrite/);
    assert.equal(readFileSync(output, "utf8"), "complete result\n");
    assert.deepEqual(readdirSync(dir), ["result.txt"]);
    assert.throws(() => writeExclusiveArtifactText(join(dir, "too-large"), "界".repeat(MAX_ARTIFACT_BYTES)), { code: "ARTIFACT_TOO_LARGE" });
    assert.deepEqual(readdirSync(dir), ["result.txt"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("atomic output never follows an existing destination symlink", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rail-atomic-symlink-"));
  try {
    const target = join(dir, "target"), output = join(dir, "result.txt");
    writeFileSync(target, "unchanged");
    try { symlinkSync(target, output); }
    catch (error) { if (error.code === "EPERM") { t.skip("symlink creation unavailable"); return; } throw error; }
    assert.throws(() => writeExclusiveArtifactText(output, "replacement"), /Refusing to overwrite/);
    assert.equal(readFileSync(target, "utf8"), "unchanged");
    assert.deepEqual(readdirSync(dir).sort(), ["result.txt", "target"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
