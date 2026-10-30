// Verifier-side trust configuration: the public keys a verifier accepts for
// each signing role, read from a closed, versioned JSON document. This is a
// trust set for verification, not key management.

import { readArtifactFile } from "./artifact-files.js";
import { digest } from "./canonical.js";
import { RailError } from "./errors.js";
import {
  createDemoConnectorSigner,
  createDemoRecoverySigner,
  createDemoSigner,
  isValidKeyId,
  parsePublicKeyPem,
} from "./signing.js";

export const TRUSTED_KEYS_SCHEMA_VERSION = "consequence-rail/trusted-keys/v0.1";
export const TRUST_ROLES = Object.freeze(["rail", "connector", "recovery"]);
export const MAX_KEYS_PER_ROLE = 32;

const DOCUMENT_FIELDS = new Set(["schema_version", ...TRUST_ROLES]);
const ENTRY_FIELDS = new Set(["key_id", "public_key_pem"]);

function invalid(message) {
  return new RailError("TRUST_CONFIG_INVALID", message);
}

function isPlainObject(value) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertClosed(value, fields, label) {
  if (!isPlainObject(value)) throw invalid(`${label} must be an object.`);
  const unknown = Object.keys(value).filter((key) => !fields.has(key));
  if (unknown.length > 0) throw invalid(`${label} has an unsupported field.`);
}

/**
 * Validate a trusted-keys document and return one Map per role plus a digest
 * of the normalized key set. The digest does not depend on member order,
 * entry order, whitespace or PEM line endings. Errors name the role and entry
 * index and never include key material.
 */
export function parseTrustedKeys(value) {
  assertClosed(value, DOCUMENT_FIELDS, "Trusted keys document");
  if (value.schema_version !== TRUSTED_KEYS_SCHEMA_VERSION) {
    throw invalid(`Trusted keys schema_version must be ${TRUSTED_KEYS_SCHEMA_VERSION}.`);
  }
  const maps = {};
  const normalized = { schema_version: TRUSTED_KEYS_SCHEMA_VERSION };
  let total = 0;
  for (const role of TRUST_ROLES) {
    const entries = Object.hasOwn(value, role) ? value[role] : [];
    if (!Array.isArray(entries)) throw invalid(`Trusted keys ${role} must be an array.`);
    if (entries.length > MAX_KEYS_PER_ROLE) {
      throw invalid(`Trusted keys ${role} holds more than ${MAX_KEYS_PER_ROLE} keys.`);
    }
    const map = new Map();
    const rows = [];
    entries.forEach((entry, index) => {
      const label = `Trusted keys ${role}[${index}]`;
      assertClosed(entry, ENTRY_FIELDS, label);
      if (!isValidKeyId(entry.key_id)) {
        throw invalid(`${label}.key_id must be a non-empty string without control characters.`);
      }
      if (map.has(entry.key_id)) throw invalid(`${label}.key_id repeats a key_id in this role.`);
      const publicKey = parsePublicKeyPem(entry.public_key_pem, "TRUST_CONFIG_INVALID", `${label}.public_key_pem`);
      map.set(entry.key_id, publicKey);
      rows.push({
        key_id: entry.key_id,
        public_key_pem: publicKey.export({ format: "pem", type: "spki" }).toString(),
      });
    });
    rows.sort((left, right) => (left.key_id < right.key_id ? -1 : left.key_id > right.key_id ? 1 : 0));
    maps[role] = map;
    normalized[role] = rows;
    total += map.size;
  }
  if (total === 0) throw invalid("Trusted keys document must contain at least one key.");
  return { ...maps, trust_config_digest: digest(normalized) };
}

/** Read and validate a trusted-keys file through the bounded artifact loader. */
export function loadTrustedKeysFile(path) {
  return parseTrustedKeys(readArtifactFile(path));
}

/** The public demonstration keys as a trusted-keys document. */
export function demoTrustConfig() {
  const entry = (signer) => [{ key_id: signer.kid, public_key_pem: signer.publicKeyPem }];
  return {
    schema_version: TRUSTED_KEYS_SCHEMA_VERSION,
    rail: entry(createDemoSigner()),
    connector: entry(createDemoConnectorSigner()),
    recovery: entry(createDemoRecoverySigner()),
  };
}
