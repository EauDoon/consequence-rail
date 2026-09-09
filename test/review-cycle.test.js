import assert from "node:assert/strict";
import test from "node:test";
import { runRefundDemo } from "../src/demo.js";
import { demoTrustedKeys, demoConnectorTrustedKeys } from "../src/signing.js";
import { receiptBundle, reviewBundle } from "../src/review.js";
const trust = () => ({ trustedKeys: demoTrustedKeys(), trustedConnectorKeys: demoConnectorTrustedKeys() });

test("receipt projection preserves signed artifacts and omits audit facts without mutation", async () => {
  const { bundle, runtime, summary } = await runRefundDemo({ fault: "duplicate" });
  const before = JSON.stringify(bundle), receipt = receiptBundle(bundle, trust());
  assert.deepEqual(receipt, runtime.rail.exportBundle(summary.action_id));
  assert.equal(JSON.stringify(bundle), before);
  assert.equal(reviewBundle(receipt, trust()).verification_scope, "integrity_only");
  assert.equal(JSON.stringify(receipt).includes("ord_demo_42"), false);
  assert.throws(() => receiptBundle(bundle), { code: "UNTRUSTED_KEY" });
  bundle.outcome_evidence[0].source = "altered";
  assert.throws(() => receiptBundle(bundle, trust()));
});
