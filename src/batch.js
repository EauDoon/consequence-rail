import { readArtifactFile } from "./artifact-files.js";
import { verifyBundle } from "./verify.js";
import { RailError } from "./errors.js";

export const MAX_BATCH_FILES = 64;

/** Independent strict audit verification. A bad file cannot hide other results. */
export function verifyArtifactFiles(paths, options = {}) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_BATCH_FILES ||
      paths.some((path) => typeof path !== "string" || path.length === 0 || path.length > 4096)) {
    throw new RailError("BATCH_INVALID", "Supply 1 to 64 artifact file paths, each at most 4096 characters.");
  }
  const results = paths.map((file) => {
    try {
      const result = verifyBundle(readArtifactFile(file), { ...options, requireSemantics: true });
      return { file, valid: true, action_id: result.action_id, outcome: result.outcome, semantics: result.semantics.status };
    } catch (error) {
      return { file, valid: false, code: error instanceof RailError ? error.code : "VERIFICATION_FAILED" };
    }
  });
  const passed = results.filter((result) => result.valid).length;
  return { valid: passed === results.length, file_count: results.length, passed, failed: results.length - passed, results };
}
