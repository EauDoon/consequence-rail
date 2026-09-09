import { readArtifactFile } from "./artifact-files.js";
import { verifyBundle } from "./verify.js";
import { RailError } from "./errors.js";
import { deepClone, digest } from "./canonical.js";
import { reviewRecovery } from "./recovery-review.js";

export const MAX_BATCH_FILES = 64;

/** Independent strict audit verification. A bad file cannot hide other results. */
export function verifyArtifactFiles(paths, options = {}) {
  paths = validatePaths(paths);
  const results = paths.map((file) => {
    try {
      const bundle = readArtifactFile(file);
      const result = verifyBundle(bundle, { ...options, requireSemantics: true });
      return { file, valid: true, action_id: result.action_id, action_digest: bundle.action.action_digest,
        bundle_digest: digest(bundle), receipt_digest: digest(bundle.settlement_receipt),
        outcome: result.outcome, semantics: result.semantics.status };
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
  return { ...batchResult(results), duplicates, differing_receipts, review_required: differing_receipts.length > 0,
    collection_limitation: "Different receipts for one action require review; this report cannot choose the authoritative settlement." };
}

function validatePaths(input) {
  const paths = deepClone(input);
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_BATCH_FILES ||
      paths.some((path) => typeof path !== "string" || path.length === 0 || path.length > 4096)) {
    throw new RailError("BATCH_INVALID", "Supply 1 to 64 artifact file paths, each at most 4096 characters.");
  }
  return paths;
}

function batchResult(results) {
  const passed = results.filter((result) => result.valid).length;
  return { valid: passed === results.length, file_count: results.length, passed, failed: results.length - passed, results };
}

/** Independent drill replay results, with one caller-supplied verification instant. */
export function verifyRecoveryFiles(paths, options = {}) {
  const results = validatePaths(paths).map(file => {
    try {
      const result = reviewRecovery(readArtifactFile(file), options);
      return { file, valid: true, bundle_digest: result.bundle_digest, qualification: result.qualification,
        freshness_checked: result.freshness_checked, current: result.current, expires_at: result.expires_at };
    } catch (error) {
      return { file, valid: false, code: error instanceof RailError ? error.code : "VERIFICATION_FAILED" };
    }
  });
  return { ...batchResult(results), qualification_is_not_admission: true };
}
