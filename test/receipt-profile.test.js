// Strict verification of the default receipt profile: verifySettlementArtifact,
// verifyArtifactFiles({ allowReceiptProfile }) and crctl --allow-receipt-profile.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyArtifactFiles } from "../src/batch.js";
import { deepClone, digest, without } from "../src/canonical.js";
import { runRefundDemo } from "../src/demo.js";
import { repoPath } from "../src/rail-test-helpers.js";
import { receiptBundle } from "../src/review.js";
import {
  createDemoSigner,
  demoConnectorTrustedKeys,
  demoTrustedKeys,
  signArtifact,
} from "../src/signing.js";
import {
  RECEIPT_PROFILE_LIMITATIONS,
  verifyBundle,
  verifySettlementArtifact,
} from "../src/verify.js";

const trust = () => ({ trustedKeys: demoTrustedKeys(), trustedConnectorKeys: demoConnectorTrustedKeys() });
const cli = (args) => spawnSync(process.execPath, [repoPath("cmd", "crctl.js"), ...args], {
  cwd: repoPath(), encoding: "utf8", timeout: 15_000,
});
const stderrJson = (result) => JSON.parse(result.stderr.trim().split(/\r?\n/).at(-1));
const SEMANTIC_REFUSAL = '{"code":"SEMANTIC_INVALID","message":"Full semantic verification requires an audit-profile bundle."}\n';

async function demoPair(fault = "none") {
  const { bundle } = await runRefundDemo({ fault });
  return { audit: bundle, receipt: receiptBundle(bundle, trust()) };
}

function resignReceipt(bundle, fields) {
  const changed = deepClone(bundle);
  changed.settlement_receipt = signArtifact({
    ...without(changed.settlement_receipt, ["signature"]),
    ...fields,
  }, createDemoSigner());
  return changed;
}

function shiftedCloseTime(bundle, ms) {
  return new Date(Date.parse(bundle.settlement_receipt.closed_at) + ms).toISOString();
}

function tempFiles(entries) {
  const dir = mkdtempSync(join(tmpdir(), "cr-receipt-profile-"));
  return Object.fromEntries(Object.entries(entries).map(([name, value]) => {
    const path = join(dir, `${name}.json`);
    writeFileSync(path, JSON.stringify(value));
    return [name, path];
  }));
}

test("verifySettlementArtifact accepts a receipt only when receipt profiles are allowed", async () => {
  const { audit, receipt } = await demoPair();
  assert.throws(() => verifySettlementArtifact(receipt, trust()), (error) => error.code === "SEMANTIC_INVALID");
  const result = verifySettlementArtifact(receipt, { ...trust(), allowReceiptProfile: true });
  assert.equal(result.valid, true);
  assert.deepEqual(result.semantics, { status: "not_requested", valid: null });
  assert.equal(result.profile, "receipt");
  assert.equal(result.verification_scope, "integrity_only");
  assert.deepEqual(result.limitations, [...RECEIPT_PROFILE_LIMITATIONS]);
  assert.ok(result.limitations.some((limitation) => limitation.includes("action.resource_id_digest")));
  assert.equal(result.outcome, "settled");

  // Without the option the result is exactly the strict verifyBundle result.
  assert.deepEqual(verifySettlementArtifact(audit, trust()), verifyBundle(audit, { ...trust(), requireSemantics: true }));
  const allowedAudit = verifySettlementArtifact(audit, { ...trust(), allowReceiptProfile: true });
  assert.equal(allowedAudit.semantics.status, "verified");
  assert.equal(allowedAudit.verification_scope, "integrity_and_lifecycle_semantics");
  assert.equal(Object.hasOwn(allowedAudit, "limitations"), false);
  // Only the boolean true opts in.
  assert.throws(() => verifySettlementArtifact(receipt, { ...trust(), allowReceiptProfile: "true" }),
    (error) => error.code === "SEMANTIC_INVALID");
});

test("allowing receipt profiles keeps every integrity binding", async () => {
  const { audit, receipt } = await demoPair();
  const allowed = { ...trust(), allowReceiptProfile: true };

  // Round-1 guarantee: a relabelled action class is still tampered.
  const relabeled = deepClone(receipt);
  relabeled.action.action_type = "demo.email.send/v1";
  assert.throws(() => verifySettlementArtifact(relabeled, allowed), (error) =>
    error.code === "BUNDLE_TAMPERED" && error.message === "Action summary does not match the signed ACTION_PROPOSED event.");

  // The close time stays bound to the terminal CLOSED event.
  for (const ms of [1001, -1]) {
    assert.throws(() => verifySettlementArtifact(resignReceipt(receipt, { closed_at: shiftedCloseTime(receipt, ms) }), allowed),
      (error) => error.code === "BUNDLE_TAMPERED", String(ms));
  }
  assert.equal(verifySettlementArtifact(resignReceipt(receipt, { closed_at: shiftedCloseTime(receipt, 1000) }), allowed).valid, true);

  // The outcome stays bound to the terminal CLOSED event.
  assert.throws(() => verifySettlementArtifact(resignReceipt(receipt, { outcome: "compensated" }), allowed),
    (error) => error.code === "BUNDLE_TAMPERED");
  // Untrusted keys are still refused.
  assert.throws(() => verifySettlementArtifact(receipt, { allowReceiptProfile: true }), (error) => error.code === "UNTRUSTED_KEY");

  // Audit bundles keep mandatory semantics: a 1 ms close-time gap is an
  // integrity pass for a receipt but a semantic failure for an audit bundle.
  const lagged = resignReceipt(audit, { closed_at: shiftedCloseTime(audit, 1) });
  assert.throws(() => verifySettlementArtifact(lagged, allowed), (error) => error.code === "SEMANTIC_INVALID");

  // The documented gap: resource_id_digest is not signed in this profile, so a
  // substitution still verifies and the result says so.
  const substituted = deepClone(receipt);
  substituted.action.resource_id_digest = digest({ other: "resource" });
  const disclosed = verifySettlementArtifact(substituted, allowed);
  assert.equal(disclosed.valid, true);
  assert.match(disclosed.limitations.join(" "), /action\.resource_id_digest is not bound/);
});

test("crctl bundle verify accepts a receipt only with --allow-receipt-profile", async () => {
  const { audit, receipt } = await demoPair();
  const relabeled = deepClone(receipt);
  relabeled.action.action_type = "demo.email.send/v1";
  const paths = tempFiles({
    audit,
    receipt,
    relabeled,
    lagged: resignReceipt(audit, { closed_at: shiftedCloseTime(audit, 1) }),
    moved: resignReceipt(receipt, { closed_at: shiftedCloseTime(receipt, 1001) }),
  });

  for (const args of [[], ["--json"]]) {
    const strict = cli(["bundle", "verify", paths.receipt, ...args]);
    assert.equal(strict.status, 1);
    assert.equal(strict.stdout, "");
    assert.equal(strict.stderr, SEMANTIC_REFUSAL);
  }

  const json = cli(["bundle", "verify", paths.receipt, "--allow-receipt-profile", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  const result = JSON.parse(json.stdout);
  assert.equal(result.verification_scope, "integrity_only");
  assert.equal(result.profile, "receipt");
  assert.equal(result.semantics.status, "not_requested");
  assert.deepEqual(result.limitations, [...RECEIPT_PROFILE_LIMITATIONS]);
  assert.equal(result.bundle_digest, digest(receipt));

  const text = cli(["bundle", "verify", paths.receipt, "--allow-receipt-profile"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^semantics: not_requested$/m);
  assert.match(text.stdout, /^profile: receipt$/m);
  assert.match(text.stdout, /^verification_scope: integrity_only$/m);
  assert.match(text.stdout, /^limitation: action\.resource_id_digest is not bound/m);

  const auditText = cli(["bundle", "verify", paths.audit, "--allow-receipt-profile"]);
  assert.match(auditText.stdout, /^semantics: verified$/m);
  assert.match(auditText.stdout, /^verification_scope: integrity_and_lifecycle_semantics$/m);
  assert.doesNotMatch(auditText.stdout, /limitation:/);

  for (const [name, code] of [["relabeled", "BUNDLE_TAMPERED"], ["moved", "BUNDLE_TAMPERED"], ["lagged", "SEMANTIC_INVALID"]]) {
    const refused = cli(["bundle", "verify", paths[name], "--allow-receipt-profile", "--json"]);
    assert.equal(refused.status, 1, name);
    assert.equal(stderrJson(refused).code, code, name);
  }

  // The outcome gate works on receipts.
  const met = cli(["bundle", "verify", paths.receipt, "--allow-receipt-profile", "--require-outcome", "settled", "--json"]);
  assert.equal(met.status, 0);
  assert.equal(JSON.parse(met.stdout).outcome_expectation_met, true);
  const unmet = cli(["bundle", "verify", paths.receipt, "--allow-receipt-profile", "--require-outcome", "disputed", "--json"]);
  assert.equal(unmet.status, 1);
  assert.equal(JSON.parse(unmet.stdout).outcome_expectation_met, false);

  // The flag combines with a checkpoint taken from the receipt's own chain.
  const checkpoint = `3:${receipt.events[2].event_hash}`;
  const checked = cli(["bundle", "verify", paths.receipt, "--allow-receipt-profile", "--expect-checkpoint", checkpoint, "--json"]);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).checkpoint.event_count, 3);
  const relabeledChecked = cli(["bundle", "verify", paths.relabeled, "--allow-receipt-profile", "--expect-checkpoint", checkpoint]);
  assert.equal(stderrJson(relabeledChecked).code, "BUNDLE_TAMPERED");
});

test("default bundle verify output is unchanged without the flag", async () => {
  const { audit } = await demoPair();
  const paths = tempFiles({ audit });
  const result = JSON.parse(cli(["bundle", "verify", paths.audit, "--json"]).stdout);
  assert.deepEqual(result, { ...verifyBundle(audit, { ...trust(), requireSemantics: true }), bundle_digest: digest(audit) });
  const text = cli(["bundle", "verify", paths.audit]).stdout;
  assert.doesNotMatch(text, /profile:|verification_scope:|limitation:/);
});

test("crctl verify-many batch-verifies receipts and mixed collections with --allow-receipt-profile", async () => {
  const settled = await demoPair();
  const disputed = await demoPair("stale-evidence");
  const compensated = await demoPair("duplicate");
  const paths = tempFiles({
    audit: settled.audit,
    receipt: settled.receipt,
    disputedReceipt: disputed.receipt,
    otherReceipt: compensated.receipt,
  });

  const strict = cli(["bundle", "verify-many", paths.receipt, paths.audit]);
  assert.equal(strict.status, 1);
  const strictResult = JSON.parse(strict.stdout);
  assert.equal(strictResult.valid, false);
  assert.equal(strictResult.results[0].code, "SEMANTIC_INVALID");
  assert.equal(Object.hasOwn(strictResult, "profile_counts"), false);
  assert.equal(Object.hasOwn(strictResult.results[1], "profile"), false);

  const mixed = cli(["bundle", "verify-many", paths.receipt, paths.audit, "--allow-receipt-profile"]);
  assert.equal(mixed.status, 0, mixed.stderr);
  const result = JSON.parse(mixed.stdout);
  assert.equal(result.valid, true);
  assert.deepEqual(result.profile_counts, { receipt: 1, audit: 1 });
  assert.equal(result.results[0].verification_scope, "integrity_only");
  assert.deepEqual(result.results[0].limitations, [...RECEIPT_PROFILE_LIMITATIONS]);
  assert.equal(result.results[1].verification_scope, "integrity_and_lifecycle_semantics");
  assert.equal(result.results[1].semantics, "verified");
  assert.equal(result.review_required, false);

  const met = cli(["bundle", "verify-many", paths.receipt, paths.audit, "--allow-receipt-profile", "--require-outcome", "settled"]);
  assert.equal(met.status, 0);
  assert.equal(JSON.parse(met.stdout).outcome_expectation_met, true);
  const disputedMet = cli(["bundle", "verify-many", paths.disputedReceipt, "--allow-receipt-profile", "--require-outcome", "disputed"]);
  assert.equal(disputedMet.status, 0, disputedMet.stderr);
  assert.equal(JSON.parse(disputedMet.stdout).outcome_expectation_met, true);
  const unmet = cli(["bundle", "verify-many", paths.receipt, paths.disputedReceipt, "--allow-receipt-profile", "--require-outcome", "settled"]);
  assert.equal(unmet.status, 1);
  assert.equal(JSON.parse(unmet.stdout).outcome_expectation_met, false);

  // Two different signed receipts for one action still require review.
  const differing = cli(["bundle", "verify-many", paths.receipt, paths.otherReceipt, "--allow-receipt-profile"]);
  assert.equal(differing.status, 1);
  const differingResult = JSON.parse(differing.stdout);
  assert.equal(differingResult.valid, true);
  assert.equal(differingResult.review_required, true);
  assert.equal(differingResult.differing_receipts.length, 1);
});

test("verifyArtifactFiles names the profile only when receipt profiles are allowed", async () => {
  const { audit, receipt } = await demoPair();
  const relabeled = deepClone(receipt);
  relabeled.action.action_type = "demo.email.send/v1";
  const paths = tempFiles({ audit, receipt, relabeled });
  const strict = verifyArtifactFiles([paths.audit], trust());
  assert.equal(Object.hasOwn(strict.results[0], "verification_scope"), false);
  const allowed = verifyArtifactFiles([paths.audit, paths.receipt, paths.relabeled], { ...trust(), allowReceiptProfile: true });
  assert.equal(allowed.passed, 2);
  assert.deepEqual(allowed.results[2], { file: paths.relabeled, valid: false, code: "BUNDLE_TAMPERED" });
  assert.deepEqual(allowed.profile_counts, { audit: 1, receipt: 1 });
});

test("--allow-receipt-profile is accepted only by bundle verify and verify-many", async () => {
  const { audit } = await demoPair();
  const paths = tempFiles({ audit });
  for (const args of [
    ["bundle", "review", paths.audit],
    ["bundle", "timeline", paths.audit],
    ["bundle", "compare", paths.audit, paths.audit],
    ["recovery-preflight", "verify", paths.audit],
    ["demo", "refund"],
    ["trust", "demo"],
  ]) {
    const result = cli([...args, "--allow-receipt-profile"]);
    assert.equal(result.status, 1, args.join(" "));
    assert.deepEqual(stderrJson(result), {
      code: "USAGE_INVALID",
      message: "Flag --allow-receipt-profile is not valid for this command. Run with --help.",
    });
  }
  const valued = cli(["bundle", "verify", paths.audit, "--allow-receipt-profile=true"]);
  assert.equal(stderrJson(valued).message, "Flag --allow-receipt-profile does not take a value. Run with --help.");
});
