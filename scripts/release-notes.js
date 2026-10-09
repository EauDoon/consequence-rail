#!/usr/bin/env node
// Print the CHANGELOG section for one release tag, for example:
//   node scripts/release-notes.js v0.3.0
// Exits 1 when the tag is malformed or the section is missing.

import { readFileSync } from "node:fs";
import { releaseNotes } from "./release-metadata.js";

const tag = process.argv[2];
const version = typeof tag === "string" && tag.startsWith("v") ? tag.slice(1) : null;
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const notes = version === null ? null : releaseNotes(changelog, version);

if (notes === null || process.argv.length !== 3) {
  process.stderr.write(
    `No CHANGELOG.md section for ${tag ?? "(missing tag)"}. Usage: node scripts/release-notes.js vX.Y.Z\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(`${notes}\n`);
}
