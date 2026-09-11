import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runRefundDemo } from "../src/demo.js";
import { runRecoveryPreflightDemo } from "../src/recovery-demo.js";
import { digest } from "../src/canonical.js";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = args => spawnSync(process.execPath, [join(root, "cmd/crctl.js"), ...args], { cwd: root, encoding: "utf8", timeout: 10000 });

test("qualified-drill gates separate authentic failed drills from acceptance and freshness", async t => {
  const dir = mkdtempSync(join(tmpdir(), "rail-qualified-gate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const good = join(dir, "good.json"), failed = join(dir, "failed.json");
  const bundle = (await runRecoveryPreflightDemo()).bundle;
  writeFileSync(good, JSON.stringify(bundle));
  writeFileSync(failed, JSON.stringify((await runRecoveryPreflightDemo({ fault: "remedy-failure" })).bundle));
  for (const command of ["verify", "verify-many"]) {
    const accepted = cli(["recovery-preflight", command, good, "--require-qualified", "--json"]);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(JSON.parse(accepted.stdout).qualification_expectation_met, true);
    const rejected = cli(["recovery-preflight", command, failed, "--require-qualified", "--json"]);
    assert.equal(rejected.status, 1);
    assert.equal(JSON.parse(rejected.stdout).valid, true);
    assert.equal(JSON.parse(rejected.stdout).qualification_expectation_met, false);
    assert.equal(cli(["recovery-preflight", command, good, "--require-qualified", "--at", bundle.drill_attestation.expires_at]).status, 1);
  }
  const conflict = cli(["recovery-preflight", "verify-many", good, failed, "--json"]);
  assert.equal(conflict.status, 1);
  assert.equal(JSON.parse(conflict.stdout).review_required, true);
  assert.equal(cli(["recovery-preflight", "review", good, "--require-qualified"]).status, 1);
});

test("expected-outcome gates keep valid compensated receipts distinct from settled requirements", async t => {
  const dir = mkdtempSync(join(tmpdir(), "rail-outcome-gate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "compensated.json");
  writeFileSync(file, JSON.stringify((await runRefundDemo({ fault: "duplicate" })).bundle));
  for (const command of ["verify", "verify-many"]) {
    const accepted = cli(["bundle", command, file, "--require-outcome", "compensated", "--json"]);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(JSON.parse(accepted.stdout).outcome_expectation_met, true);
    const rejected = cli(["bundle", command, file, "--require-outcome", "settled", "--json"]);
    assert.equal(rejected.status, 1);
    assert.equal(JSON.parse(rejected.stdout).valid, true);
    assert.equal(JSON.parse(rejected.stdout).outcome_expectation_met, false);
  }
  assert.equal(cli(["bundle", "verify", file, "--require-outcome", "unknown"]).status, 1);
  assert.equal(cli(["bundle", "review", file, "--require-outcome", "settled"]).status, 1);
});
