import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readArtifactFile, serializeArtifact } from "../src/artifact-files.js";
import { deepClone, digest } from "../src/canonical.js";
import { buildRefundProposal, buildRefundReservation, createDemoRuntime } from "../src/demo.js";
import { runRecoveryPreflightDemo } from "../src/recovery-demo.js";
import { verifyRecoveryPreflight } from "../src/recovery-preflight.js";
import { demoRecoveryTrustedKeys } from "../src/signing.js";

// The verifier gets trust from local configuration, never bundle.trust_hint.
// These public deterministic keys are demonstration identities only.
const trustedKeys = demoRecoveryTrustedKeys();
const [destination, ...extra] = process.argv.slice(2);
if (!destination || extra.length) throw new Error("Usage: node examples/recovery-evidence.js <new-directory>");
const directory = resolve(destination);
mkdirSync(directory); // Refuse existing destinations, including prior examples.
const write = (name, value) => writeFileSync(join(directory, name), serializeArtifact(value), { flag: "wx" });

const { bundle, summary } = await runRecoveryPreflightDemo();
const failed = await runRecoveryPreflightDemo({ fault: "missing-checkpoint" });
const altered = deepClone(bundle);
altered.trace.oracle_satisfied = false;
write("drill.json", bundle);
write("missing-checkpoint.json", failed.bundle);
write("altered.json", altered);

function prepare({ wrongAction = false, trusted = true } = {}) {
  const runtime = createDemoRuntime({ requireRecoveryPreflight: true });
  runtime.rail.recoveryTrustedKeys = trusted ? trustedKeys : new Map();
  const proposal = buildRefundProposal(runtime.clock);
  if (wrongAction) proposal.target.resource_id = "ord_demo_other";
  const proposed = runtime.rail.propose(proposal);
  runtime.rail.authorize(proposed.action_id, {
    allow: true, policy_id: "recovery-evidence-example/v1", policy_digest: digest({ require_recovery_preflight: true }),
  });
  runtime.rail.reserveRecourse(proposed.action_id, buildRefundReservation(proposed.action_digest, proposal, runtime.clock));
  return { ...runtime, actionId: proposed.action_id };
}

function checkCase({ name, file = "drill.json", at = bundle.drill_attestation.drilled_at,
  expected, wrongAction = false, trusted = true, hiddenMetadata = false }) {
  const runtime = prepare({ wrongAction, trusted });
  runtime.clock.advance(Date.parse(at) - Date.parse(runtime.clock.now()));
  const before = runtime.rail.eventStore.list(runtime.actionId);
  let verification = null;
  let result = "issued";
  try {
    if (file !== null) {
      const evidence = readArtifactFile(join(directory, file));
      // A library-only negative control: JSON files cannot contain hidden fields.
      if (hiddenMetadata) Object.defineProperty(evidence, "local_metadata", { value: true });
      verification = verifyRecoveryPreflight(evidence, {
        trustedKeys: runtime.rail.recoveryTrustedKeys, requireCurrent: true, now: at,
      });
      // Replay validity alone does not admit an action. The Rail checks exact
      // action/recourse coverage, qualification, freshness and live bindings.
      runtime.rail.acceptRecoveryQualification(runtime.actionId, evidence);
    }
    runtime.rail.issuePermit(runtime.actionId);
  } catch (error) {
    if (!error.code) throw error;
    result = error.code;
  }
  assert.equal(result, expected, name);
  const after = runtime.rail.eventStore.list(runtime.actionId);
  if (result !== "issued") {
    assert.deepEqual(after, before, `${name}: refused evidence must not record acceptance`);
    assert.equal(runtime.rail.get(runtime.actionId).recovery_preflight, undefined);
    assert.throws(() => runtime.rail.issuePermit(runtime.actionId), {
      code: Date.parse(at) >= Date.parse(runtime.rail.get(runtime.actionId).proposal.expires_at)
        ? "ACTION_EXPIRED" : "RECOVERY_PREFLIGHT_REQUIRED",
    });
  }
  assert.equal(runtime.connector.executeCalls, 0);
  assert.equal(runtime.connector.remedyCalls, 0);
  return { name, file, checked_at: at, result,
    offline_valid: verification?.valid ?? false,
    freshness_checked: verification?.freshness_checked ?? null,
    qualification: verification?.qualification ?? null,
    acceptance_events_added: after.filter(event => event.event_type === "RECOVERY_PREFLIGHT_ACCEPTED").length,
    live_connector_execute_calls: runtime.connector.executeCalls,
    live_connector_remedy_calls: runtime.connector.remedyCalls };
}

const cases = [
  { name: "current exact recovery", expected: "issued" },
  { name: "stale evidence", at: bundle.drill_attestation.expires_at, expected: "RECOVERY_ATTESTATION_EXPIRED" },
  { name: "future drill", at: "2034-12-31T23:59:59.999Z", expected: "RECOVERY_ATTESTATION_EXPIRED" },
  { name: "missing evidence", file: null, expected: "RECOVERY_PREFLIGHT_REQUIRED" },
  { name: "missing checkpoint", file: "missing-checkpoint.json", expected: "RECOVERY_PREFLIGHT_NOT_QUALIFIED" },
  { name: "altered trace", file: "altered.json", expected: "RECOVERY_BUNDLE_INVALID" },
  { name: "different action", wrongAction: true, expected: "RECOVERY_COVERAGE_MISMATCH" },
  { name: "untrusted signer", trusted: false, expected: "UNTRUSTED_KEY" },
  { name: "non-JSON library input", hiddenMetadata: true, expected: "CANONICALIZATION_FAILED" },
].map(checkCase);

const report = { synthetic_only: true, production_recovery_claimed: false,
  trust_profile: "independently_configured_public_demo_keys",
  bundle_digest: digest(bundle), drill_summary: summary, cases,
  limitations: ["Only a synthetic permit is issued; no action connector is executed.",
    "Public demo keys do not authenticate production identities.",
    "Replay verifies bound declared evidence, not the truth of an external environment.",
    "An explicit verification instant is not a trusted wall clock."] };
write("report.json", report);
process.stdout.write(serializeArtifact(report));
