import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { writeExclusiveArtifactText } from "../src/artifact-files.js";

test("artifact publication remains private even with a permissive umask", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "rail-permissions-"));
  const file = join(dir, "artifact.json");
  try {
    // Change umask in a subprocess only, never globally in the concurrent suite.
    const module = new URL("../src/artifact-files.js", import.meta.url).href;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { writeExclusiveArtifactText } from ${JSON.stringify(module)}; process.umask(0); writeExclusiveArtifactText(process.argv[1], '{}\\n');`, file], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file, "utf8"), "{}\n");
    assert.throws(() => writeExclusiveArtifactText(file, "replacement"), { code: "USAGE_INVALID" });
    assert.equal(readFileSync(file, "utf8"), "{}\n");
    assert.deepEqual(readdirSync(dir), ["artifact.json"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
