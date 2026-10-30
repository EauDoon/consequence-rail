// Verifier-side trusted-keys files and crctl --trusted-keys.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digest } from "../src/canonical.js";
import { ManualClock } from "../src/clock.js";
import { prepareRefund, runRefundDemo } from "../src/demo.js";
import { MockRefundConnector } from "../src/mock-refund-connector.js";
import { MockRefundRecoveryAdapter } from "../src/mock-refund-recovery-adapter.js";
import { ConsequenceRail } from "../src/rail.js";
import { buildRefundRecoveryContract, runRecoveryPreflightDemo } from "../src/recovery-demo.js";
import { runRecoveryPreflight } from "../src/recovery-preflight.js";
import {
  createSigner,
  demoConnectorTrustedKeys,
  demoRecoveryTrustedKeys,
  demoTrustedKeys,
} from "../src/signing.js";
import {
  demoTrustConfig,
  loadTrustedKeysFile,
  parseTrustedKeys,
  TRUSTED_KEYS_SCHEMA_VERSION,
} from "../src/trust-config.js";
import { repoPath } from "../src/rail-test-helpers.js";

const cli = (args) => spawnSync(process.execPath, [repoPath("cmd", "crctl.js"), ...args], {
  cwd: repoPath(), encoding: "utf8", timeout: 15_000,
});

function pem(key, type = "spki") {
  return key.export({ format: "pem", type }).toString();
}

function edKey() {
  return generateKeyPairSync("ed25519");
}

function entry(keyId, publicKey) {
  return { key_id: keyId, public_key_pem: pem(publicKey) };
}

function config(fields) {
  return { schema_version: TRUSTED_KEYS_SCHEMA_VERSION, ...fields };
}

function refusal(value, pattern) {
  assert.throws(() => parseTrustedKeys(value), (error) => {
    assert.equal(error.code, "TRUST_CONFIG_INVALID");
    if (pattern) assert.match(error.message, pattern);
    assert.doesNotMatch(error.message, /MC[A-Za-z0-9+/]{20}|BEGIN|PRIVATE/);
    return true;
  });
}

async function ownKeyArtifacts(dir) {
  const railKey = edKey(), connectorKey = edKey(), recoveryKey = edKey();
  const railSigner = createSigner({ keyId: "ops-rail-2026", privateKey: railKey.privateKey });
  const connectorSigner = createSigner({ keyId: "ops-connector-2026", privateKey: connectorKey.privateKey });
  const recoverySigner = createSigner({ keyId: "ops-recovery-2026", privateKey: recoveryKey.privateKey });
  const clock = new ManualClock();
  const connector = new MockRefundConnector(clock, { signer: connectorSigner });
  const rail = new ConsequenceRail({ signer: railSigner, clock, connector, connectorTrustedKeys: connector.trustedKeys() });
  const { actionId } = prepareRefund({ clock, rail, connector, assuranceMode: "enforced" });
  await rail.execute(actionId, { fault: "none" });
  await rail.verifyOutcome(actionId, { fault: "none" });
  const drill = await runRecoveryPreflight({
    contract: buildRefundRecoveryContract(clock),
    adapter: new MockRefundRecoveryAdapter(clock),
    signer: recoverySigner,
    clock,
  });
  const paths = {
    audit: join(dir, "own-audit.json"),
    drill: join(dir, "own-drill.json"),
    trust: join(dir, "own-trust.json"),
    railOnly: join(dir, "own-rail-only.json"),
    recoveryOnly: join(dir, "own-recovery-only.json"),
  };
  writeFileSync(paths.audit, JSON.stringify(rail.exportBundle(actionId, { profile: "audit" })));
  writeFileSync(paths.drill, JSON.stringify(drill));
  const own = config({
    rail: [entry("ops-rail-2026", railKey.publicKey)],
    connector: [entry("ops-connector-2026", connectorKey.publicKey)],
    recovery: [entry("ops-recovery-2026", recoveryKey.publicKey)],
  });
  writeFileSync(paths.trust, JSON.stringify(own));
  writeFileSync(paths.railOnly, JSON.stringify(config({ rail: own.rail })));
  writeFileSync(paths.recoveryOnly, JSON.stringify(config({ recovery: own.recovery })));
  return { paths, own };
}

test("a trusted-keys document parses every role, including multi-key roles", () => {
  const [a, b, c, d] = [edKey(), edKey(), edKey(), edKey()];
  const parsed = parseTrustedKeys(config({
    rail: [entry("rail-outgoing", a.publicKey), entry("rail-incoming", b.publicKey)],
    connector: [entry("connector-1", c.publicKey)],
    recovery: [entry("recovery-1", d.publicKey)],
  }));
  assert.deepEqual([...parsed.rail.keys()], ["rail-outgoing", "rail-incoming"]);
  assert.equal(parsed.rail.get("rail-incoming").equals(b.publicKey), true);
  assert.deepEqual([...parsed.connector.keys()], ["connector-1"]);
  assert.deepEqual([...parsed.recovery.keys()], ["recovery-1"]);
  assert.match(parsed.trust_config_digest, /^[A-Za-z0-9_-]{43}$/);
  const railOnly = parseTrustedKeys(config({ rail: [entry("rail-1", a.publicKey)] }));
  assert.equal(railOnly.connector.size, 0);
  assert.equal(railOnly.recovery.size, 0);
});

test("a CRLF public-key PEM is accepted and normalized", () => {
  const key = edKey();
  const lf = parseTrustedKeys(config({ rail: [entry("rail-1", key.publicKey)] }));
  const crlf = parseTrustedKeys(config({ rail: [{ key_id: "rail-1", public_key_pem: pem(key.publicKey).replace(/\n/g, "\r\n") }] }));
  assert.equal(crlf.rail.get("rail-1").equals(key.publicKey), true);
  assert.equal(crlf.trust_config_digest, lf.trust_config_digest);
});

test("trusted-keys documents refuse unsupported shapes and keys without echoing key material", () => {
  const key = edKey();
  const good = entry("rail-1", key.publicKey);
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pemOf = (text) => config({ rail: [{ key_id: "rail-1", public_key_pem: text }] });
  refusal(null);
  refusal([]);
  refusal(config({ rail: [good], extra: true }), /unsupported field/);
  refusal(config({ rail: [{ ...good, not_before: "2035-01-01T00:00:00.000Z" }] }), /rail\[0\] has an unsupported field/);
  refusal({ rail: [good] }, /schema_version/);
  refusal({ ...config({ rail: [good] }), schema_version: "consequence-rail/trusted-keys/v0.2" }, /schema_version/);
  refusal(config({}), /at least one key/);
  refusal(config({ rail: [], connector: [], recovery: [] }), /at least one key/);
  refusal(config({ rail: [good, entry("rail-1", edKey().publicKey)] }), /rail\[1\]\.key_id repeats/);
  refusal(config({ connector: Array.from({ length: 33 }, (_, index) => entry(`connector-${index}`, edKey().publicKey)) }), /more than 32/);
  refusal(config({ rail: good }), /rail must be an array/);
  refusal(config({ rail: null }), /rail must be an array/);
  refusal(config({ rail: ["rail-1"] }), /rail\[0\] must be an object/);
  refusal(config({ recovery: [{ ...good, key_id: "" }] }), /recovery\[0\]\.key_id/);
  refusal(config({ recovery: [{ ...good, key_id: "bad\u0007id" }] }), /recovery\[0\]\.key_id/);
  refusal(config({ recovery: [{ ...good, key_id: 7 }] }), /recovery\[0\]\.key_id/);
  refusal(pemOf(pem(ec.publicKey)), /rail\[0\]\.public_key_pem/);
  refusal(pemOf(pem(rsa.publicKey)), /rail\[0\]\.public_key_pem/);
  refusal(pemOf(pem(key.privateKey, "pkcs8")), /rail\[0\]\.public_key_pem/);
  refusal(pemOf(`${pem(key.publicKey)}${pem(edKey().publicKey)}`), /rail\[0\]\.public_key_pem/);
  refusal(pemOf(pem(key.publicKey).replace("MC", "!!")), /rail\[0\]\.public_key_pem/);
  refusal(pemOf(pem(key.publicKey).slice(0, 50)), /rail\[0\]\.public_key_pem/);
  refusal(pemOf(""), /rail\[0\]\.public_key_pem/);
  refusal(pemOf(42), /rail\[0\]\.public_key_pem/);
});

test("trusted-keys files go through the bounded loader and refuse duplicate members", () => {
  const dir = mkdtempSync(join(tmpdir(), "rail-trust-load-"));
  const key = edKey();
  const file = join(dir, "trust.json");
  const body = JSON.stringify(entry("rail-1", key.publicKey));
  writeFileSync(file, `{"schema_version":"${TRUSTED_KEYS_SCHEMA_VERSION}","rail":[${body}],"rail":[]}`);
  assert.throws(() => loadTrustedKeysFile(file), (error) => error.code === "JSON_DUPLICATE_KEY");
  writeFileSync(file, JSON.stringify(config({ rail: [entry("rail-1", key.publicKey)] })));
  assert.equal(loadTrustedKeysFile(file).rail.size, 1);
  assert.throws(() => loadTrustedKeysFile(dir), (error) => error.code === "ARTIFACT_FILE_INVALID");
});

test("the trust digest ignores member order, entry order, whitespace and line endings", () => {
  const [a, b, c] = [edKey(), edKey(), edKey()];
  const base = parseTrustedKeys(config({
    rail: [entry("rail-a", a.publicKey), entry("rail-b", b.publicKey)],
    connector: [entry("connector-c", c.publicKey)],
  })).trust_config_digest;
  const reordered = {
    connector: [{ public_key_pem: `\n${pem(c.publicKey).replace(/\n/g, "\r\n")}  `, key_id: "connector-c" }],
    rail: [entry("rail-b", b.publicKey), entry("rail-a", a.publicKey)],
    recovery: [],
    schema_version: TRUSTED_KEYS_SCHEMA_VERSION,
  };
  assert.equal(parseTrustedKeys(reordered).trust_config_digest, base);
  const changed = parseTrustedKeys(config({
    rail: [entry("rail-a", a.publicKey), entry("rail-b", edKey().publicKey)],
    connector: [entry("connector-c", c.publicKey)],
  })).trust_config_digest;
  assert.notEqual(changed, base);
  const renamed = parseTrustedKeys(config({
    rail: [entry("rail-a", a.publicKey), entry("rail-x", b.publicKey)],
    connector: [entry("connector-c", c.publicKey)],
  })).trust_config_digest;
  assert.notEqual(renamed, base);
  const moved = parseTrustedKeys(config({
    rail: [entry("rail-a", a.publicKey), entry("rail-b", b.publicKey)],
    recovery: [entry("connector-c", c.publicKey)],
  })).trust_config_digest;
  assert.notEqual(moved, base);
});

test("the demo trust document holds exactly the public demonstration keys", () => {
  const parsed = parseTrustedKeys(demoTrustConfig());
  for (const [role, expected] of [["rail", demoTrustedKeys()], ["connector", demoConnectorTrustedKeys()], ["recovery", demoRecoveryTrustedKeys()]]) {
    assert.deepEqual([...parsed[role].keys()], [...expected.keys()]);
    assert.equal(parsed[role].get([...expected.keys()][0]).equals([...expected.values()][0]), true);
  }
});

test("crctl verifies own-key settlements and drills only under a trust file that lists their keys", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rail-trust-cli-"));
  const { paths, own } = await ownKeyArtifacts(dir);
  const demoTrust = join(dir, "demo-trust.json");
  assert.equal(cli(["trust", "demo", "--out", demoTrust]).status, 0);

  const untrusted = cli(["bundle", "verify", paths.audit]);
  assert.equal(untrusted.status, 1);
  assert.equal(JSON.parse(untrusted.stderr).code, "UNTRUSTED_KEY");

  const trusted = cli(["bundle", "verify", paths.audit, "--trusted-keys", paths.trust, "--json"]);
  assert.equal(trusted.status, 0, trusted.stderr);
  const result = JSON.parse(trusted.stdout);
  assert.equal(result.semantics.status, "verified");
  assert.equal(result.trusted_key_id, "ops-rail-2026");
  assert.equal(result.trust_profile, "caller_supplied_keys");
  assert.equal(result.trust_config_digest, parseTrustedKeys(own).trust_config_digest);

  const text = cli(["bundle", "verify", paths.audit, "--trusted-keys", paths.trust]);
  assert.match(text.stdout, /^trust_profile: caller_supplied_keys$/m);
  assert.match(text.stdout, new RegExp(`^trust_config_digest: ${result.trust_config_digest}$`, "m"));

  for (const file of [demoTrust, paths.railOnly]) {
    const refused = cli(["bundle", "verify", paths.audit, "--trusted-keys", file]);
    assert.equal(refused.status, 1);
    assert.equal(JSON.parse(refused.stderr).code, "UNTRUSTED_KEY");
  }

  const drillUntrusted = cli(["recovery-preflight", "verify", paths.drill]);
  assert.equal(JSON.parse(drillUntrusted.stderr).code, "UNTRUSTED_KEY");
  for (const file of [paths.trust, paths.recoveryOnly]) {
    const drill = cli(["recovery-preflight", "verify", paths.drill, "--trusted-keys", file, "--json"]);
    assert.equal(drill.status, 0, drill.stderr);
    assert.equal(JSON.parse(drill.stdout).trust_profile, "caller_supplied_keys");
  }
});

test("crctl trusts the demonstration keys only through an explicit demo trust file when the flag is used", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rail-trust-demo-"));
  const demoTrust = join(dir, "demo-trust.json");
  const printed = cli(["trust", "demo", "--out", demoTrust]);
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout, readFileSync(demoTrust, "utf8"));
  assert.deepEqual(JSON.parse(printed.stdout), demoTrustConfig());
  const again = cli(["trust", "demo", "--out", demoTrust]);
  assert.equal(again.status, 1);
  assert.match(JSON.parse(again.stderr).message, /Refusing to overwrite/);
  assert.equal(cli(["trust", "demo"]).stdout, printed.stdout);

  const audit = join(dir, "audit.json"), drill = join(dir, "drill.json");
  writeFileSync(audit, JSON.stringify((await runRefundDemo()).bundle));
  writeFileSync(drill, JSON.stringify((await runRecoveryPreflightDemo()).bundle));
  const configDigest = parseTrustedKeys(demoTrustConfig()).trust_config_digest;
  const review = cli(["bundle", "review", audit, "--trusted-keys", demoTrust]);
  assert.equal(review.status, 0, review.stderr);
  assert.equal(JSON.parse(review.stdout).trust_profile, "caller_supplied_keys");
  assert.equal(JSON.parse(review.stdout).trust_config_digest, configDigest);

  const markdown = cli(["bundle", "review", audit, "--markdown", "--trusted-keys", demoTrust]);
  assert.match(markdown.stdout, new RegExp(`caller-supplied keys from a trusted-keys file, trust_config_digest \`${configDigest}\``));
  assert.doesNotMatch(markdown.stdout, /public demonstration keys only/);
  assert.match(cli(["bundle", "review", audit, "--markdown"]).stdout, /public demonstration keys only/);
  const recoveryMarkdown = cli(["recovery-preflight", "review", drill, "--markdown", "--trusted-keys", demoTrust]);
  assert.match(recoveryMarkdown.stdout, /trusted-keys file/);

  const settlementOnly = join(dir, "settlement-only.json"), recoveryOnly = join(dir, "recovery-only.json");
  const demo = demoTrustConfig();
  writeFileSync(settlementOnly, JSON.stringify({ schema_version: demo.schema_version, rail: demo.rail, connector: demo.connector }));
  writeFileSync(recoveryOnly, JSON.stringify({ schema_version: demo.schema_version, recovery: demo.recovery }));
  assert.equal(cli(["recovery-preflight", "link", audit, drill, "--trusted-keys", demoTrust]).status, 0);
  for (const file of [settlementOnly, recoveryOnly]) {
    const link = cli(["recovery-preflight", "link", audit, drill, "--trusted-keys", file]);
    assert.equal(link.status, 1);
    assert.equal(JSON.parse(link.stderr).code, "UNTRUSTED_KEY");
  }
});

test("every bundle and recovery command accepts --trusted-keys and every other command refuses it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rail-trust-flags-"));
  const demoTrust = join(dir, "demo-trust.json");
  assert.equal(cli(["trust", "demo", "--out", demoTrust]).status, 0);
  const audit = join(dir, "audit.json"), drill = join(dir, "drill.json");
  writeFileSync(audit, JSON.stringify((await runRefundDemo()).bundle));
  writeFileSync(drill, JSON.stringify((await runRecoveryPreflightDemo()).bundle));
  const accepted = [
    ["bundle", "verify", audit],
    ["bundle", "verify-many", audit, audit],
    ["bundle", "timeline", audit],
    ["bundle", "review", audit],
    ["bundle", "receipt", audit, "--out", join(dir, "receipt.json")],
    ["bundle", "evidence", audit],
    ["bundle", "timing", audit],
    ["bundle", "compare", audit, audit],
    ["recovery-preflight", "verify", drill],
    ["recovery-preflight", "review", drill],
    ["recovery-preflight", "compare", drill, drill],
    ["recovery-preflight", "link", audit, drill],
    ["recovery-preflight", "verify-many", drill],
  ];
  for (const args of accepted) {
    const result = cli([...args, "--trusted-keys", demoTrust, "--json"]);
    // verify-many of the same file twice reports a duplicate, not a failure.
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.trust_profile, "caller_supplied_keys", args.join(" "));
    assert.match(output.trust_config_digest, /^[A-Za-z0-9_-]{43}$/, args.join(" "));
  }
  const equalsForm = cli(["bundle", "verify", audit, `--trusted-keys=${demoTrust}`, "--json"]);
  assert.equal(JSON.parse(equalsForm.stdout).trust_profile, "caller_supplied_keys");
  for (const args of [
    ["demo", "list"], ["demo", "matrix", "refund"], ["demo", "refund"], ["demo", "inventory"],
    ["demo", "irreversible"], ["demo", "recovery-preflight"], ["trust", "demo"],
  ]) {
    const result = cli([...args, "--trusted-keys", demoTrust]);
    assert.equal(result.status, 1, args.join(" "));
    assert.deepEqual(JSON.parse(result.stderr), {
      code: "USAGE_INVALID",
      message: "Flag --trusted-keys is not valid for this command. Run with --help.",
    });
  }
  const missing = cli(["bundle", "verify", audit, "--trusted-keys"]);
  assert.equal(JSON.parse(missing.stderr).code, "USAGE_INVALID");
  const twice = cli(["bundle", "verify", audit, "--trusted-keys", demoTrust, "--trusted-keys", demoTrust]);
  assert.match(JSON.parse(twice.stderr).message, /more than once/);
  assert.equal(cli(["trust"]).status, 1);
  assert.equal(cli(["trust", "other"]).status, 1);
});

test("a bad trust file fails before any artifact is opened", () => {
  const dir = mkdtempSync(join(tmpdir(), "rail-trust-first-"));
  const bad = join(dir, "bad-trust.json");
  writeFileSync(bad, JSON.stringify(config({ rail: [{ key_id: "rail-1", public_key_pem: "not a key" }] })));
  const absent = join(dir, "absent.json");
  for (const args of [
    ["bundle", "verify", absent],
    ["bundle", "verify-many", absent],
    ["bundle", "timeline", absent],
    ["bundle", "review", absent, "--markdown"],
    ["bundle", "receipt", absent, "--out", join(dir, "receipt.json")],
    ["bundle", "evidence", absent],
    ["bundle", "timing", absent],
    ["bundle", "compare", absent, absent],
    ["recovery-preflight", "verify", absent],
    ["recovery-preflight", "review", absent],
    ["recovery-preflight", "compare", absent, absent],
    ["recovery-preflight", "link", absent, absent],
    ["recovery-preflight", "verify-many", absent],
  ]) {
    const result = cli([...args, "--trusted-keys", bad]);
    assert.equal(result.status, 1, args.join(" "));
    assert.equal(result.stdout, "", args.join(" "));
    assert.equal(JSON.parse(result.stderr).code, "TRUST_CONFIG_INVALID", args.join(" "));
  }
  assert.equal(existsSync(join(dir, "receipt.json")), false);
});

test("default outputs stay free of trust-file fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rail-trust-default-"));
  const audit = join(dir, "audit.json");
  const bundle = (await runRefundDemo()).bundle;
  writeFileSync(audit, JSON.stringify(bundle));
  const verify = JSON.parse(cli(["bundle", "verify", audit, "--json"]).stdout);
  assert.equal(Object.hasOwn(verify, "trust_profile"), false);
  assert.equal(Object.hasOwn(verify, "trust_config_digest"), false);
  assert.equal(verify.bundle_digest, digest(bundle));
  const review = JSON.parse(cli(["bundle", "review", audit]).stdout);
  assert.equal(review.trust_profile, "public_demo_keys_only");
  assert.equal(Object.hasOwn(review, "trust_config_digest"), false);
  assert.doesNotMatch(cli(["bundle", "verify", audit]).stdout, /trust_profile/);
});
