import assert from "node:assert/strict";
import test from "node:test";
import { runRefundDemo } from "../src/demo.js";
import { demoTrustedKeys, demoConnectorTrustedKeys } from "../src/signing.js";
import { reviewBundle, receiptBundle, evidenceInventory, lifecycleTiming, compareBundles } from "../src/review.js";
import { verifyArtifactFiles } from "../src/batch.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const trust = () => ({ trustedKeys: demoTrustedKeys(), trustedConnectorKeys: demoConnectorTrustedKeys() });

test("settlement collection rollups count valid files and attention separately", async t => {
  const dir = mkdtempSync(join(tmpdir(), "rail-collection-review-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = [];
  for (const [index, options] of [{}, { fault: "duplicate" }, { fault: "remedy-failure" }, { assuranceMode: "cooperative" }].entries()) {
    const file = join(dir, `${index}.json`);
    writeFileSync(file, JSON.stringify((await runRefundDemo(options)).bundle));
    files.push(file);
  }
  const report = verifyArtifactFiles([...files, files[0], join(dir, "missing.json")], trust());
  assert.deepEqual(report.outcome_counts, { settled: 3, compensated: 1, disputed: 1 });
  assert.deepEqual(report.assurance_counts, { enforced: 4, cooperative: 1 });
  assert.equal(report.attention_count, 3);
  assert.equal(report.attention_required, true);
  assert.equal(report.unique_bundle_count, 4);
  assert.equal(report.results[0].attention_required, false);
  assert.equal(report.results[2].attention_reasons.includes("disputed_outcome"), true);
});

test("comparison explains evidence changes separately from receipt projection", async () => {
  const normal = (await runRefundDemo()).bundle;
  const repaired = (await runRefundDemo({ fault: "duplicate" })).bundle;
  const report = compareBundles(normal, repaired, trust());
  assert.equal(report.same_evidence_manifest, false);
  assert.deepEqual(report.evidence_changes.added, repaired.evidence_manifest.filter(item => !normal.evidence_manifest.includes(item)));
  assert.deepEqual(report.evidence_changes.removed, normal.evidence_manifest.filter(item => !repaired.evidence_manifest.includes(item)));
  const projected = compareBundles(normal, receiptBundle(normal, trust()), trust());
  assert.equal(projected.same_evidence_manifest, true);
  assert.equal(projected.same_verification_context, false);
  assert.equal(projected.same_action_class, true);
  assert.deepEqual(projected.evidence_changes, { added: [], removed: [] });
  assert.equal(compareBundles(normal, normal, trust()).same_verification_context, true);
  repaired.evidence_manifest.reverse();
  assert.throws(() => compareBundles(normal, repaired, trust()));
});

test("timing groups recorded dwell by state and leaves terminal duration unknown", async () => {
  const { bundle } = await runRefundDemo({ fault: "remedy-lost-response-after-commit" });
  const report = lifecycleTiming(bundle, trust());
  assert.equal(report.final_state.state, "CLOSED");
  assert.equal(report.final_state.entered_at, report.intervals.at(-1).left_at);
  assert.equal(report.final_state.duration_ms, null);
  assert.equal(report.recorded_from, bundle.events[0].recorded_at);
  assert.equal(report.recorded_until, bundle.events.at(-1).recorded_at);
  assert(report.state_totals.some(row => row.state === "REMEDY_UNKNOWN"));
  assert.equal(report.state_totals.reduce((sum, row) => sum + row.visits, 0), report.intervals.length);
  assert.equal(report.state_totals.reduce((sum, row) => sum + row.duration_ms, 0), report.total_recorded_ms);
  assert(!report.state_totals.some(row => row.state === "CLOSED"));
});

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
