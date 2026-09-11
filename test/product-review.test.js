import assert from "node:assert/strict";
import test from "node:test";
import { runRefundDemo } from "../src/demo.js";
import { demoTrustedKeys, demoConnectorTrustedKeys } from "../src/signing.js";
import { reviewBundle, receiptBundle, evidenceInventory, lifecycleTiming, compareBundles } from "../src/review.js";
const trust = () => ({ trustedKeys: demoTrustedKeys(), trustedConnectorKeys: demoConnectorTrustedKeys() });

test("evidence diagnostics locate failed clauses without exposing values or paths", async () => {
  const { bundle } = await runRefundDemo({ fault: "duplicate" });
  const result = evidenceInventory(bundle, trust());
  const failed = bundle.outcome_evidence[0].evaluation.evaluations
    .flatMap((clause, index) => clause.satisfied ? [] : [{ clause_index: index, operator: clause.operator }]);
  assert(failed.length > 0);
  assert.deepEqual(result.evidence[0].failed_clauses, failed);
  assert.deepEqual(result.evidence[1].failed_clauses, []);
  assert.equal(result.evidence[0].clause_count, bundle.action.proposal.postcondition.clauses.length);
  assert(!JSON.stringify(result).includes('"expected"'));
  assert(!JSON.stringify(result).includes('"path"'));
  const receipt = evidenceInventory(receiptBundle(bundle, trust()), trust());
  assert(receipt.evidence.every(item => !Object.hasOwn(item, "failed_clauses")));
});

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
