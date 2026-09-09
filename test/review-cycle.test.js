import assert from "node:assert/strict";
import test from "node:test";
import { runRefundDemo } from "../src/demo.js";
import { demoTrustedKeys, demoConnectorTrustedKeys } from "../src/signing.js";
import { receiptBundle, reviewBundle, evidenceInventory } from "../src/review.js";
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

test("evidence inventory separates breach and remedy without disclosing facts", async () => {
  const { bundle } = await runRefundDemo({ fault: "duplicate" });
  const result = evidenceInventory(bundle, trust());
  assert.deepEqual(result.evidence.map(item => item.satisfied), [false, true]);
  assert.deepEqual(result.evidence.map(item => item.phase), ["initial", "post-remedy"]);
  assert(result.evidence.every(item => item.age_at_acceptance_ms >= 0));
  assert(!JSON.stringify(result).includes("ord_demo_42"));
  const minimal = evidenceInventory(receiptBundle(bundle, trust()), trust());
  assert(minimal.evidence.every(item => item.metadata_available === false));
  assert.throws(() => evidenceInventory(bundle));
});
