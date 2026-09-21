// Thin entry point for the rail module test suite. The actual tests are
// split into focused files, all of which `node --test` discovers
// automatically alongside this file:
//   test/rail.canonical.test.js   - canonical + atomic append
//   test/rail.lifecycle.test.js   - validation + lifecycle + execution + remedy
//   test/rail.assurance.test.js   - assurance modes + permit issuance
//   test/rail.bundle.test.js      - bundle export + integrity + semantic verification
//   test/rail.http.test.js        - HTTP sidecar
//   test/rail.conformance.test.js - conformance fixture + schema fields
//
// Shared helpers live in src/rail-test-helpers.js. They are kept outside
// test/ so the test runner does not pick them up as a test file.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

const EXPECTED_FOCUS_FILES = [
  "test/rail.canonical.test.js",
  "test/rail.lifecycle.test.js",
  "test/rail.assurance.test.js",
  "test/rail.bundle.test.js",
  "test/rail.http.test.js",
  "test/rail.conformance.test.js",
];

test("rail module test suite is split into focused files", () => {
  for (const focusFile of EXPECTED_FOCUS_FILES) {
    const contents = readFileSync(join(process.cwd(), focusFile), "utf8");
    assert.match(contents, /import test from "node:test"/);
    assert.ok(/^test\(/m.test(contents));
  }
});

test("rail module public API is exported through the shim", async () => {
  const { ConsequenceRail, ASSURANCE_MODES, ALLOWED_TRANSITIONS, recourseScopeField } =
    await import("../src/rail.js");
  assert.equal(typeof ConsequenceRail, "function");
  assert.deepEqual(ASSURANCE_MODES, ["enforced", "cooperative", "observed"]);
  assert.equal(typeof ALLOWED_TRANSITIONS, "object");
  assert.equal(typeof recourseScopeField("demo.refund.issue/v1"), "string");
});
