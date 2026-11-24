import { readArtifactFile } from "./artifact-files.js";
import { reviewBundle } from "./review.js";
import { RailError } from "./errors.js";
import { digest } from "./canonical.js";
import { types } from "node:util";
import { reviewRecovery } from "./recovery-review.js";
import { assertVerificationTime } from "./recovery-preflight.js";
import { settlementProfileFields } from "./verify.js";

export const MAX_BATCH_FILES = 64;

/**
 * Independent strict audit verification. A bad file cannot hide other results.
 * With allowReceiptProfile, receipt-profile files get integrity verification
 * and every row names its profile, verification scope and any limitations.
 */
export function verifyArtifactFiles(paths, options = {}) {
  paths = validatePaths(paths);
  const { allowReceiptProfile, ...trust } = options;
  const allowReceipts = allowReceiptProfile === true;
  const results = paths.map((file) => {
    try {
      const bundle = readArtifactFile(file);
      // reviewBundle always replays audit semantics; receipts stay strict
      // unless receipt profiles are allowed.
      const result = reviewBundle(bundle, { ...trust, requireSemantics: !allowReceipts });
      return { file, valid: true, action_id: result.action_id, action_digest: bundle.action.action_digest,
        bundle_digest: digest(bundle), receipt_digest: digest(bundle.settlement_receipt),
        outcome: result.outcome, semantics: result.semantics.status, assurance_mode: result.assurance_mode,
        attention_required: result.attention_required, attention_reasons: result.attention_reasons,
        ...(allowReceipts ? settlementProfileFields(bundle.profile) : {}) };
    } catch (error) {
      return { file, valid: false, code: error instanceof RailError ? error.code : "VERIFICATION_FAILED" };
    }
  });
  const byAction = new Map(), byBundle = new Map();
  for (const result of results.filter(item => item.valid)) {
    for (const [groups, key] of [[byAction, result.action_digest], [byBundle, result.bundle_digest]]) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(result);
    }
  }
  const differing_receipts = [...byAction].filter(([, rows]) => new Set(rows.map(row => row.receipt_digest)).size > 1)
    .map(([action_digest, rows]) => ({ action_digest, files: rows.map(row => row.file), receipt_digests: [...new Set(rows.map(row => row.receipt_digest))] }));
  const duplicates = [...byBundle].filter(([, rows]) => rows.length > 1)
    .map(([bundle_digest, rows]) => ({ bundle_digest, files: rows.map(row => row.file) }));
  const verified = results.filter(item => item.valid);
  const counts = field => Object.fromEntries([...new Set(verified.map(row => row[field]))]
    .map(value => [value, verified.filter(row => row[field] === value).length]));
  const attentionCount = verified.filter(row => row.attention_required).length;
  return { ...batchResult(results), duplicates, differing_receipts, review_required: differing_receipts.length > 0,
    outcome_counts: counts("outcome"), assurance_counts: counts("assurance_mode"),
    ...(allowReceipts ? { profile_counts: counts("profile") } : {}),
    attention_count: attentionCount, attention_required: attentionCount > 0, unique_bundle_count: byBundle.size,
    collection_limitation: "Different receipts for one action require review; this report cannot choose the authoritative settlement." };
}

function validatePaths(input) {
  const invalid = () => new RailError("BATCH_INVALID", "Supply 1 to 64 artifact file paths, each at most 4096 characters.");
  // Reject the outer limit before traversing entries; do not copy nested
  // values just to discover that they are not strings, or invoke getters.
  if (types.isProxy(input) || !Array.isArray(input) || !input.length || input.length > MAX_BATCH_FILES) throw invalid();
  if (Reflect.ownKeys(input).length !== input.length + 1) throw invalid();
  const paths = [];
  for (let i = 0; i < input.length; i++) {
    const field = Object.getOwnPropertyDescriptor(input, i);
    if (!field || !("value" in field) || typeof field.value !== "string" || !field.value.length || field.value.length > 4096) throw invalid();
    paths.push(field.value);
  }
  return paths;
}

function batchResult(results) {
  const passed = results.filter((result) => result.valid).length;
  const failure_counts = {};
  for (const row of results) {
    if (!row.valid) failure_counts[row.code] = (failure_counts[row.code] ?? 0) + 1;
  }
  return { valid: passed === results.length, file_count: results.length, passed, failed: results.length - passed,
    failure_counts, results };
}

/** Independent drill replay results, with one caller-supplied verification instant. */
export function verifyRecoveryFiles(paths, options = {}) {
  const files = validatePaths(paths);
  // One bad instant is an operator error, not a failure of every drill.
  if (options.requireCurrent) assertVerificationTime(options.now);
  const results = files.map(file => {
    try {
      const result = reviewRecovery(readArtifactFile(file), options);
      return { file, valid: true, bundle_digest: result.bundle_digest, qualification: result.qualification,
        action_digest: result.action_digest, action_class: result.action_class, recovery_class: result.recovery_class,
        coverage_digest: result.coverage_digest, attestation_digest: result.attestation_digest,
        freshness_checked: result.freshness_checked, current: result.current, expires_at: result.expires_at };
    } catch (error) {
      return { file, valid: false, code: error instanceof RailError ? error.code : "VERIFICATION_FAILED" };
    }
  });
  const byAction = new Map(), byBundle = new Map();
  for (const result of results.filter(item => item.valid)) {
    for (const [groups, key] of [[byAction, result.action_digest], [byBundle, result.bundle_digest]]) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(result);
    }
  }
  const differing_drills = [...byAction].filter(([, rows]) => new Set(rows.map(row => row.attestation_digest)).size > 1)
    .map(([action_digest, rows]) => ({ action_digest, files: rows.map(row => row.file),
      attestation_digests: [...new Set(rows.map(row => row.attestation_digest))] }));
  const duplicates = [...byBundle].filter(([, rows]) => rows.length > 1)
    .map(([bundle_digest, rows]) => ({ bundle_digest, files: rows.map(row => row.file) }));
  const verified = results.filter(item => item.valid);
  const qualification_counts = Object.fromEntries([...new Set(verified.map(row => row.qualification))]
    .sort().map(value => [value, verified.filter(row => row.qualification === value).length]));
  return { ...batchResult(results), qualification_is_not_admission: true, duplicates, differing_drills,
    qualification_counts, unique_bundle_count: byBundle.size,
    freshness_checked_count: verified.filter(row => row.freshness_checked).length,
    freshness_unchecked_count: verified.filter(row => !row.freshness_checked).length,
    review_required: differing_drills.length > 0,
    collection_limitation: "Different signed drills for one action require review; no drill is selected as current or authoritative." };
}
