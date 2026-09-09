import { createHash } from "node:crypto";
import { types } from "node:util";
import { RailError } from "./errors.js";

export const JSON_LIMITS = Object.freeze({ maxDepth: 64, maxNodes: 100_000, maxStringUnits: 4_194_304 });

const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function canonicalizationError(message, details = {}) {
  throw new RailError("CANONICALIZATION_FAILED", message, details);
}

function objectEntries(value) {
  if (types.isProxy(value)) {
    canonicalizationError("Proxy objects are not supported.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    canonicalizationError("Only plain JSON objects are supported.");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    canonicalizationError("Symbol object fields are not supported.");
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length > JSON_LIMITS.maxNodes) canonicalizationError("Object exceeds the JSON node limit.");
  return names.map((key) => {
    if (RESERVED_KEYS.has(key)) {
      canonicalizationError("Reserved object fields are not supported.", {
        field: key,
      });
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      canonicalizationError("Only enumerable data fields are supported.", {
        field: key,
      });
    }
    return [key, descriptor.value];
  });
}

function arrayValues(value) {
  if (types.isProxy(value)) {
    canonicalizationError("Proxy arrays are not supported.");
  }
  if (value.length > JSON_LIMITS.maxNodes) {
    canonicalizationError("Array exceeds the JSON node limit.");
  }
  const ownKeys = Reflect.ownKeys(value);
  const expectedKeys = new Set([
    ...Array.from({ length: value.length }, (_, index) => String(index)),
    "length",
  ]);
  if (ownKeys.some((key) => typeof key !== "string" || !expectedKeys.has(key))) {
    canonicalizationError("Arrays with extra fields are not supported.");
  }
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) {
      canonicalizationError("Sparse or accessor-backed arrays are not supported.");
    }
    return descriptor.value;
  });
}

function copyJson(value, sorted, state, depth = 0) {
  if (depth > JSON_LIMITS.maxDepth || ++state.nodes > JSON_LIMITS.maxNodes) {
    canonicalizationError("JSON depth or node limit exceeded.");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    state.stringUnits += value.length;
    if (state.stringUnits > JSON_LIMITS.maxStringUnits) {
      canonicalizationError("JSON string budget exceeded.");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) canonicalizationError("Non-finite numbers are not supported.");
    return value;
  }
  if (typeof value !== "object") canonicalizationError(`Unsupported value type: ${typeof value}.`);
  if (state.ancestors.has(value)) canonicalizationError("Cyclic JSON values are not supported.");
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return arrayValues(value).map((item) => copyJson(item, sorted, state, depth + 1));
    }
    const entries = objectEntries(value);
    if (sorted) entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    const output = {};
    for (const [key, item] of entries) {
      state.stringUnits += key.length;
      if (state.stringUnits > JSON_LIMITS.maxStringUnits) canonicalizationError("JSON string budget exceeded.");
      Object.defineProperty(output, key, {
        enumerable: true, configurable: true, writable: true,
        value: copyJson(item, sorted, state, depth + 1),
      });
    }
    return output;
  } finally {
    state.ancestors.delete(value);
  }
}

function copy(value, sorted) {
  return copyJson(value, sorted, { nodes: 0, stringUnits: 0, ancestors: new Set() });
}

export function canonicalJson(value) {
  return JSON.stringify(copy(value, true));
}

/** SHA-256 of canonical JSON as unpadded base64url (43 characters). */
export function digest(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("base64url");
}

export function deepClone(value) {
  return copy(value, false);
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
  const output = {};
  for (const [key, value] of objectEntries(object)) {
    if (!fields.includes(key)) {
      Object.defineProperty(output, key, {
        enumerable: true,
        configurable: true,
        writable: true,
        value,
      });
    }
  }
  return output;
}
