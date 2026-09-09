import { readArtifactFile } from "./artifact-files.js";
import { verifyBundle } from "./verify.js";
import { RailError } from "./errors.js";
import { deepClone } from "./canonical.js";
import { reviewRecovery } from "./recovery-review.js";

export const MAX_BATCH_FILES = 64;

/** Independent strict audit verification. A bad file cannot hide other results. */
export function verifyArtifactFiles(paths, options = {}) {
  paths = validatePaths(paths);
  const results = paths.map((file) => {
    try {
      const result = verifyBundle(readArtifactFile(file), { ...options, requireSemantics: true });
      return { file, valid: true, action_id: result.action_id, outcome: result.outcome, semantics: result.semantics.status };
    } catch (error) {
      return { file, valid: false, code: error instanceof RailError ? error.code : "VERIFICATION_FAILED" };
    }
  });
  return batchResult(results);
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
