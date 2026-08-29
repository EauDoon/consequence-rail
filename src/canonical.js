import { createHash } from "node:crypto";
import { types } from "node:util";
import { RailError } from "./errors.js";

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
  return Object.keys(value).map((key) => {
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
    return arrayValues(value).map((item) => normalize(item));
  }

  if (typeof value === "object") {
    const output = Object.create(null);
    for (const [key, item] of objectEntries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0)) {
      if (item === undefined) {
        throw new RailError("CANONICALIZATION_FAILED", "Undefined object fields are not supported.", {
          field: key,
        });
      }
      Object.defineProperty(output, key, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: normalize(item),
      });
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
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      canonicalizationError("Non-finite numbers are not supported.");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return arrayValues(value).map((item) => deepClone(item));
  }
  if (typeof value === "object") {
    const output = {};
    for (const [key, item] of objectEntries(value)) {
      if (item === undefined) {
        canonicalizationError("Undefined object fields are not supported.", {
          field: key,
        });
      }
      Object.defineProperty(output, key, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: deepClone(item),
      });
    }
    return output;
  }
  canonicalizationError(`Unsupported value type: ${typeof value}.`);
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
