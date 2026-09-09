import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, deepClone, JSON_LIMITS } from "../src/canonical.js";

test("JSON traversal rejects cycles and bounds nesting, nodes and strings", () => {
  const cycle = {}; cycle.self = cycle;
  let deep = {}; for (let i = 0; i < 65; i++) deep = { deep };
  for (const value of [cycle, deep, new Array(JSON_LIMITS.maxNodes + 1), "x".repeat(JSON_LIMITS.maxStringUnits + 1)]) {
    for (const operation of [canonicalJson, deepClone]) {
      assert.throws(() => operation(value), { code: "CANONICALIZATION_FAILED" });
    }
  }
});

test("JSON traversal allows shared references but rejects hidden data without reading accessors", () => {
  const shared = { x: 1 };
  assert.equal(canonicalJson({ b: shared, a: shared }), '{"a":{"x":1},"b":{"x":1}}');
  const hidden = Object.defineProperty({}, "secret", { value: 1 });
  assert.throws(() => deepClone(hidden), { code: "CANONICALIZATION_FAILED" });
  let reads = 0;
  const accessor = Object.defineProperty({}, "x", { enumerable: true, get() { reads++; return 1; } });
  assert.throws(() => canonicalJson(accessor), { code: "CANONICALIZATION_FAILED" });
  assert.equal(reads, 0);
});
