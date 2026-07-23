import { createHash } from "node:crypto";
import { RailError } from "./errors.js";

function normalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RailError("CANONICALIZATION_FAILED", "Non-finite numbers are not supported.");
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalize(item));
  }

  if (typeof value === "object") {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) {
        throw new RailError("CANONICALIZATION_FAILED", "Undefined object fields are not supported.", {
          field: key,
        });
      }
      output[key] = normalize(value[key]);
    }
    return output;
  }

  throw new RailError("CANONICALIZATION_FAILED", `Unsupported value type: ${typeof value}.`);
}

export function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

export function digest(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("base64url");
}

export function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
  }
  return value;
}

export function without(object, fields) {
  return Object.fromEntries(Object.entries(object).filter(([key]) => !fields.includes(key)));
}
