import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const excluded = new Set([".git", "node_modules", "coverage", ".consequence-rail"]);
const required = [
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "LICENSE",
  "package.json",
  "api/openapi.json",
  "spec/model.md",
  "spec/state-machine.md",
  "spec/schemas/action-proposal-v0.2.schema.json",
  "spec/schemas/connector-recourse-commitment.schema.json",
  "spec/schemas/recovery-contract.schema.json",
  "spec/schemas/recovery-drill-attestation.schema.json",
  "spec/schemas/recovery-drill-bundle.schema.json",
  "spec/schemas/settlement-bundle-v0.2.schema.json",
  "spec/schemas/settlement-receipt-v0.2.schema.json",
  "docs/threat-model.md",
  "conformance/refund-action.json",
  "conformance/refund-action-v0.2.json",
  "conformance/refund-recovery-contract.json",
];
const textExtensions = new Set([".md", ".json", ".js", ".yaml", ".yml", ".txt"]);
const workspaceMarker = ["do", "not", "edit", "or", "touch", "the"].join("-");
const SHA256_DIGEST_PATTERN = "^[A-Za-z0-9_-]{43}$";
const ED25519_SIGNATURE_PATTERN = "^[A-Za-z0-9_-]{86}$";
const findings = [];

function checkExplicitObjectSchemas(value, label, pointer = "") {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      checkExplicitObjectSchemas(item, label, `${pointer}/${index}`));
    return;
  }
  if (!value || typeof value !== "object") return;
  if (value.type === "object" && !Object.hasOwn(value, "additionalProperties")) {
    findings.push(
      `object schema must declare additionalProperties in ${label}${pointer}`,
    );
  }
  for (const [key, item] of Object.entries(value)) {
    checkExplicitObjectSchemas(item, label, `${pointer}/${key}`);
  }
}

function isDigestFieldName(name) {
  return (
    name.endsWith("_digest") ||
    name.endsWith("_digests") ||
    name === "event_hash" ||
    name === "previous_hash" ||
    name === "event_chain_head" ||
    name === "evidence_manifest"
  );
}

function schemaDeclaresDigestEncoding(schema) {
  if (!schema || typeof schema !== "object") return false;
  if (schema.pattern === SHA256_DIGEST_PATTERN) return true;
  if (schema.items) return schemaDeclaresDigestEncoding(schema.items);
  return [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])]
    .some(schemaDeclaresDigestEncoding);
}

function isSchemaNode(value) {
  return (
    value.type !== undefined ||
    value.pattern !== undefined ||
    value.minLength !== undefined ||
    value.items !== undefined ||
    value.anyOf !== undefined ||
    value.oneOf !== undefined ||
    value.allOf !== undefined ||
    value.const !== undefined
  );
}

function checkTypedIdentifiers(value, label, pointer = "", propertyName = "") {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      checkTypedIdentifiers(item, label, `${pointer}/${index}`, propertyName));
    return;
  }
  if (!value || typeof value !== "object") return;

  if (
    isDigestFieldName(propertyName) &&
    isSchemaNode(value) &&
    !schemaDeclaresDigestEncoding(value)
  ) {
    findings.push(
      `digest field must use unpadded SHA-256 base64url pattern ${SHA256_DIGEST_PATTERN} in ${label}${pointer}`,
    );
  }

  if (
    propertyName === "signature" &&
    value.properties?.value &&
    value.properties.value.pattern !== ED25519_SIGNATURE_PATTERN
  ) {
    findings.push(
      `signature.value must use canonical Ed25519 base64url pattern ${ED25519_SIGNATURE_PATTERN} in ${label}${pointer}`,
    );
  }

  for (const [key, item] of Object.entries(value)) {
    checkTypedIdentifiers(item, label, `${pointer}/${key}`, key);
  }
}

function walk(directory) {
  const output = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      output.push(...walk(path));
    } else {
      output.push(path);
    }
  }
  return output;
}

for (const item of required) {
  if (!existsSync(join(root, item))) {
    findings.push(`missing required file: ${item}`);
  }
}

const files = walk(root);
for (const path of files) {
  const label = relative(root, path).replaceAll("\\", "/");
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    findings.push(`symbolic link is not allowed: ${label}`);
    continue;
  }
  if (stat.size > 200_000) {
    findings.push(`file exceeds 200 KB: ${label}`);
  }

  const buffer = readFileSync(path);
  if (buffer.includes(0)) {
    findings.push(`binary file requires manual review: ${label}`);
    continue;
  }
  if (!textExtensions.has(extname(path))) continue;

  const text = buffer.toString("utf8");
  if (text.includes("\u2014")) {
    findings.push(`public prose contains an em dash: ${label}`);
  }
  if (/C:\\Users\\/i.test(text) || /\/Users\/[^/]+\//i.test(text)) {
    findings.push(`local user path found: ${label}`);
  }
  if (text.toLowerCase().includes(workspaceMarker)) {
    findings.push(`workspace marker found: ${label}`);
  }

  if (extname(path) === ".json") {
    try {
      const parsed = JSON.parse(text);
      if (label.startsWith("spec/schemas/") || label === "api/openapi.json") {
        checkExplicitObjectSchemas(parsed, label);
        checkTypedIdentifiers(parsed, label);
      }
    } catch (error) {
      findings.push(`invalid JSON in ${label}: ${error.message}`);
    }
  }

  if (extname(path) === ".md") {
    for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split("#", 1)[0];
      if (
        target === "" ||
        target.startsWith("http://") ||
        target.startsWith("https://") ||
        target.startsWith("mailto:")
      ) {
        continue;
      }
      const resolved = resolve(dirname(path), target);
      if (!resolved.startsWith(root) || !existsSync(resolved)) {
        findings.push(`broken or escaping relative link in ${label}: ${target}`);
      }
    }
  }
}

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (packageJson.private !== true || packageJson.license !== "Apache-2.0") {
  findings.push("package must remain non-publishable on npm and use Apache-2.0");
}
if (
  Object.keys(packageJson.dependencies ?? {}).length > 0 ||
  Object.keys(packageJson.devDependencies ?? {}).length > 0
) {
  findings.push("the reference implementation must remain dependency-free");
}

if (findings.length > 0) {
  process.stderr.write(`${findings.map((item) => `FAIL ${item}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `repository_check: pass\nfiles_checked: ${files.length}\njson_valid: true\nrelative_links: pass\npublic_prose: pass\n`,
  );
}
