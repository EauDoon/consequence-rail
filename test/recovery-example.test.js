import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = args => spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", timeout: 10000 });

test("exported recovery example verifies independently and refuses stale, missing and altered evidence", t => {
  const parent = mkdtempSync(join(tmpdir(), "rail-recovery-example-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const destination = join(parent, "evidence");
  const example = run(["examples/recovery-evidence.js", destination]);
  assert.equal(example.status, 0, example.stderr);
  assert.equal(example.stdout, readFileSync(join(destination, "report.json"), "utf8"));
  const report = JSON.parse(example.stdout);
  assert.equal(report.cases.length, 9);
  assert.equal(report.cases.filter(row => row.result === "issued").length, 1);
  for (const row of report.cases) {
    assert.equal(row.acceptance_events_added, row.result === "issued" ? 1 : 0);
    assert.equal(row.live_connector_execute_calls, 0);
    assert.equal(row.live_connector_remedy_calls, 0);
  }
  const command = ["cmd/crctl.js", "recovery-preflight", "verify", join(destination, "drill.json"), "--require-qualified", "--json"];
  const current = run([...command, "--at", "2035-01-01T00:00:00.000Z", "--expect-digest", report.bundle_digest]);
  assert.equal(current.status, 0, current.stderr);
  assert.equal(JSON.parse(current.stdout).current, true);
  assert.equal(JSON.parse(current.stdout).qualification_expectation_met, true);
  const unchecked = run(command);
  assert.equal(unchecked.status, 0, unchecked.stderr);
  assert.equal(JSON.parse(unchecked.stdout).freshness_checked, false);
  const stale = run([...command, "--at", "2035-01-01T00:05:00.000Z"]);
  assert.equal(stale.status, 1);
  assert.equal(JSON.parse(stale.stderr).code, "RECOVERY_ATTESTATION_EXPIRED");
  for (const [file, code] of [["altered.json", "RECOVERY_BUNDLE_INVALID"], ["absent.json", "USAGE_INVALID"]]) {
    const refused = run(["cmd/crctl.js", "recovery-preflight", "verify", join(destination, file), "--at", "2035-01-01T00:00:00.000Z"]);
    assert.equal(refused.status, 1);
    assert.equal(JSON.parse(refused.stderr).code, code);
  }
  assert.equal(run(["examples/recovery-evidence.js", destination]).status, 1);
  assert.equal(readFileSync(join(destination, "report.json"), "utf8"), example.stdout);
});
