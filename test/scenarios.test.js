import assert from "node:assert/strict";
import test from "node:test";
import { scenarioCatalog } from "../src/scenarios.js";

test("catalog documents every runnable synthetic fault with detached expectations", () => {
  const catalog = scenarioCatalog();
  assert.equal(catalog.synthetic_only, true);
  assert.equal(catalog.scenarios.length, 4);
  assert.equal(catalog.scenarios.flatMap((scenario) => scenario.faults).length, 30);
  for (const scenario of catalog.scenarios) for (const fault of scenario.faults) {
    assert.equal(typeof fault.purpose, "string");
    assert.ok(Object.keys(fault.expected).length);
  }
  catalog.scenarios[0].faults[0].expected.outcome = "disputed";
  assert.equal(scenarioCatalog().scenarios[0].faults[0].expected.outcome, "settled");
});
