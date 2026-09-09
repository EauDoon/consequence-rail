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
