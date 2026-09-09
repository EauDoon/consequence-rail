import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function runCli(script, args, { timeout = 5_000, env } = {}) {
  return spawnSync(process.execPath, [join(root, "cmd", script), ...args], {
    cwd: root,
    encoding: "utf8",
    timeout,
    env: env === undefined ? process.env : { ...process.env, ...env },
  });
}

function stderrJson(result) {
  return JSON.parse(result.stderr.trim());
}

test("crctl help lists commands, faults, and flags", () => {
  const result = runCli("crctl.js", ["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /crctl demo refund/);
  assert.match(result.stdout, /--fault <name>/);
  assert.match(result.stdout, /lost-response-after-commit/);
  assert.match(result.stdout, /missing-checkpoint/);
  assert.match(result.stdout, /enforced, cooperative, observed/);
  assert.match(result.stdout, /-h, --help/);
});

test("crctl rejects unknown commands and incomplete usage", () => {
  const unknown = runCli("crctl.js", ["explode"]);
  assert.equal(unknown.status, 1);
  assert.deepEqual(stderrJson(unknown), {
    code: "USAGE_INVALID",
    message: "Unknown command 'explode'. Run with --help.",
  });

  const demoOnly = runCli("crctl.js", ["demo"]);
  assert.equal(demoOnly.status, 1);
  assert.match(stderrJson(demoOnly).message, /Missing demo scenario/);

  const unknownDemo = runCli("crctl.js", ["demo", "nope"]);
  assert.equal(unknownDemo.status, 1);
  assert.match(stderrJson(unknownDemo).message, /Unknown demo scenario 'nope'/);

  const verifyNoFile = runCli("crctl.js", ["bundle", "verify"]);
  assert.equal(verifyNoFile.status, 1);
  assert.match(stderrJson(verifyNoFile).message, /Missing bundle file/);
});

test("crctl rejects missing flag values, flag-shaped values, and unknown flags", () => {
  const missingFault = runCli("crctl.js", ["demo", "refund", "--fault"]);
  assert.equal(missingFault.status, 1);
  assert.deepEqual(stderrJson(missingFault), {
    code: "USAGE_INVALID",
    message: "--fault requires a value. Run with --help.",
  });

  const flagAsValue = runCli("crctl.js", ["demo", "refund", "--fault", "--json"]);
  assert.equal(flagAsValue.status, 1);
  assert.deepEqual(stderrJson(flagAsValue), {
    code: "USAGE_INVALID",
    message: "--fault requires a value. Run with --help.",
  });

  const missingOut = runCli("crctl.js", ["demo", "refund", "--out"]);
  assert.equal(missingOut.status, 1);
  assert.match(stderrJson(missingOut).message, /--out requires a value/);

  const unknownFlag = runCli("crctl.js", ["demo", "irreversible", "--fault", "duplicate"]);
  assert.equal(unknownFlag.status, 1);
  assert.match(stderrJson(unknownFlag).message, /Flag --fault is not valid/);

  const unknownName = runCli("crctl.js", ["demo", "refund", "--typo"]);
  assert.equal(unknownName.status, 1);
  assert.match(stderrJson(unknownName).message, /Unknown flag --typo/);
});

test("crctl lists valid names when a demo fault or assurance mode is unknown", () => {
  const fault = runCli("crctl.js", ["demo", "refund", "--fault", "not-a-fault"]);
  assert.equal(fault.status, 1);
  const faultError = stderrJson(fault);
  assert.equal(faultError.code, "USAGE_INVALID");
  assert.match(faultError.message, /Unknown refund demo fault 'not-a-fault'/);
  assert.match(faultError.message, /duplicate/);

  const recoveryFault = runCli("crctl.js", [
    "demo",
    "recovery-preflight",
    "--fault",
    "duplicate",
  ]);
  assert.equal(recoveryFault.status, 1);
  assert.match(
    stderrJson(recoveryFault).message,
    /Unknown recovery-preflight demo fault 'duplicate'/,
  );

  const assurance = runCli("crctl.js", ["demo", "refund", "--assurance", "prevented"]);
  assert.equal(assurance.status, 1);
  assert.match(stderrJson(assurance).message, /Unknown assurance mode 'prevented'/);
});

test("crctl maps missing, empty, and invalid JSON files to usage errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "consequence-rail-cli-"));
  const missingPath = join(dir, "missing.json");
  const emptyPath = join(dir, "empty.json");
  const invalidPath = join(dir, "invalid.json");
  writeFileSync(emptyPath, "\n");
  writeFileSync(invalidPath, "{not-json");

  const missing = runCli("crctl.js", ["bundle", "verify", missingPath]);
  assert.equal(missing.status, 1);
  assert.equal(stderrJson(missing).code, "USAGE_INVALID");
  assert.match(stderrJson(missing).message, /File not found/);

  const empty = runCli("crctl.js", ["bundle", "verify", emptyPath]);
  assert.equal(empty.status, 1);
  assert.match(stderrJson(empty).message, /File is empty/);

  const invalid = runCli("crctl.js", ["recovery-preflight", "verify", invalidPath]);
  assert.equal(invalid.status, 1);
  assert.match(stderrJson(invalid).message, /File is not valid JSON/);
});

test("rail --help prints usage and does not start the sidecar", () => {
  const result = runCli("rail.js", ["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /--port <number>/);
  assert.match(result.stdout, /--clock <system\|demo>/);
  assert.match(result.stdout, /CONSEQUENCE_RAIL_PORT/);
  assert.match(result.stdout, /CONSEQUENCE_RAIL_CLOCK/);
  assert.doesNotMatch(result.stdout, /listening/);
  assert.equal(result.stderr, "");
});

test("rail rejects missing --port values and unknown arguments", () => {
  const missingPort = runCli("rail.js", ["--port"]);
  assert.equal(missingPort.status, 1);
  assert.deepEqual(stderrJson(missingPort), {
    code: "USAGE_INVALID",
    message: "--port requires an integer between 0 and 65535.",
  });

  const unknown = runCli("rail.js", ["--help-me"]);
  assert.equal(unknown.status, 1);
  assert.deepEqual(stderrJson(unknown), {
    code: "USAGE_INVALID",
    message: "Unknown argument --help-me.",
  });
});

test("rail rejects invalid --clock values and CONSEQUENCE_RAIL_* defaults", () => {
  const missingClock = runCli("rail.js", ["--clock"]);
  assert.equal(missingClock.status, 1);
  assert.deepEqual(stderrJson(missingClock), {
    code: "USAGE_INVALID",
    message: "--clock requires a value of system or demo.",
  });

  const unknownClock = runCli("rail.js", ["--clock", "production"]);
  assert.equal(unknownClock.status, 1);
  assert.deepEqual(stderrJson(unknownClock), {
    code: "USAGE_INVALID",
    message: "--clock must be one of: system, demo.",
  });

  const duplicateClock = runCli("rail.js", ["--clock", "demo", "--clock", "system"]);
  assert.equal(duplicateClock.status, 1);
  assert.deepEqual(stderrJson(duplicateClock), {
    code: "USAGE_INVALID",
    message: "Flag --clock was supplied more than once.",
  });

  const envPort = runCli("rail.js", [], { env: { CONSEQUENCE_RAIL_PORT: "70000" } });
  assert.equal(envPort.status, 1);
  assert.deepEqual(stderrJson(envPort), {
    code: "USAGE_INVALID",
    message: "CONSEQUENCE_RAIL_PORT must be an integer between 0 and 65535.",
  });

  const envClock = runCli("rail.js", [], { env: { CONSEQUENCE_RAIL_CLOCK: "frozen" } });
  assert.equal(envClock.status, 1);
  assert.deepEqual(stderrJson(envClock), {
    code: "USAGE_INVALID",
    message: "CONSEQUENCE_RAIL_CLOCK must be one of: system, demo.",
  });

  const emptyEnvUsesFlags = runCli("rail.js", ["--clock"], {
    env: { CONSEQUENCE_RAIL_PORT: "", CONSEQUENCE_RAIL_CLOCK: "" },
  });
  assert.equal(emptyEnvUsesFlags.status, 1);
  assert.equal(
    stderrJson(emptyEnvUsesFlags).message,
    "--clock requires a value of system or demo.",
  );

  const flagOverridesInvalidEnv = runCli("rail.js", ["--help"], {
    env: { CONSEQUENCE_RAIL_PORT: "not-a-port", CONSEQUENCE_RAIL_CLOCK: "frozen" },
  });
  assert.equal(flagOverridesInvalidEnv.status, 0);
});
import { rmSync } from "node:fs";
import { runRecoveryPreflightDemo } from "../src/recovery-demo.js";

test("recovery CLI checks explicit time with exclusive expiry and future drill rejection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rail-freshness-"));
  try {
    const { bundle } = await runRecoveryPreflightDemo();
    const file = join(dir, "drill.json");
    writeFileSync(file, JSON.stringify(bundle));
    const run = (at) => runCli("crctl.js", ["recovery-preflight", "verify", file, "--json", ...(at ? ["--at", at] : [])]);
    assert.equal(JSON.parse(run().stdout).freshness_checked, false);
    const current = run(bundle.drill_attestation.drilled_at);
    assert.equal(current.status, 0);
    assert.equal(JSON.parse(current.stdout).current, true);
    assert.equal(stderrJson(run(bundle.drill_attestation.expires_at)).code, "RECOVERY_ATTESTATION_EXPIRED");
    assert.equal(stderrJson(run("2000-01-01T00:00:00.000Z")).code, "RECOVERY_ATTESTATION_EXPIRED");
    assert.equal(run("yesterday").status, 1);
    assert.equal(runCli("crctl.js", ["demo", "refund", "--at", bundle.drill_attestation.drilled_at]).status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
import { runRefundDemo } from "../src/demo.js";
import { digest } from "../src/canonical.js";

test("CLI verifies pinned bytes and fails closed for another otherwise valid artifact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rail-pin-"));
  try {
    const { bundle } = await runRefundDemo();
    const file = join(dir, "audit.json");
    writeFileSync(file, JSON.stringify(bundle));
    const run = (pin) => runCli("crctl.js", ["bundle", "verify", file, "--expect-digest", pin, "--json"]);
    assert.equal(JSON.parse(run(digest(bundle)).stdout).bundle_digest, digest(bundle));
    assert.equal(stderrJson(run(digest({}))).code, "DIGEST_PIN_MISMATCH");
    assert.equal(stderrJson(run("invalid")).code, "DIGEST_PIN_INVALID");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("CLI and batch reject duplicate members before accepting an otherwise valid signature", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rail-duplicate-"));
  try {
    const { bundle } = await runRefundDemo();
    const file = join(dir, "duplicate.json");
    const original = JSON.stringify(bundle);
    writeFileSync(file, '{"profile":"receipt",' + original.slice(1));
    const single = runCli("crctl.js", ["bundle", "verify", file, "--json"]);
    assert.equal(single.status, 1);
    assert.equal(stderrJson(single).code, "JSON_DUPLICATE_KEY");
    writeFileSync(file, '{"\\u0070rofile":"receipt",' + original.slice(1));
    const batch = runCli("crctl.js", ["bundle", "verify-many", file, "--json"]);
    assert.equal(batch.status, 1);
    assert.equal(JSON.parse(batch.stdout).results[0].code, "JSON_DUPLICATE_KEY");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("new CLI workflows exercise verified review, comparison, batch, catalog and matrix", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rail-workflows-"));
  try {
    const first = join(dir, "first.json"), second = join(dir, "second.json");
    const { bundle } = await runRefundDemo();
    writeFileSync(first, JSON.stringify(bundle));
    writeFileSync(second, JSON.stringify((await runRefundDemo({ fault: "duplicate" })).bundle));
    const review = runCli("crctl.js", ["bundle", "review", first, "--json"]);
    assert.equal(review.status, 0);
    assert.equal(JSON.parse(review.stdout).verification_scope, "integrity_and_lifecycle_semantics");
    assert.equal(JSON.parse(review.stdout).trust_profile, "public_demo_keys_only");
    const compare = runCli("crctl.js", ["bundle", "compare", first, second, "--json"]);
    assert.equal(compare.status, 0);
    assert.equal(JSON.parse(compare.stdout).same_receipt, false);
    const batch = runCli("crctl.js", ["bundle", "verify-many", first, second, "--json"]);
    assert.equal(batch.status, 0);
    assert.equal(JSON.parse(batch.stdout).passed, 2);
    assert.equal(JSON.parse(runCli("crctl.js", ["demo", "list", "--json"]).stdout).scenarios.length, 4);
    const matrix = runCli("crctl.js", ["demo", "matrix", "--json"]);
    assert.equal(matrix.status, 0);
    assert.equal(JSON.parse(matrix.stdout).passed, 31);
    for (const args of [["bundle", "compare", first], ["demo", "matrix", "bogus"], ["bundle", "review", first, "--fault", "duplicate"]]) {
      assert.equal(runCli("crctl.js", args).status, 1);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
