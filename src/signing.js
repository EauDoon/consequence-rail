import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { canonicalJson, digest, without } from "./canonical.js";
import { RailError } from "./errors.js";

const ED25519_PKCS8_PREFIX = Buffer.concat([
  Buffer.from("302e020100300506", "hex"),
  Buffer.from("032b657004220420", "hex"),
]);
const SIGNATURE_FIELDS = new Set(["algorithm", "key_id", "value"]);
const ED25519_BASE64URL = /^[A-Za-z0-9_-]{86}$/;

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
  const unsigned = without(body, ["signature"]);
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
    Buffer.from(signature.value, "base64url"),
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
