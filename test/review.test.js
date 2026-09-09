import assert from "node:assert/strict";
import test from "node:test";
import { runRefundDemo } from "../src/demo.js";
import { demoTrustedKeys, demoConnectorTrustedKeys } from "../src/signing.js";
import { reviewBundle } from "../src/review.js";
const trust = () => ({ trustedKeys: demoTrustedKeys(), trustedConnectorKeys: demoConnectorTrustedKeys() });

test("review verifies audit semantics and omits raw proposal and evidence", async () => {
  const { bundle } = await runRefundDemo({ fault: "duplicate" });
  const before = JSON.stringify(bundle);
  const report = reviewBundle(bundle, trust());
  assert.equal(report.outcome, "compensated");
  assert.equal(report.verification_scope, "integrity_and_lifecycle_semantics");
  assert.equal(report.state_path[0], "PROPOSED");
  assert.deepEqual(report.state_path, ["PROPOSED", ...bundle.events
    .filter((event) => event.event_type === "STATE_TRANSITION")
    .map((event) => event.payload.to_state)]);
  assert.equal(report.state_path.at(-1), "CLOSED");
  assert.equal(report.evidence_count, 2);
  assert.equal(JSON.stringify(bundle), before);
  assert.ok(!JSON.stringify(report).includes("ord_demo_42"));
  assert.throws(() => reviewBundle(bundle), { code: "UNTRUSTED_KEY" });
  bundle.settlement_receipt.outcome = "settled";
  assert.throws(() => reviewBundle(bundle, trust()));
});

test("receipt review explicitly discloses missing semantic verification", async () => {
  const { runtime, summary } = await runRefundDemo();
  const receipt = runtime.rail.exportBundle(summary.action_id);
  const report = reviewBundle(receipt, trust());
  assert.equal(report.verification_scope, "integrity_only");
  assert.match(report.limitations[0], /not verified/);
});
import { compareBundles } from "../src/review.js";

test("comparison distinguishes profile changes from a different signed settlement", async () => {
  const { bundle, runtime, summary } = await runRefundDemo();
  const receipt = runtime.rail.exportBundle(summary.action_id);
  const profiles = compareBundles(bundle, receipt, trust());
  assert.equal(profiles.same_receipt, true);
  assert.equal(profiles.same_bundle, false);
  assert.equal(profiles.same_action, true);
  assert.ok(profiles.changes.some((entry) => entry.field === "verification_scope"));
  assert.equal(compareBundles(bundle, bundle, trust()).changes.length, 0);
  const duplicate = (await runRefundDemo({ fault: "duplicate" })).bundle;
  const different = compareBundles(bundle, duplicate, trust());
  assert.equal(different.same_receipt, false);
  assert.ok(different.changes.some((entry) => entry.field === "outcome"));
  duplicate.events.pop();
  assert.throws(() => compareBundles(bundle, duplicate, trust()));
});
