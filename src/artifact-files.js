import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { deepClone, digest } from "./canonical.js";
import { RailError } from "./errors.js";
import { parseUniqueJson } from "./json-input.js";

export const MAX_ARTIFACT_BYTES = 1_048_576;

/** Keep exported JSON readable by the bounded loader, including the final LF. */
export function serializeArtifact(value) {
  const snapshot = deepClone(value);
  let text = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_ARTIFACT_BYTES) text = `${JSON.stringify(snapshot)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_ARTIFACT_BYTES) {
    throw new RailError("ARTIFACT_TOO_LARGE", "Serialized artifact exceeds the 1 MiB output limit.");
  }
  return text;
}

/** Read one bounded, regular UTF-8 JSON file. Never read directories or streams. */
export function readArtifactFile(path) {
  let descriptor;
  let bytes;
  try {
    descriptor = openSync(resolve(path), constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new RailError("ARTIFACT_FILE_INVALID", "Artifact input must be a regular file.");
    if (stat.size > MAX_ARTIFACT_BYTES) throw new RailError("ARTIFACT_TOO_LARGE", "Artifact exceeds the 1 MiB file limit.");
    const buffer = Buffer.alloc(MAX_ARTIFACT_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = readSync(descriptor, buffer, count, buffer.length - count, null);
      if (!read) break;
      count += read;
    }
    if (count > MAX_ARTIFACT_BYTES) throw new RailError("ARTIFACT_TOO_LARGE", "Artifact exceeds the 1 MiB file limit.");
    bytes = buffer.subarray(0, count);
  } catch (error) {
    if (error instanceof RailError) throw error;
    const message = error.code === "ENOENT" ? `File not found: ${path}.` : `Could not read file: ${path}.`;
    throw new RailError("USAGE_INVALID", `${message} Run with --help.`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new RailError("ARTIFACT_ENCODING_INVALID", "Artifact must be valid UTF-8."); }
  if (text.trim() === "") throw new RailError("USAGE_INVALID", `File is empty: ${path}. Run with --help.`);
  let value;
  try { value = parseUniqueJson(text); }
  catch (error) {
    if (error instanceof RailError) throw error;
    throw new RailError("USAGE_INVALID", `File is not valid JSON: ${path}. Run with --help.`);
  }
  return deepClone(value);
}

/** Check an independently recorded canonical digest before accepting an artifact. */
export function assertArtifactDigest(value, expected) {
  if (typeof expected !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(expected) ||
      Buffer.from(expected, "base64url").toString("base64url") !== expected) {
    throw new RailError("DIGEST_PIN_INVALID", "Expected an unpadded canonical SHA-256 base64url digest.");
  }
  const actual = digest(value);
  if (actual !== expected) throw new RailError("DIGEST_PIN_MISMATCH", "Artifact does not match the expected canonical digest.");
  return actual;
}
