// Sidecar verification parity: createReferenceServer({ bundleTrust }),
// POST /v0/bundles/verify?allow_receipt_profile=true and rail --trusted-keys.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deepClone } from "../src/canonical.js";
import { ManualClock } from "../src/clock.js";
import { createDemoRuntime, prepareRefund, runRefundDemo } from "../src/demo.js";
import { createReferenceServer } from "../src/http-server.js";
import { MockRefundConnector } from "../src/mock-refund-connector.js";
import { ConsequenceRail } from "../src/rail.js";
import { repoPath, socketOutcome } from "../src/rail-test-helpers.js";
import { createSigner, demoConnectorTrustedKeys, demoTrustedKeys } from "../src/signing.js";
import { demoTrustConfig, parseTrustedKeys, TRUSTED_KEYS_SCHEMA_VERSION } from "../src/trust-config.js";
import { RECEIPT_PROFILE_LIMITATIONS, verifyBundle } from "../src/verify.js";

const demoTrust = () => ({ trustedKeys: demoTrustedKeys(), trustedConnectorKeys: demoConnectorTrustedKeys() });
const pem = (key) => key.export({ format: "pem", type: "spki" }).toString();

async function startServer(context, options = {}) {
  const runtime = createDemoRuntime();
  const server = createReferenceServer({ runtime, ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const { port } = server.address();
  return { runtime, port, base: `http://127.0.0.1:${port}` };
}

async function closedAction(runtime) {
  const { actionId } = prepareRefund(runtime);
  await runtime.rail.execute(actionId, { fault: "none" });
  await runtime.rail.verifyOutcome(actionId, { fault: "none" });
  return actionId;
}

async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

async function ownKeyBundle() {
  const railKey = generateKeyPairSync("ed25519"), connectorKey = generateKeyPairSync("ed25519");
  const clock = new ManualClock();
  const connector = new MockRefundConnector(clock, {
    signer: createSigner({ keyId: "ops-connector", privateKey: connectorKey.privateKey }),
  });
  const rail = new ConsequenceRail({
    signer: createSigner({ keyId: "ops-rail", privateKey: railKey.privateKey }),
    clock, connector, connectorTrustedKeys: connector.trustedKeys(),
  });
  const actionId = await closedAction({ clock, rail, connector, assuranceMode: "enforced" });
  return {
    bundle: rail.exportBundle(actionId, { profile: "audit" }),
    config: {
      schema_version: TRUSTED_KEYS_SCHEMA_VERSION,
      rail: [{ key_id: "ops-rail", public_key_pem: pem(railKey.publicKey) }],
      connector: [{ key_id: "ops-connector", public_key_pem: pem(connectorKey.publicKey) }],
    },
  };
}

test("the sidecar verifies its own default receipt export only with allow_receipt_profile=true", async (context) => {
  const { runtime, base } = await startServer(context);
  const actionId = await closedAction(runtime);
  const exported = await fetch(`${base}/v0/actions/${actionId}/bundle`);
  const receipt = await exported.json();
  assert.equal(receipt.profile, "receipt");

  const strict = await post(`${base}/v0/bundles/verify`, receipt);
  assert.equal(strict.status, 400);
  const refusal = JSON.parse(strict.text);
  assert.equal(refusal.code, "SEMANTIC_INVALID");
  assert.equal(refusal.message, "Full semantic verification requires an audit-profile bundle.");
  assert.deepEqual(Object.keys(refusal).sort(), ["code", "message", "request_id"]);

  const allowed = await post(`${base}/v0/bundles/verify?allow_receipt_profile=true`, receipt);
  assert.equal(allowed.status, 200, allowed.text);
  const result = JSON.parse(allowed.text);
  assert.equal(result.valid, true);
  assert.deepEqual(result.semantics, { status: "not_requested", valid: null });
  assert.equal(result.profile, "receipt");
  assert.equal(result.verification_scope, "integrity_only");
  assert.deepEqual(result.limitations, [...RECEIPT_PROFILE_LIMITATIONS]);

  // The round-1 binding holds over HTTP.
  const relabeled = deepClone(receipt);
  relabeled.action.action_type = "demo.email.send/v1";
  const tampered = await post(`${base}/v0/bundles/verify?allow_receipt_profile=true`, relabeled);
  assert.equal(tampered.status, 400);
  assert.equal(JSON.parse(tampered.text).code, "BUNDLE_TAMPERED");
});

test("audit verification responses are byte-identical without the parameter", async (context) => {
  const { runtime, base } = await startServer(context);
  const actionId = await closedAction(runtime);
  const audit = runtime.rail.exportBundle(actionId, { profile: "audit" });
  const plain = await post(`${base}/v0/bundles/verify`, audit);
  assert.equal(plain.status, 200);
  assert.equal(plain.text, `${JSON.stringify(verifyBundle(audit, { ...demoTrust(), requireSemantics: true }))}\n`);

  const allowed = JSON.parse((await post(`${base}/v0/bundles/verify?allow_receipt_profile=true`, audit)).text);
  assert.equal(allowed.semantics.status, "verified");
  assert.equal(allowed.profile, "audit");
  assert.equal(allowed.verification_scope, "integrity_and_lifecycle_semantics");
  assert.equal(Object.hasOwn(allowed, "limitations"), false);

  // The capability document is unchanged by a caller-supplied bundle trust.
  const own = await ownKeyBundle();
  const custom = await startServer(context, { bundleTrust: (() => {
    const parsed = parseTrustedKeys(own.config);
    return { trustedKeys: parsed.rail, trustedConnectorKeys: parsed.connector };
  })() });
  const [first, second] = await Promise.all([
    fetch(`${base}/.well-known/consequence-rail`).then((response) => response.text()),
    fetch(`${custom.base}/.well-known/consequence-rail`).then((response) => response.text()),
  ]);
  assert.equal(second, first);
});

test("any allow_receipt_profile value other than true is refused before the body is read", async (context) => {
  const { port } = await startServer(context);
  const request = (query) =>
    `POST /v0/bundles/verify${query} HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${port}\r\n` +
    "Content-Type: application/json\r\n" +
    "Content-Length: 1000\r\n" +
    "\r\n";
  for (const query of [
    "?allow_receipt_profile=false",
    "?allow_receipt_profile=1",
    "?allow_receipt_profile=TRUE",
    "?allow_receipt_profile=",
    "?allow_receipt_profile",
    "?allow_receipt_profile=true&allow_receipt_profile=true",
    "?allow_receipt_profile=true&profile=receipt",
  ]) {
    // The declared body is never sent, so only a refusal made before reading
    // it can answer and close the socket.
    const outcome = await socketOutcome(port, request(query), 2_000);
    assert.equal(outcome.closed, true, query);
    assert.match(outcome.response, /^HTTP\/1\.1 400 /, query);
    assert.match(outcome.response, /"code":"REQUEST_INVALID"/, query);
  }
  // A valid value waits for the declared body.
  const waiting = await socketOutcome(port, request("?allow_receipt_profile=true"), 300);
  assert.equal(waiting.closed, false);
});

test("bundleTrust replaces the demo keys for POST /v0/bundles/verify only", async (context) => {
  const own = await ownKeyBundle();
  const parsed = parseTrustedKeys(own.config);
  const { runtime, base } = await startServer(context, {
    bundleTrust: { trustedKeys: parsed.rail, trustedConnectorKeys: parsed.connector },
  });
  const verified = await post(`${base}/v0/bundles/verify`, own.bundle);
  assert.equal(verified.status, 200, verified.text);
  assert.equal(JSON.parse(verified.text).trusted_key_id, "ops-rail");

  // The sidecar still signs with the demo keys, so its own export is refused
  // by a trust set that omits them.
  const actionId = await closedAction(runtime);
  const demoBundle = runtime.rail.exportBundle(actionId, { profile: "audit" });
  const refused = await post(`${base}/v0/bundles/verify`, demoBundle);
  assert.equal(refused.status, 400);
  assert.equal(JSON.parse(refused.text).code, "UNTRUSTED_KEY");
  // Lifecycle routes are unaffected.
  assert.equal(runtime.rail.inspect(actionId).state, "CLOSED");

  // Mutating the caller's maps afterwards does not change the server's trust.
  parsed.rail.clear();
  assert.equal((await post(`${base}/v0/bundles/verify`, own.bundle)).status, 200);
});

test("createReferenceServer refuses an unusable bundleTrust", () => {
  for (const bundleTrust of [null, {}, { trustedKeys: demoTrustedKeys() }, { trustedKeys: new Map(), trustedConnectorKeys: demoConnectorTrustedKeys() },
    { trustedKeys: [], trustedConnectorKeys: demoConnectorTrustedKeys() }]) {
    assert.throws(() => createReferenceServer({ runtime: createDemoRuntime(), bundleTrust }),
      (error) => error.code === "CONFIG_INVALID");
  }
});

const runRail = (args) => spawnSync(process.execPath, [repoPath("cmd", "rail.js"), ...args], {
  cwd: repoPath(), encoding: "utf8", timeout: 10_000,
});

function startRail(args) {
  const child = spawn(process.execPath, [repoPath("cmd", "rail.js"), ...args], { cwd: repoPath() });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  const ready = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("\n")) resolve();
    });
    child.on("exit", (code) => reject(new Error(`rail exited with ${code}`)));
  });
  return { child, ready, output: () => stdout };
}

async function settle(child) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  child.kill();
}

test("rail --trusted-keys refuses unusable files with a structured error and never binds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cr-sidecar-trust-"));
  const recoveryOnly = join(dir, "recovery-only.json");
  const config = demoTrustConfig();
  writeFileSync(recoveryOnly, JSON.stringify({ schema_version: config.schema_version, recovery: config.recovery }));
  const privatePem = join(dir, "private.json");
  const key = generateKeyPairSync("ed25519");
  writeFileSync(privatePem, JSON.stringify({
    schema_version: config.schema_version,
    rail: [{ key_id: "rail", public_key_pem: key.privateKey.export({ format: "pem", type: "pkcs8" }).toString() }],
    connector: config.connector,
  }));
  for (const [file, code] of [
    [join(dir, "missing.json"), null],
    [recoveryOnly, "TRUST_CONFIG_INVALID"],
    [privatePem, "TRUST_CONFIG_INVALID"],
  ]) {
    const result = runRail(["--trusted-keys", file, "--port", "0"]);
    assert.equal(result.status, 1, file);
    assert.doesNotMatch(result.stdout, /listening/, file);
    const failure = JSON.parse(result.stderr.trim());
    if (code) assert.equal(failure.code, code, file);
    assert.equal(typeof failure.message, "string");
    assert.doesNotMatch(result.stderr, /BEGIN|PRIVATE KEY|MC4CAQ/);
  }

  for (const [args, message] of [
    [["--trusted-keys"], "--trusted-keys requires a trusted-keys file path."],
    [["--trusted-keys", "--port", "0"], "--trusted-keys requires a trusted-keys file path."],
    [["--trusted-keys", "a.json", "--trusted-keys", "b.json"], "Flag --trusted-keys was supplied more than once."],
  ]) {
    const result = runRail(args);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stderr.trim()), { code: "USAGE_INVALID", message });
  }

  const help = runRail(["--help"]);
  assert.match(help.stdout, /--trusted-keys <file>/);
});

test("rail --trusted-keys binds and reports the trust digest after the listening line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cr-sidecar-trust-"));
  const file = join(dir, "trust.json");
  writeFileSync(file, JSON.stringify(demoTrustConfig()));
  const digest = parseTrustedKeys(demoTrustConfig()).trust_config_digest;

  const trusted = startRail(["--trusted-keys", file, "--port", "0", "--clock", "demo"]);
  await trusted.ready;
  const port = Number(/listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(trusted.output())[1]);
  const demo = await runRefundDemo();
  const exported = demo.runtime.rail.exportBundle(demo.summary.action_id);
  const verified = await post(`http://127.0.0.1:${port}/v0/bundles/verify?allow_receipt_profile=true`, exported);
  assert.equal(verified.status, 200, verified.text);
  await settle(trusted.child);
  assert.deepEqual(trusted.output().trimEnd().split(/\r?\n/), [
    `Consequence Rail reference sidecar listening on http://127.0.0.1:${port}`,
    `Bundle verification trusts caller-supplied keys, trust_config_digest ${digest}`,
  ]);

  const plain = startRail(["--port", "0"]);
  await plain.ready;
  await settle(plain.child);
  assert.equal(plain.output().trimEnd().split(/\r?\n/).length, 1);
  assert.match(plain.output(), /^Consequence Rail reference sidecar listening on http:\/\/127\.0\.0\.1:\d+\n$/);
});
