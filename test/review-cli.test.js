import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runRefundDemo } from "../src/demo.js";
import { runRecoveryPreflightDemo } from "../src/recovery-demo.js";
import { digest } from "../src/canonical.js";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = args => spawnSync(process.execPath, [join(root, "cmd/crctl.js"), ...args], { cwd: root, encoding: "utf8", timeout: 10000 });

test("all offline report inputs support independent digest pins before report or export", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rail-review-pin-"));
  const settlement = (await runRefundDemo()).bundle, recovery = (await runRecoveryPreflightDemo()).bundle;
  const audit = join(dir, "audit.json"), drill = join(dir, "drill.json");
  writeFileSync(audit, JSON.stringify(settlement)); writeFileSync(drill, JSON.stringify(recovery));
  for (const command of ["review", "evidence", "timing", "timeline"]) {
    const good = cli(["bundle", command, audit, "--expect-digest", digest(settlement), "--json"]);
    assert.equal(good.status, 0, good.stderr);
    const bad = cli(["bundle", command, audit, "--expect-digest", digest({}), "--json"]);
    assert.equal(bad.status, 1); assert.equal(bad.stdout, "");
    assert.equal(JSON.parse(bad.stderr).code, "DIGEST_PIN_MISMATCH");
  }
  const output = join(dir, "receipt.json");
  const refused = cli(["bundle", "receipt", audit, "--out", output, "--expect-digest", digest({})]);
  assert.equal(refused.status, 1); assert.equal(existsSync(output), false);
  for (const [group, command, left, right, leftDigest, rightDigest] of [
    ["bundle", "compare", audit, audit, digest(settlement), digest(settlement)],
    ["recovery-preflight", "compare", drill, drill, digest(recovery), digest(recovery)],
    ["recovery-preflight", "link", audit, drill, digest(settlement), digest(recovery)],
  ]) {
    const args = [group, command, left, right, "--expect-digest", leftDigest, "--expect-other-digest"];
    assert.equal(cli([...args, rightDigest]).status, 0);
    const bad = cli([...args, digest({})]); assert.equal(bad.status, 1); assert.equal(bad.stdout, "");
    assert.equal(JSON.parse(bad.stderr).code, "DIGEST_PIN_MISMATCH");
  }
});

test("offline CLI supports receipt round-trip, recovery diagnosis, batches and Markdown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rail-review-flow-"));
  const audit = join(dir, "audit.json"), receipt = join(dir, "receipt.json"), drill = join(dir, "drill.json");
  assert.equal(cli(["demo", "refund", "--fault", "duplicate", "--out", audit]).status, 0);
  assert.equal(cli(["bundle", "receipt", audit, "--out", receipt]).status, 0);
  const before = readFileSync(receipt);
  assert.equal(cli(["bundle", "receipt", audit, "--out", receipt]).status, 1);
  assert.deepEqual(readFileSync(receipt), before);
  assert.equal(JSON.parse(cli(["bundle", "review", receipt, "--json"]).stdout).verification_scope, "integrity_only");
  assert.equal(cli(["bundle", "timing", receipt]).status, 1);
  assert.equal(cli(["demo", "recovery-preflight", "--fault", "remedy-failure", "--out", drill]).status, 0);
  const report = JSON.parse(cli(["recovery-preflight", "review", drill]).stdout);
  assert.equal(report.qualification, "NOT_QUALIFIED"); assert(report.failed_checks.includes("oracle_satisfied"));
  assert.equal(cli(["recovery-preflight", "verify-many", drill, join(dir, "missing.json")]).status, 1);
  for (const [group, file] of [["bundle", audit], ["recovery-preflight", drill]]) {
    const rendered = cli([group, "review", file, "--markdown"]);
    assert.equal(rendered.status, 0); assert.match(rendered.stdout, /^# /); assert.match(rendered.stdout, /## Limits/);
    assert.equal(cli([group, "review", file, "--markdown", "--json"]).status, 1);
  }
});
