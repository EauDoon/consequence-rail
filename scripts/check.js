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
  "spec/schemas/connector-recourse-commitment.schema.json",
  "docs/threat-model.md",
  "conformance/refund-action.json",
];
const textExtensions = new Set([".md", ".json", ".js", ".yaml", ".yml", ".txt"]);
const workspaceMarker = ["do", "not", "edit", "or", "touch", "the"].join("-");
const findings = [];

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
      JSON.parse(text);
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
  findings.push("v0.1 must remain dependency-free");
}

if (findings.length > 0) {
  process.stderr.write(`${findings.map((item) => `FAIL ${item}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `repository_check: pass\nfiles_checked: ${files.length}\njson_valid: true\nrelative_links: pass\npublic_prose: pass\n`,
  );
}
