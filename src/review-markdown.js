import { reviewBundle } from "./review.js";
import { reviewRecovery } from "./recovery-review.js";

// Encode punctuation and control characters so signed strings cannot create
// links, HTML, new rows, headings, terminal escapes or executable Markdown.
function cell(value) {
  return String(value ?? "not checked").replace(/[\u0000-\u001f\u007f-\u009f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .replace(/[&<>\\`|*_#[\](){}.!+\-]/g, char => `&#${char.charCodeAt(0)};`);
}

export function settlementMarkdown(bundle, options = {}) {
  const report = reviewBundle(bundle, options);
  return markdown("Settlement artifact review", report, options,
    ["bundle_digest", "profile", "verification_scope", "action_id", "action_digest", "outcome",
      "assurance_mode", "bypass_possible", "recourse_final_status", "closed_at", "event_count", "evidence_count"],
    ["Recorded state path: " + report.state_path.join(" -> "),
      "Attention reasons: " + (report.attention_reasons.join(", ") || "none recorded")]);
}

export function recoveryMarkdown(bundle, options = {}) {
  const report = reviewRecovery(bundle, options);
  return markdown("Recovery drill review", report, options,
    ["bundle_digest", "action_digest", "qualification", "recovery_class", "fixture_fidelity",
      "drilled_at", "expires_at", "checked_at", "freshness_checked", "remaining_validity_ms"],
    ["Expiry constraints: " + report.validity_window.limiting_constraints.join(", "),
      "Effective validity (ms): " + report.validity_window.valid_for_ms,
      ...Object.entries(report.checks).map(([name, passed]) => name + ": " + (passed ? "pass" : "not satisfied"))]);
}

// The digest is computed locally from a trusted-keys file, never read from the
// artifact, and contains only base64url characters, so a code span is safe.
function trustLine(options) {
  const configDigest = options.trustConfigDigest;
  if (typeof configDigest === "string" && /^[A-Za-z0-9_-]{43}$/.test(configDigest)) {
    return `Verified with caller-supplied keys from a trusted-keys file, trust_config_digest \`${configDigest}\`.`;
  }
  return "Verified with caller-supplied keys. The CLI uses public demonstration keys only.";
}

function markdown(title, report, options, fields, details) {
  return [`# ${title}`, "", trustLine(options), "",
    "| Field | Recorded result |", "| --- | --- |",
    ...fields.map(field => `| ${cell(field)} | ${cell(report[field])} |`), "",
    ...details.map(detail => `- ${cell(detail)}`), "", "## Limits", "",
    ...report.limitations.map(limit => `- ${cell(limit)}`), ""].join("\n");
}
