// The rail and recovery signer contract: checked at construction, with a
// supported factory for an operator's own Ed25519 key.

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { ManualClock } from "../src/clock.js";
import { prepareRefund } from "../src/demo.js";
import { MemoryEventStore } from "../src/event-store.js";
import { MockRefundConnector } from "../src/mock-refund-connector.js";
import { MockRefundRecoveryAdapter } from "../src/mock-refund-recovery-adapter.js";
import { ConsequenceRail } from "../src/rail.js";
import { buildRefundRecoveryContract } from "../src/recovery-demo.js";
import { runRecoveryPreflight, verifyRecoveryPreflight } from "../src/recovery-preflight.js";
import {
  createDemoSigner,
  createSigner,
  normalizeSigner,
  signArtifact,
  verifyArtifact,
} from "../src/signing.js";
import { verifyBundle } from "../src/verify.js";

function rawEd25519Signer(prefix, { withPem = false } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const kid = `${prefix}-${createHash("sha256").update(publicKey.export({ format: "der", type: "spki" })).digest("base64url").slice(0, 16)}`;
  return {
    kid,
    privateKey,
    publicKey,
    ...(withPem ? { publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString() } : {}),
  };
}

function pemOf(key, type) {
  return key.export({ format: "pem", type }).toString();
}

function countingEventStore(signer, clock) {
  const store = new MemoryEventStore(signer, clock);
  return {
    failureAtomicAppend: true,
    appendCalls: 0,
    append(...args) {
      this.appendCalls += 1;
      return store.append(...args);
    },
    list(...args) {
      return store.list(...args);
    },
  };
}

async function closeSettledRefund(signer, connectorSigner = rawEd25519Signer("ops-connector", { withPem: true })) {
  const clock = new ManualClock();
  const connector = new MockRefundConnector(clock, { signer: connectorSigner });
  const rail = new ConsequenceRail({
    signer,
    clock,
    connector,
    connectorTrustedKeys: connector.trustedKeys(),
  });
  const { actionId } = prepareRefund({ clock, rail, connector, assuranceMode: "enforced" });
  await rail.execute(actionId, { fault: "none" });
  await rail.verifyOutcome(actionId, { fault: "none" });
  return { rail, actionId, connectorSigner };
}

function assertNoKeyMaterial(error, ...pems) {
  const text = `${error.message} ${JSON.stringify(error.details ?? {})}`;
  assert.doesNotMatch(text, /BEGIN|END|PRIVATE|PUBLIC KEY-/);
  for (const pem of pems) {
    for (const line of pem.split(/\r?\n/).filter(item => item.length > 20 && !item.startsWith("-----"))) {
      assert.equal(text.includes(line), false, "error text includes key material");
    }
  }
}

test("a node:crypto signer without publicKeyPem closes, exports and verifies both profiles", async () => {
  const signer = rawEd25519Signer("ops-rail");
  const { rail, actionId, connectorSigner } = await closeSettledRefund(signer);
  assert.equal(rail.inspect(actionId).state, "CLOSED");
  assert.equal(rail.inspect(actionId).outcome, "settled");
  const trust = {
    trustedKeys: new Map([[signer.kid, signer.publicKey]]),
    trustedConnectorKeys: new Map([[connectorSigner.kid, connectorSigner.publicKey]]),
  };
  const audit = rail.exportBundle(actionId, { profile: "audit" });
  const receipt = rail.exportBundle(actionId, { profile: "receipt" });
  assert.equal(audit.trust_hint.rail.public_key_pem, pemOf(signer.publicKey, "spki"));
  assert.equal(verifyBundle(audit, { ...trust, requireSemantics: true }).semantics.status, "verified");
  assert.equal(verifyBundle(receipt, { ...trust, requireSemantics: false }).outcome, "settled");
});

test("a signer that supplies only privateKey derives both public halves", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const { rail, actionId } = await closeSettledRefund({ kid: "ops-rail-private-only", privateKey });
  assert.equal(rail.exportBundle(actionId, { profile: "audit" }).trust_hint.rail.public_key_pem, pemOf(publicKey, "spki"));
});

test("a PEM-string signer that worked before still closes and exports", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = pemOf(publicKey, "spki");
  const signer = { kid: "ops-rail-pem", privateKey: pemOf(privateKey, "pkcs8"), publicKey: publicKeyPem, publicKeyPem };
  const { rail, actionId, connectorSigner } = await closeSettledRefund(signer);
  const audit = rail.exportBundle(actionId, { profile: "audit" });
  assert.equal(audit.trust_hint.rail.public_key_pem, publicKeyPem);
  verifyBundle(audit, {
    trustedKeys: new Map([[signer.kid, publicKey]]),
    trustedConnectorKeys: new Map([[connectorSigner.kid, connectorSigner.publicKey]]),
    requireSemantics: true,
  });
});

test("every matching signer shape that worked in 0.3.0 still closes, exports and verifies", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = pemOf(publicKey, "spki");
  const base = { kid: "ops-rail", privateKey, publicKey, publicKeyPem };
  const shapes = [
    ["publicKey as SPKI DER input", { ...base, publicKey: { key: publicKey.export({ format: "der", type: "spki" }), format: "der", type: "spki" } }],
    ["publicKey as JWK input", { ...base, publicKey: { key: publicKey.export({ format: "jwk" }), format: "jwk" } }],
    ["publicKey as a PEM Buffer", { ...base, publicKey: Buffer.from(publicKeyPem) }],
    ["publicKey as the private KeyObject", { ...base, publicKey: privateKey }],
    ["publicKey as the private PEM", { ...base, publicKey: pemOf(privateKey, "pkcs8") }],
    ["publicKeyPem with leading spaces", { ...base, publicKeyPem: `  ${publicKeyPem}` }],
    ["kid with a trailing newline", { ...base, kid: "ops-rail\n" }],
    ["kid with a tab", { ...base, kid: "ops\trail" }],
  ];
  for (const [label, signer] of shapes) {
    const { rail, actionId, connectorSigner } = await closeSettledRefund(signer);
    const audit = rail.exportBundle(actionId, { profile: "audit" });
    // The trust hint keeps the caller's PEM text, as 0.3.0 did.
    assert.equal(audit.trust_hint.rail.public_key_pem, signer.publicKeyPem, label);
    assert.equal(audit.trust_hint.rail.key_id, signer.kid, label);
    const result = verifyBundle(audit, {
      trustedKeys: new Map([[signer.kid, publicKey]]),
      trustedConnectorKeys: new Map([[connectorSigner.kid, connectorSigner.publicKey]]),
      requireSemantics: true,
    });
    assert.equal(result.outcome, "settled", label);
  }
});

test("a non-KeyObject publicKey is still compared with the private key", () => {
  const good = rawEd25519Signer("ops-rail", { withPem: true });
  const other = rawEd25519Signer("ops-other", { withPem: true });
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const cases = [
    ["mismatched SPKI DER input", { key: other.publicKey.export({ format: "der", type: "spki" }), format: "der", type: "spki" }],
    ["mismatched JWK input", { key: other.publicKey.export({ format: "jwk" }), format: "jwk" }],
    ["mismatched PEM Buffer", Buffer.from(other.publicKeyPem)],
    ["mismatched private KeyObject", other.privateKey],
    ["EC public key", ec.publicKey],
    ["unparseable Buffer", Buffer.from("not a key")],
    ["plain object", {}],
    ["number", 42],
  ];
  for (const [label, publicKey] of cases) {
    const clock = new ManualClock();
    assert.throws(
      () => new ConsequenceRail({ signer: { ...good, publicKey }, clock, connector: new MockRefundConnector(clock) }),
      (error) => {
        assert.equal(error.code, "CONFIG_INVALID", label);
        assertNoKeyMaterial(error, good.publicKeyPem, other.publicKeyPem);
        return true;
      },
      label,
    );
  }
});

test("the rail refuses a contradictory or unsupported signer before any event is appended", () => {
  const good = rawEd25519Signer("ops-rail", { withPem: true });
  const other = rawEd25519Signer("ops-other", { withPem: true });
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = pemOf(good.privateKey, "pkcs8");
  const cases = [
    ["mismatched publicKey", { ...good, publicKey: other.publicKey }],
    ["mismatched publicKeyPem", { ...good, publicKeyPem: other.publicKeyPem }],
    ["private PEM as publicKeyPem", { ...good, publicKeyPem: privatePem }],
    ["two PEM blocks", { ...good, publicKeyPem: `${good.publicKeyPem}${other.publicKeyPem}` }],
    ["non-string publicKeyPem", { ...good, publicKeyPem: 42 }],
    ["EC P-256 private key", { kid: "ops-ec", privateKey: ec.privateKey }],
    ["RSA private key", { kid: "ops-rsa", privateKey: rsa.privateKey }],
    ["public KeyObject as privateKey", { kid: "ops-public", privateKey: good.publicKey }],
    ["missing kid", { privateKey: good.privateKey }],
    ["empty kid", { ...good, kid: "" }],
    ["numeric kid", { ...good, kid: 7 }],
    ["numeric privateKey", { kid: "ops-number", privateKey: 42 }],
    ["garbage privateKey string", { kid: "ops-garbage", privateKey: "not a key" }],
    ["plain object privateKey", { kid: "ops-object", privateKey: {} }],
  ];
  for (const [label, signer] of cases) {
    const clock = new ManualClock();
    const recorder = countingEventStore(createDemoSigner(), clock);
    assert.throws(
      () => new ConsequenceRail({ signer, clock, connector: new MockRefundConnector(clock), eventStore: recorder }),
      (error) => {
        assert.equal(error.code, "CONFIG_INVALID", label);
        assertNoKeyMaterial(error, privatePem, good.publicKeyPem, other.publicKeyPem);
        return true;
      },
      label,
    );
    assert.equal(recorder.appendCalls, 0, label);
  }
});

test("a demo signer passes through normalization with identical values", () => {
  const demo = createDemoSigner();
  const normalized = normalizeSigner(demo);
  assert.equal(normalized.kid, demo.kid);
  assert.equal(normalized.privateKey, demo.privateKey);
  assert.equal(normalized.publicKey, demo.publicKey);
  assert.equal(normalized.publicKeyPem, demo.publicKeyPem);
  assert.equal(Object.isFrozen(normalized), true);
  assert.deepEqual(Object.keys(normalized), ["kid", "privateKey", "publicKey", "publicKeyPem"]);
});

test("createSigner builds a frozen signer from a KeyObject or a PKCS#8 PEM", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  for (const input of [privateKey, pemOf(privateKey, "pkcs8"), pemOf(privateKey, "pkcs8").replace(/\n/g, "\r\n")]) {
    const signer = createSigner({ keyId: "ops-rail-2026", privateKey: input });
    assert.equal(Object.isFrozen(signer), true);
    assert.equal(signer.kid, "ops-rail-2026");
    assert.equal(signer.publicKeyPem, pemOf(publicKey, "spki"));
    const signed = signArtifact({ schema_version: "example/v1", value: 1 }, signer);
    assert.equal(signed.signature.key_id, "ops-rail-2026");
    assert.equal(verifyArtifact(signed, new Map([["ops-rail-2026", publicKey]])).valid, true);
    assert.equal(verifyArtifact(signed, new Map([["ops-rail-2026", signer.publicKey]])).valid, true);
  }
});

test("createSigner refuses unsupported keys and identifiers without echoing them", () => {
  const ed = generateKeyPairSync("ed25519");
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const encrypted = ed.privateKey.export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: "synthetic" }).toString();
  const edPem = pemOf(ed.privateKey, "pkcs8");
  const cases = [
    { keyId: "ops", privateKey: pemOf(ec.privateKey, "pkcs8") },
    { keyId: "ops", privateKey: pemOf(rsa.privateKey, "pkcs8") },
    { keyId: "ops", privateKey: pemOf(ed.publicKey, "spki") },
    { keyId: "ops", privateKey: edPem.slice(0, 60) },
    { keyId: "ops", privateKey: encrypted },
    { keyId: "ops", privateKey: ed.publicKey },
    { keyId: "ops", privateKey: Buffer.from(edPem) },
    { keyId: "", privateKey: ed.privateKey },
    { keyId: "ops\nline", privateKey: ed.privateKey },
    { privateKey: ed.privateKey },
  ];
  for (const input of cases) {
    assert.throws(() => createSigner(input), (error) => {
      assert.equal(error.code, "SIGNER_INVALID");
      assertNoKeyMaterial(error, edPem, encrypted, pemOf(ec.privateKey, "pkcs8"));
      return true;
    });
  }
  assert.throws(() => createSigner(), (error) => error.code === "SIGNER_INVALID");
});

test("a recovery drill signed by createSigner verifies under that recovery key", async () => {
  const clock = new ManualClock();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signer = createSigner({ keyId: "ops-recovery-2026", privateKey });
  const bundle = await runRecoveryPreflight({
    contract: buildRefundRecoveryContract(clock),
    adapter: new MockRefundRecoveryAdapter(clock),
    signer,
    clock,
  });
  assert.equal(bundle.trust_hint.key_id, "ops-recovery-2026");
  assert.equal(bundle.trust_hint.public_key_pem, pemOf(publicKey, "spki"));
  const result = verifyRecoveryPreflight(bundle, {
    trustedKeys: new Map([["ops-recovery-2026", publicKey]]),
    requireCurrent: true,
    now: clock.now(),
  });
  assert.equal(result.qualification, "QUALIFIED_EXACT");
});

test("a recovery drill signer without publicKeyPem now exports a verifiable drill", async () => {
  const clock = new ManualClock();
  const signer = rawEd25519Signer("ops-recovery");
  const bundle = await runRecoveryPreflight({
    contract: buildRefundRecoveryContract(clock),
    adapter: new MockRefundRecoveryAdapter(clock),
    signer,
    clock,
  });
  verifyRecoveryPreflight(bundle, { trustedKeys: new Map([[signer.kid, signer.publicKey]]) });
});

test("recovery signers that worked in 0.3.0 still produce a qualified drill", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = pemOf(publicKey, "spki");
  for (const signer of [
    { kid: "ops-recovery", privateKey, publicKey: Buffer.from(publicKeyPem), publicKeyPem },
    { kid: "ops-recovery\n", privateKey, publicKey, publicKeyPem },
  ]) {
    const clock = new ManualClock();
    const bundle = await runRecoveryPreflight({
      contract: buildRefundRecoveryContract(clock),
      adapter: new MockRefundRecoveryAdapter(clock),
      signer,
      clock,
    });
    assert.equal(bundle.trust_hint.key_id, signer.kid);
    const result = verifyRecoveryPreflight(bundle, {
      trustedKeys: new Map([[signer.kid, publicKey]]),
      requireCurrent: true,
      now: clock.now(),
    });
    assert.equal(result.qualification, "QUALIFIED_EXACT");
  }
});

test("a mismatched recovery signer is refused before the adapter runs", async () => {
  const clock = new ManualClock();
  const good = rawEd25519Signer("ops-recovery", { withPem: true });
  const other = rawEd25519Signer("ops-other", { withPem: true });
  const adapter = new MockRefundRecoveryAdapter(clock);
  let runCalls = 0;
  const original = adapter.run;
  adapter.run = function countedRun(...args) {
    runCalls += 1;
    return Reflect.apply(original, this, args);
  };
  await assert.rejects(
    runRecoveryPreflight({
      contract: buildRefundRecoveryContract(clock),
      adapter,
      signer: { ...good, publicKeyPem: other.publicKeyPem },
      clock,
    }),
    (error) => error.code === "RECOVERY_CONFIG_INVALID",
  );
  assert.equal(runCalls, 0);
});
