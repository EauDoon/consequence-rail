import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArgs } from "../src/cli-args.js";

const DASH_DIGEST = `-${"A".repeat(42)}`;

function usageMessage(args) {
  try {
    parseCliArgs(args);
  } catch (error) {
    assert.equal(error.code, "USAGE_INVALID");
    return error.message;
  }
  assert.fail(`Expected USAGE_INVALID for ${JSON.stringify(args)}`);
}

test("a digest pin may begin with a dash as the next argument", () => {
  for (const flag of ["--expect-digest", "--expect-other-digest"]) {
    const name = flag.slice(2);
    assert.deepEqual(
      parseCliArgs(["bundle", "verify", "f.json", flag, DASH_DIGEST]),
      { positional: ["bundle", "verify", "f.json"], options: { [name]: DASH_DIGEST } },
    );
  }
});

test("every value flag accepts the --name=value form", () => {
  assert.deepEqual(
    parseCliArgs(["bundle", "verify", "f.json", `--expect-digest=${DASH_DIGEST}`, "--json"]),
    { positional: ["bundle", "verify", "f.json"], options: { "expect-digest": DASH_DIGEST, json: true } },
  );
  assert.deepEqual(
    parseCliArgs(["demo", "refund", "--fault=duplicate", "--assurance=cooperative", "--out=x=y.json"]),
    {
      positional: ["demo", "refund"],
      options: { fault: "duplicate", assurance: "cooperative", out: "x=y.json" },
    },
  );
});

test("empty, boolean and unknown --name=value forms are usage errors", () => {
  assert.match(usageMessage(["demo", "refund", "--fault="]), /^--fault requires a value\./);
  assert.match(usageMessage(["demo", "refund", "--json=1"]), /^Flag --json does not take a value\./);
  assert.match(usageMessage(["demo", "refund", "--typo=1"]), /^Unknown flag --typo\./);
  assert.match(
    usageMessage(["demo", "refund", "--fault", "none", "--fault=duplicate"]),
    /^Flag --fault was supplied more than once\./,
  );
  assert.match(
    usageMessage(["bundle", "verify", "f", `--expect-digest=${DASH_DIGEST}`, "--expect-digest", DASH_DIGEST]),
    /^Flag --expect-digest was supplied more than once\./,
  );
});

test("a dash-leading value is still refused for every other flag", () => {
  assert.match(usageMessage(["demo", "refund", "--fault", "--json"]), /^--fault requires a value\./);
  assert.match(usageMessage(["demo", "refund", "--fault", DASH_DIGEST]), /^--fault requires a value\./);
  assert.match(usageMessage(["demo", "refund", "--out", DASH_DIGEST]), /^--out requires a value\./);
  assert.match(
    usageMessage(["bundle", "verify", "f", "--expect-digest", `${DASH_DIGEST}A`]),
    /^--expect-digest requires a value\./,
  );
  assert.match(usageMessage(["bundle", "verify", "f", "--expect-digest", "--json"]), /^--expect-digest requires a value\./);
});

test("arguments after -- stay positional", () => {
  assert.deepEqual(
    parseCliArgs(["bundle", "verify", "--", "--json"]),
    { positional: ["bundle", "verify", "--json"], options: {} },
  );
});
