import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { canonicalJson, deepClone, digest, without } from "./canonical.js";
import { RailError } from "./errors.js";

const ED25519_PKCS8_PREFIX = Buffer.concat([
  Buffer.from("302e020100300506", "hex"),
  Buffer.from("032b657004220420", "hex"),
]);
const SIGNATURE_FIELDS = new Set(["algorithm", "key_id", "value"]);
const ED25519_BASE64URL = /^[A-Za-z0-9_-]{86}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
// The whole text must be one SPKI block. createPublicKey would otherwise
// derive a public key from a private-key PEM, or read only the first of
// several blocks, and the text is later copied into an exported trust hint.
const PUBLIC_KEY_PEM = /^\s*-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/;
const MAX_PEM_LENGTH = 4096;

function isPlainObject(value) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null);
}

function deterministicSeed(label) {
  return createHash("sha256")
    .update(`consequence-rail/v0.1/${label}/not-a-secret`, "utf8")
    .digest();
}

export function createDeterministicDemoSigner(label, keyPrefix) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, deterministicSeed(label)]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey);
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const kid = `${keyPrefix}-${createHash("sha256").update(publicDer).digest("base64url").slice(0, 16)}`;

  return {
    kid,
    privateKey,
    publicKey,
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

/** True for a non-empty key identifier without control characters. */
export function isValidKeyId(value) {
  return typeof value === "string" && value.length > 0 && !CONTROL_CHARACTER.test(value);
}

function spkiDer(publicKey) {
  return publicKey.export({ format: "der", type: "spki" });
}

function isCryptoKey(value) {
  return typeof globalThis.CryptoKey === "function" && value instanceof globalThis.CryptoKey;
}

/**
 * Parse text that must be exactly one Ed25519 SPKI public-key PEM block.
 * Errors never include the supplied text.
 */
export function parsePublicKeyPem(text, code, label) {
  let publicKey;
  if (typeof text === "string" && text.length <= MAX_PEM_LENGTH && PUBLIC_KEY_PEM.test(text)) {
    try {
      // OpenSSL refuses spaces before the BEGIN line that the pattern allows.
      publicKey = createPublicKey({ key: text.trim(), format: "pem" });
    } catch {
      publicKey = undefined;
    }
  }
  if (publicKey?.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
    throw new RailError(code, `${label} must be exactly one Ed25519 public-key PEM block.`);
  }
  return publicKey;
}

function privateKeyObject(value) {
  try {
    const key = value instanceof KeyObject
      ? value
      : isCryptoKey(value)
        ? KeyObject.from(value)
        : createPrivateKey(value);
    return key.type === "private" && key.asymmetricKeyType === "ed25519" ? key : null;
  } catch {
    return null;
  }
}

// Accept every public-key input 0.3.0 accepted. It passed publicKey straight to
// node:crypto verification, which takes a KeyObject, a CryptoKey, PEM text or a
// Buffer, a { key, format, type } DER or JWK input, or the private key itself.
// publicKey is never exported, and the caller compares the result with the
// public half of privateKey, so the leniency cannot admit another key.
function suppliedPublicKey(value, code) {
  let key = null;
  try {
    const object = value instanceof KeyObject ? value : isCryptoKey(value) ? KeyObject.from(value) : null;
    key = object
      ? object.type === "private" ? createPublicKey(object) : object
      : value !== null && (typeof value === "object" || typeof value === "string")
        ? createPublicKey(value)
        : null;
  } catch {
    key = null;
  }
  if (key?.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    throw new RailError(code, "Signer publicKey must be an Ed25519 public key.");
  }
  return key;
}

/**
 * Check a rail or recovery signer before it is used, and return a frozen
 * { kid, privateKey, publicKey, publicKeyPem } copy. A missing public half is
 * derived from the private key; a supplied one must match it. Errors name the
 * failing field and never include key material.
 */
export function normalizeSigner(signer, code = "CONFIG_INVALID") {
  if (!signer || typeof signer !== "object") {
    throw new RailError(code, "A signer object is required.");
  }
  // 0.3.0 signed with any non-empty kid, control characters included, so a
  // signer object keeps that. createSigner and trusted-keys files are stricter.
  if (typeof signer.kid !== "string" || signer.kid.length === 0) {
    throw new RailError(code, "Signer kid must be a non-empty string.");
  }
  const privateKey = privateKeyObject(signer.privateKey);
  if (!privateKey) {
    throw new RailError(code, "Signer privateKey must be an Ed25519 private key.");
  }
  const derived = createPublicKey(privateKey);
  const derivedDer = spkiDer(derived);
  let publicKey = derived;
  if (signer.publicKey !== undefined && signer.publicKey !== null) {
    const supplied = suppliedPublicKey(signer.publicKey, code);
    if (!spkiDer(supplied).equals(derivedDer)) {
      throw new RailError(code, "Signer publicKey does not match its privateKey.");
    }
    // Keep a caller's matching KeyObject; a PEM string is replaced by its parse.
    if (supplied === signer.publicKey) publicKey = supplied;
  }
  let publicKeyPem = derived.export({ format: "pem", type: "spki" }).toString();
  if (signer.publicKeyPem !== undefined && signer.publicKeyPem !== null) {
    const supplied = parsePublicKeyPem(signer.publicKeyPem, code, "Signer publicKeyPem");
    if (!spkiDer(supplied).equals(derivedDer)) {
      throw new RailError(code, "Signer publicKeyPem does not match its privateKey.");
    }
    publicKeyPem = signer.publicKeyPem;
  }
  return Object.freeze({ kid: signer.kid, privateKey, publicKey, publicKeyPem });
}

/**
 * Build a signer from an operator's own Ed25519 key. privateKey is a private
 * KeyObject or an unencrypted PKCS#8 PEM string. Key storage stays the
 * caller's responsibility.
 */
export function createSigner({ keyId, privateKey } = {}) {
  if (!isValidKeyId(keyId)) {
    throw new RailError("SIGNER_INVALID", "keyId must be a non-empty string without control characters.");
  }
  if (!(privateKey instanceof KeyObject) && typeof privateKey !== "string") {
    throw new RailError("SIGNER_INVALID", "privateKey must be an Ed25519 private KeyObject or PKCS#8 PEM string.");
  }
  const key = privateKeyObject(privateKey);
  if (!key) {
    throw new RailError("SIGNER_INVALID", "privateKey must be an Ed25519 private KeyObject or PKCS#8 PEM string.");
  }
  return normalizeSigner({ kid: keyId, privateKey: key }, "SIGNER_INVALID");
}

export function createDemoSigner() {
  return createDeterministicDemoSigner("rail-signing-key", "demo-rail-ed25519");
}

export function createDemoConnectorSigner() {
  return createDeterministicDemoSigner(
    "mock-refund-connector-signing-key",
    "demo-connector-ed25519",
  );
}

export function createDemoRecoverySigner() {
  return createDeterministicDemoSigner(
    "recovery-preflight-signing-key",
    "demo-recovery-ed25519",
  );
}

export function signArtifact(body, signer) {
  if (!isPlainObject(body) || !signer?.privateKey || !signer?.kid) {
    throw new RailError("SIGNING_INVALID", "Artifact body and signer are required.");
  }
  const unsigned = deepClone(without(body, ["signature"]));
  const value = cryptoSign(null, Buffer.from(canonicalJson(unsigned), "utf8"), signer.privateKey)
    .toString("base64url");

  return {
    ...unsigned,
    signature: {
      algorithm: "Ed25519",
      key_id: signer.kid,
      value,
    },
  };
}

export function verifyArtifact(artifact, trustedKeys) {
  artifact = deepClone(artifact);
  if (!isPlainObject(artifact) || !Object.hasOwn(artifact, "signature")) {
    throw new RailError("SIGNATURE_INVALID", "Artifact is missing a supported signature.");
  }
  const signature = artifact.signature;
  if (
    !isPlainObject(signature) ||
    [...SIGNATURE_FIELDS].some((field) => !Object.hasOwn(signature, field)) ||
    Object.keys(signature).some((field) => !SIGNATURE_FIELDS.has(field)) ||
    signature.algorithm !== "Ed25519" ||
    typeof signature.key_id !== "string" ||
    signature.key_id.length === 0 ||
    typeof signature.value !== "string" ||
    !ED25519_BASE64URL.test(signature.value)
  ) {
    throw new RailError("SIGNATURE_INVALID", "Artifact is missing a supported signature.");
  }

  if (!(trustedKeys instanceof Map)) {
    throw new RailError("TRUST_CONFIG_INVALID", "Trusted keys must be an explicit map.");
  }

  const signatureBytes = Buffer.from(signature.value, "base64url");
  if (signatureBytes.toString("base64url") !== signature.value) {
    throw new RailError("SIGNATURE_INVALID", "Artifact signature encoding is not canonical.");
  }

  const publicKey = trustedKeys.get(signature.key_id);
  if (!publicKey) {
    throw new RailError("UNTRUSTED_KEY", "Artifact was not signed by an explicitly trusted key.", {
      key_id: signature.key_id,
    });
  }

  const unsigned = without(artifact, ["signature"]);
  const valid = cryptoVerify(
    null,
    Buffer.from(canonicalJson(unsigned), "utf8"),
    publicKey,
    signatureBytes,
  );

  if (!valid) {
    throw new RailError("SIGNATURE_INVALID", "Artifact signature verification failed.");
  }

  return {
    valid: true,
    digest: digest(artifact),
    key_id: signature.key_id,
  };
}

export function demoTrustedKeys() {
  const signer = createDemoSigner();
  return new Map([[signer.kid, signer.publicKey]]);
}

export function demoConnectorTrustedKeys() {
  const signer = createDemoConnectorSigner();
  return new Map([[signer.kid, signer.publicKey]]);
}

export function demoRecoveryTrustedKeys() {
  const signer = createDemoRecoverySigner();
  return new Map([[signer.kid, signer.publicKey]]);
}
