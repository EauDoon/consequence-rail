import assert from "node:assert/strict";
import test from "node:test";
import { runRefundDemo } from "../src/demo.js";
import { demoTrustedKeys, demoConnectorTrustedKeys } from "../src/signing.js";
import { reviewBundle, receiptBundle, evidenceInventory, lifecycleTiming, compareBundles } from "../src/review.js";
const trust = () => ({ trustedKeys: demoTrustedKeys(), trustedConnectorKeys: demoConnectorTrustedKeys() });

test("review separates valid artifacts from histories requiring attention", async () => {
  const normal = reviewBundle((await runRefundDemo()).bundle, trust());
  assert.deepEqual(normal.attention_reasons, []);
  assert.equal(normal.attention_required, false);
  for (const [options, reason] of [
    [{ fault: "duplicate" }, "compensation_recorded"],
    [{ fault: "remedy-failure" }, "disputed_outcome"],
    [{ fault: "lost-response-after-commit" }, "ambiguous_history"],
    [{ assuranceMode: "cooperative" }, "bypass_possible"],
  ]) {
    const { bundle } = await runRefundDemo(options);
    const result = reviewBundle(bundle, trust());
    assert.equal(result.valid, true);
    assert.equal(result.attention_required, true);
    assert(result.attention_reasons.includes(reason));
    assert(reviewBundle(receiptBundle(bundle, trust()), trust()).attention_reasons.includes("semantics_not_checked"));
  }
});
