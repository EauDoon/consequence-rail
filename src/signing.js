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

export function signArtifact(body, signer) {
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
  const signature = artifact?.signature;
  if (!signature || signature.algorithm !== "Ed25519") {
    throw new RailError("SIGNATURE_INVALID", "Artifact is missing a supported signature.");
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
