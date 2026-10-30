#!/usr/bin/env node

import { DEMO_FAULTS, runIrreversibleDemo, runRefundDemo } from "../src/demo.js";
import {
  INVENTORY_DEMO_FAULTS,
  runInventoryDemo,
} from "../src/inventory-demo.js";
import { ASSURANCE_MODES } from "../src/rail.js";
import { RailError } from "../src/errors.js";
import {
  RECOVERY_DEMO_FAULTS,
  runRecoveryPreflightDemo,
} from "../src/recovery-demo.js";
import { verifyRecoveryPreflight } from "../src/recovery-preflight.js";
import {
  demoConnectorTrustedKeys,
  demoRecoveryTrustedKeys,
  demoTrustedKeys,
} from "../src/signing.js";
import { parseChainCheckpoint, verifyBundleTimeline, verifyChainCheckpoint, verifySettlementArtifact } from "../src/verify.js";

import { assertArtifactDigest, readArtifactFile, serializeArtifact, writeExclusiveArtifactText as writeExclusiveText } from "../src/artifact-files.js";
import { compareBundles, reviewBundle, receiptBundle, evidenceInventory, lifecycleTiming } from "../src/review.js";
import { verifyArtifactFiles, verifyRecoveryFiles } from "../src/batch.js";
import { scenarioCatalog } from "../src/scenarios.js";
import { runScenarioMatrix } from "../src/scenario-matrix.js";
import { digest } from "../src/canonical.js";
import { reviewRecovery, compareRecovery, linkRecovery } from "../src/recovery-review.js";
import { settlementMarkdown, recoveryMarkdown } from "../src/review-markdown.js";
import { parseCliArgs, usage } from "../src/cli-args.js";
import { demoTrustConfig, loadTrustedKeysFile } from "../src/trust-config.js";
import { VERSION } from "../src/version.js";

function assertFlags(options, allowed) {
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) {
      throw usage(`Flag --${name} is not valid for this command.`);
    }
  }
}

function printHelp() {
  process.stdout.write(`Consequence Rail CLI ${VERSION}

Usage:
  crctl demo list [--json]
  crctl demo matrix [all|refund|inventory|recovery-preflight|irreversible] [--json]
  crctl demo inventory [--fault <name>] [--assurance <mode>] [--json] [--out <file>]
  crctl demo refund [--fault <name>] [--assurance <mode>] [--json] [--out <file>]
  crctl demo irreversible [--json]
  crctl demo recovery-preflight [--fault <name>] [--json] [--out <file>]
  crctl bundle verify <file> [--expect-digest <digest>] [--expect-checkpoint <count>:<head>]
                       [--allow-receipt-profile] [--json]
  crctl bundle verify-many <file>... [--allow-receipt-profile] [--json]
  crctl bundle timeline <file> [--expect-checkpoint <count>:<head>] [--json]
  crctl bundle review <file> [--expect-checkpoint <count>:<head>] [--json|--markdown] [--out <new-report>]
  crctl bundle receipt <file> --out <new-file> [--expect-checkpoint <count>:<head>] [--json]
  crctl bundle evidence <file> [--expect-checkpoint <count>:<head>] [--json]
  crctl bundle timing <audit-file> [--expect-checkpoint <count>:<head>] [--json]
  crctl bundle compare <left> <right> [--json]
  crctl recovery-preflight verify <file> [--at <ISO timestamp>] [--expect-digest <digest>] [--json]
  crctl recovery-preflight review <file> [--at <ISO timestamp>] [--json|--markdown] [--out <new-report>]
  crctl recovery-preflight compare <left> <right> [--at <ISO timestamp>] [--json]
  crctl recovery-preflight link <settlement> <drill> [--at <ISO timestamp>] [--json]
  crctl recovery-preflight verify-many <file>... [--at <ISO timestamp>] [--json]
  crctl trust demo [--out <new-file>]
  crctl --help
  crctl --version

Refund demo faults:
  ${DEMO_FAULTS.join(", ")}

Inventory demo faults:
  ${INVENTORY_DEMO_FAULTS.join(", ")}

Recovery-preflight demo faults:
  ${RECOVERY_DEMO_FAULTS.join(", ")}

Assurance modes:
  ${ASSURANCE_MODES.join(", ")} (refund and inventory demo default: enforced)

Flags:
  --fault <name>        Synthetic fault to inject
  --assurance <mode>    Assurance mode for the refund and inventory demos
  --json                Print machine-readable JSON
  --markdown            Print a readable settlement or recovery review
  --out <file>          Write a demo bundle, receipt projection, review report or trust file
                        (must not exist)
  --at <ISO timestamp>  Require recovery qualification to be current at this instant
  --expect-digest <digest> Require the recorded canonical artifact digest
  --expect-other-digest <digest> Pin the second input of compare or link
  --require-outcome <outcome> Require settled, compensated or disputed (bundle verify/verify-many)
  --allow-receipt-profile Let bundle verify and verify-many accept receipt-profile bundles
                        with integrity-only verification (audit bundles still get full
                        lifecycle semantics)
  --require-qualified   Require QUALIFIED_EXACT (recovery verify/verify-many; add --at for freshness)
  --trusted-keys <file> Trust only the keys in this trusted-keys file (every bundle and
                        recovery-preflight command)
  --expect-checkpoint <count>:<head> Require the bundle's event chain to extend a
                        checkpoint recorded during the lifecycle (bundle verify, timeline,
                        review, receipt, evidence and timing)
  -h, --help            Show this help
  --version             Print the implementation version

  Every value flag also accepts the --name=value form, for example
  --expect-digest=<digest>. A digest pin may begin with a dash.

Trust:
  Without --trusted-keys, bundle and recovery-preflight commands trust only the
  public demonstration keys. With it, they trust only the keys the file lists
  for each role (rail, connector, recovery), and report trust_profile
  caller_supplied_keys with the file's trust_config_digest. The file format is
  consequence-rail/trusted-keys/v0.1. crctl trust demo prints the demonstration
  keys in that format, as a template.

Receipt profiles:
  bundle verify and verify-many demand the audit profile and refuse a receipt
  with SEMANTIC_INVALID. --allow-receipt-profile accepts receipts with
  integrity-only verification (signatures, chain, and the outcome, close-time
  and action-type bindings) and adds profile, verification_scope and
  limitations to the result. --require-outcome applies to both profiles.

Checkpoints:
  Every lifecycle response and GET /v0/actions/{id} returns event_count and
  event_chain_head. Record them as <event_count>:<event_chain_head> somewhere
  the rail operator does not control. --expect-checkpoint then fails with
  CHECKPOINT_MISMATCH unless event number <event_count> of the bundle has that
  hash, so a history rewritten and re-signed after the checkpoint is refused.

Examples:
  All single-artifact review, evidence, timing, timeline and receipt commands
  accept --expect-digest. Compare and link accept both digest pin flags.
  node ./cmd/crctl.js demo refund
  node ./cmd/crctl.js demo refund --fault duplicate
  node ./cmd/crctl.js demo refund --fault lost-response-after-commit
  node ./cmd/crctl.js demo irreversible
  node ./cmd/crctl.js demo recovery-preflight
`);
}

function printRefund(summary, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  const lines = [
    `scenario: ${summary.scenario}`,
    `fault: ${summary.fault}`,
    `action: ${summary.action_id}`,
    `assurance: ${summary.assurance_mode}`,
    `state: ${summary.state}`,
    `outcome: ${summary.outcome ?? "none"}`,
    `execution_calls: ${summary.execute_calls}`,
    `status_calls: ${summary.status_calls}`,
    `remedy_calls: ${summary.remedy_calls}`,
    ...(summary.scenario === "synthetic-inventory-allocation"
      ? [
          `active_allocations: ${summary.active_allocations}`,
          `allocated_quantity: ${summary.allocated_quantity}`,
          `inventory_on_hand: ${summary.inventory_on_hand}`,
        ]
      : [`active_refunds: ${summary.active_refunds}`]),
    `bundle_verification: ${summary.bundle_verification}`,
  ];
  if (summary.expected_rejection) {
    lines.push(`expected_rejection: ${summary.expected_rejection.code}`);
  }
  if (summary.tamper_detection) {
    lines.push(`tamper_detection: ${summary.tamper_detection.detected ? "pass" : "fail"}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

function printRecoveryPreflight(summary, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `scenario: ${summary.scenario}`,
      `fault: ${summary.fault}`,
      `fixture_fidelity: ${summary.fixture_fidelity}`,
      `recovery_class: ${summary.recovery_class}`,
      `qualification: ${summary.qualification}`,
      `bundle_verification: ${summary.bundle_verification}`,
      `permit_without_preflight: ${summary.permit_without_preflight}`,
      `permit_after_preflight: ${summary.permit_after_preflight}`,
      `live_connector_execute_calls: ${summary.live_connector_execute_calls}`,
      `live_connector_remedy_calls: ${summary.live_connector_remedy_calls}`,
      `production_recovery_claimed: ${summary.production_recovery_claimed}`,
    ].join("\n") + "\n",
  );
}

function writeExclusiveJson(path, value) {
  writeExclusiveText(path, serializeArtifact(value));
}

function printReport(text, path) {
  if (path !== undefined) writeExclusiveText(path, text);
  process.stdout.write(text);
}

function readPinnedArtifact(path, expected) {
  const bundle = readArtifactFile(path);
  if (expected !== undefined) assertArtifactDigest(bundle, expected);
  return bundle;
}

// Without --trusted-keys every command trusts the public demonstration keys,
// exactly as before. With it, only the listed keys are trusted, and the file
// is loaded and validated before any artifact is read.
function loadTrust(options) {
  if (options["trusted-keys"] === undefined) {
    return {
      supplied: false,
      rail: demoTrustedKeys(),
      connector: demoConnectorTrustedKeys(),
      recovery: demoRecoveryTrustedKeys(),
      profile: { trust_profile: "public_demo_keys_only" },
    };
  }
  const config = loadTrustedKeysFile(options["trusted-keys"]);
  return {
    supplied: true,
    rail: config.rail,
    connector: config.connector,
    recovery: config.recovery,
    profile: { trust_profile: "caller_supplied_keys", trust_config_digest: config.trust_config_digest },
  };
}

function settlementTrust(trust) {
  return { trustedKeys: trust.rail, trustedConnectorKeys: trust.connector };
}

// Outputs that never reported a trust profile gain one only under the flag.
function suppliedProfile(trust) {
  return trust.supplied ? trust.profile : {};
}

function suppliedProfileLines(trust) {
  return trust.supplied
    ? [`trust_profile: ${trust.profile.trust_profile}`, `trust_config_digest: ${trust.profile.trust_config_digest}`]
    : [];
}

// Checked after the command's own verification, so its errors keep priority,
// and before any output is written.
function checkCheckpoint(bundle, checkpoint, trust) {
  return checkpoint === undefined ? undefined : verifyChainCheckpoint(bundle, checkpoint, settlementTrust(trust));
}

function checkpointFields(checked) {
  return checked === undefined ? {} : { checkpoint: checked };
}

function checkpointLines(checked) {
  return checked === undefined ? [] : [
    `checkpoint: ${checked.event_count}:${checked.event_chain_head} extended by ${checked.events_after_checkpoint} later events`,
  ];
}

function requireNoExtra(positional, count, command) {
  if (positional.length > count) {
    throw usage(`Unexpected extra argument for ${command}.`);
  }
}

function applyOutcomeExpectation(result, expected) {
  if (expected === undefined) return;
  result.expected_outcome = expected;
  result.outcome_expectation_met = (result.results ?? [result]).every(row => row.valid && row.outcome === expected);
  if (!result.outcome_expectation_met) process.exitCode = 1;
}

function applyQualificationExpectation(result, required) {
  if (!required) return;
  result.expected_qualification = "QUALIFIED_EXACT";
  result.qualification_expectation_met = (result.results ?? [result]).every(row => row.valid && row.qualification === "QUALIFIED_EXACT");
  if (!result.qualification_expectation_met) process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  // Arguments after "--" are positional. A file named --help, -h or
  // --version must be read, not answered with help and exit status 0.
  const end = args.indexOf("--");
  const flags = end === -1 ? args : args.slice(0, end);
  if (args.length === 0 || flags.includes("--help") || flags.includes("-h")) {
    printHelp();
    return;
  }
  if (flags.includes("--version")) {
    process.stdout.write(`consequence-rail ${VERSION}\n`);
    return;
  }

  const { positional, options } = parseCliArgs(args);
  if (options.at !== undefined) {
    const at = Date.parse(options.at);
    if (!Number.isFinite(at) || new Date(at).toISOString() !== options.at) {
      throw usage("--at must be an exact ISO UTC timestamp, for example 2035-01-01T00:00:00.000Z.");
    }
  }
  if (options["require-outcome"] !== undefined && !["settled", "compensated", "disputed"].includes(options["require-outcome"])) {
    throw usage("Expected outcome must be settled, compensated or disputed.");
  }
  if (options.json && options.markdown) throw usage("Choose --json or --markdown, not both.");
  let checkpoint;
  if (options["expect-checkpoint"] !== undefined) {
    try {
      checkpoint = parseChainCheckpoint(options["expect-checkpoint"]);
    } catch {
      throw usage("--expect-checkpoint must be <event_count>:<event_chain_head>, a positive count without leading zeros and an unpadded 43-character SHA-256 base64url digest.");
    }
  }
  const [command, subcommand, target] = positional;

  if (command === "demo") {
    if (subcommand === "matrix") {
      requireNoExtra(positional, 3, "demo matrix");
      assertFlags(options, new Set(["json"]));
      const result = await runScenarioMatrix(target ?? "all");
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.valid) process.exitCode = 1;
      return;
    }
    if (subcommand === "list") {
      requireNoExtra(positional, 2, "demo list");
      assertFlags(options, new Set(["json"]));
      process.stdout.write(`${JSON.stringify(scenarioCatalog(), null, 2)}\n`);
      return;
    }
    if (!subcommand) {
      throw usage("Missing demo scenario. Expected refund, inventory, irreversible, recovery-preflight, list, or matrix.");
    }
    if (subcommand === "refund") {
      requireNoExtra(positional, 2, "demo refund");
      assertFlags(options, new Set(["fault", "assurance", "json", "out"]));
      const fault = options.fault ?? "none";
      const assuranceMode = options.assurance ?? "enforced";
      if (!DEMO_FAULTS.includes(fault)) {
        throw usage(
          `Unknown refund demo fault '${fault}'. Expected one of: ${DEMO_FAULTS.join(", ")}.`,
        );
      }
      if (!ASSURANCE_MODES.includes(assuranceMode)) {
        throw usage(
          `Unknown assurance mode '${assuranceMode}'. Expected one of: ${ASSURANCE_MODES.join(", ")}.`,
        );
      }
      const result = await runRefundDemo({ fault, assuranceMode });
      if (options.out) {
        if (!result.bundle) {
          throw new RailError("RECEIPT_NOT_AVAILABLE", "This scenario did not produce a settlement bundle.");
        }
        writeExclusiveJson(options.out, result.bundle);
      }
      printRefund(result.summary, Boolean(options.json));
      return;
    }
    if (subcommand === "inventory") {
      requireNoExtra(positional, 2, "demo inventory");
      assertFlags(options, new Set(["fault", "assurance", "json", "out"]));
      const fault = options.fault ?? "none";
      const assuranceMode = options.assurance ?? "enforced";
      if (!INVENTORY_DEMO_FAULTS.includes(fault)) {
        throw usage(
          `Unknown inventory demo fault '${fault}'. Expected one of: ${INVENTORY_DEMO_FAULTS.join(", ")}.`,
        );
      }
      if (!ASSURANCE_MODES.includes(assuranceMode)) {
        throw usage(
          `Unknown assurance mode '${assuranceMode}'. Expected one of: ${ASSURANCE_MODES.join(", ")}.`,
        );
      }
      const result = await runInventoryDemo({ fault, assuranceMode });
      if (options.out) {
        if (!result.bundle) {
          throw new RailError("RECEIPT_NOT_AVAILABLE", "This scenario did not produce a settlement bundle.");
        }
        writeExclusiveJson(options.out, result.bundle);
      }
      printRefund(result.summary, Boolean(options.json));
      return;
    }
    if (subcommand === "irreversible") {
      requireNoExtra(positional, 2, "demo irreversible");
      assertFlags(options, new Set(["json"]));
      const result = runIrreversibleDemo();
      if (options.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        process.stdout.write(
          [
            `scenario: ${result.scenario}`,
            `admitted: ${result.admitted}`,
            `decision: ${result.code}`,
            `reason: ${result.reason}`,
            `detail: ${result.detail ?? "none"}`,
          ].join("\n") + "\n",
        );
      }
      return;
    }
    if (subcommand === "recovery-preflight") {
      requireNoExtra(positional, 2, "demo recovery-preflight");
      assertFlags(options, new Set(["fault", "json", "out"]));
      const fault = options.fault ?? "none";
      if (!RECOVERY_DEMO_FAULTS.includes(fault)) {
        throw usage(
          `Unknown recovery-preflight demo fault '${fault}'. Expected one of: ${RECOVERY_DEMO_FAULTS.join(", ")}.`,
        );
      }
      const result = await runRecoveryPreflightDemo({ fault });
      if (options.out) {
        writeExclusiveJson(options.out, result.bundle);
      }
      printRecoveryPreflight(result.summary, Boolean(options.json));
      return;
    }
    throw usage(
      `Unknown demo scenario '${subcommand}'. Expected refund, inventory, irreversible, or recovery-preflight.`,
    );
  }

  if (command === "bundle") {
    if (subcommand === "receipt") {
      requireNoExtra(positional, 3, "bundle receipt");
      assertFlags(options, new Set(["json", "out", "expect-digest", "trusted-keys", "expect-checkpoint"]));
      if (!target || !options.out) throw usage("Receipt export requires input and --out.");
      const trust = loadTrust(options);
      const input = readPinnedArtifact(target, options["expect-digest"]);
      const bundle = receiptBundle(input, settlementTrust(trust));
      const checked = checkCheckpoint(input, checkpoint, trust);
      writeExclusiveJson(options.out, bundle);
      process.stdout.write(`${JSON.stringify({ valid: true, profile: "receipt", bundle_digest: digest(bundle), ...trust.profile, ...checkpointFields(checked), semantics: "not_checked_in_exported_profile" }, null, 2)}\n`);
      return;
    }
    if (subcommand === "verify-many") {
      assertFlags(options, new Set(["json", "require-outcome", "trusted-keys", "allow-receipt-profile"]));
      const trust = loadTrust(options);
      const result = verifyArtifactFiles(positional.slice(2), {
        ...settlementTrust(trust),
        allowReceiptProfile: options["allow-receipt-profile"] === true,
      });
      applyOutcomeExpectation(result, options["require-outcome"]);
      process.stdout.write(`${JSON.stringify({ ...result, ...trust.profile }, null, 2)}\n`);
      if (!result.valid || result.review_required) process.exitCode = 1;
      return;
    }
    if (subcommand === "compare") {
      requireNoExtra(positional, 4, "bundle compare");
      assertFlags(options, new Set(["json", "expect-digest", "expect-other-digest", "trusted-keys"]));
      if (!target || !positional[3]) throw usage("Bundle comparison requires two files.");
      const trust = loadTrust(options);
      const result = compareBundles(readPinnedArtifact(target, options["expect-digest"]), readPinnedArtifact(positional[3], options["expect-other-digest"]), settlementTrust(trust));
      process.stdout.write(`${JSON.stringify({ ...result, ...trust.profile }, null, 2)}\n`);
      return;
    }
    if (!["verify", "timeline", "review", "evidence", "timing"].includes(subcommand)) {
      throw usage("Missing or unknown bundle command. Expected verify, verify-many, timeline, review, receipt, evidence, timing, or compare.");
    }
    if (!target) {
      throw usage(`Missing bundle file. Usage: crctl bundle ${subcommand} <file> [--json].`);
    }
    requireNoExtra(positional, 3, `bundle ${subcommand}`);
    assertFlags(options, new Set(subcommand === "review" ? ["json", "markdown", "expect-digest", "out", "trusted-keys", "expect-checkpoint"] :
      subcommand === "verify" ? ["json", "expect-digest", "require-outcome", "trusted-keys", "expect-checkpoint", "allow-receipt-profile"] : ["json", "expect-digest", "trusted-keys", "expect-checkpoint"]));
    const trust = loadTrust(options);
    const bundle = readPinnedArtifact(target, options["expect-digest"]);
    if (subcommand === "review" && options.markdown) {
      // The checkpoint runs the same verification as the review (semantics
      // for audit bundles only), so a defective bundle fails the same way.
      const checked = checkCheckpoint(bundle, checkpoint, trust);
      printReport(settlementMarkdown(bundle, {
        ...settlementTrust(trust),
        ...(trust.supplied ? { trustConfigDigest: trust.profile.trust_config_digest } : {}),
        ...(checked === undefined ? {} : { checkpoint: checked }),
      }), options.out);
      return;
    }
    if (["review", "evidence", "timing"].includes(subcommand)) {
      const report = { review: reviewBundle, evidence: evidenceInventory, timing: lifecycleTiming }[subcommand];
      const result = report(bundle, settlementTrust(trust));
      Object.assign(result, trust.profile, checkpointFields(checkCheckpoint(bundle, checkpoint, trust)));
      printReport(serializeArtifact(result), options.out);
      return;
    }
    if (subcommand === "verify") {
      // Without --allow-receipt-profile this is the strict verifyBundle result.
      const allowReceiptProfile = options["allow-receipt-profile"] === true;
      const result = verifySettlementArtifact(bundle, { ...settlementTrust(trust), allowReceiptProfile });
      result.bundle_digest = digest(bundle);
      const checked = checkCheckpoint(bundle, checkpoint, trust);
      Object.assign(result, suppliedProfile(trust), checkpointFields(checked));
      applyOutcomeExpectation(result, options["require-outcome"]);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        process.stdout.write(
          [
            "bundle_verification: pass",
            `action: ${result.action_id}`,
            `outcome: ${result.outcome}`,
            `assurance: ${result.assurance_mode}`,
            `events: ${result.event_count}`,
            `semantics: ${result.semantics.status}`,
            ...(allowReceiptProfile ? [
              `profile: ${result.profile}`,
              `verification_scope: ${result.verification_scope}`,
              ...(result.limitations ?? []).map((limitation) => `limitation: ${limitation}`),
            ] : []),
            `trusted_key: ${result.trusted_key_id}`,
            ...suppliedProfileLines(trust),
            ...checkpointLines(checked),
            ...(options["require-outcome"] ? [`outcome_expectation_met: ${result.outcome_expectation_met}`] : []),
          ].join("\n") + "\n",
        );
      }
      return;
    }
    const result = verifyBundleTimeline(bundle, settlementTrust(trust));
    const checked = checkCheckpoint(bundle, checkpoint, trust);
    Object.assign(result, suppliedProfile(trust), checkpointFields(checked));
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        [
          "bundle_verification: pass",
          `action: ${result.action_id}`,
          `outcome: ${result.outcome}`,
          `events: ${result.event_count}`,
          `event_chain_head: ${result.event_chain_head}`,
          ...suppliedProfileLines(trust),
          ...checkpointLines(checked),
          "timeline:",
          ...result.events.map((event) =>
            `${event.sequence} ${event.event_type} ${event.recorded_at}` +
            (event.to_state ? ` ${event.from_state}->${event.to_state}` : ""),
          ),
        ].join("\n") + "\n",
      );
    }
    return;
  }

  if (command === "recovery-preflight") {
    if (subcommand === "verify-many") {
      assertFlags(options, new Set(["json", "at", "require-qualified", "trusted-keys"]));
      const trust = loadTrust(options);
      const result = verifyRecoveryFiles(positional.slice(2), {
        trustedKeys: trust.recovery, requireCurrent: options.at !== undefined, now: options.at ?? null,
      });
      applyQualificationExpectation(result, options["require-qualified"]);
      process.stdout.write(`${JSON.stringify({ ...result, ...trust.profile }, null, 2)}\n`);
      if (!result.valid || result.review_required) process.exitCode = 1;
      return;
    }
    if (subcommand === "link") {
      requireNoExtra(positional, 4, "recovery-preflight link");
      assertFlags(options, new Set(["json", "at", "expect-digest", "expect-other-digest", "trusted-keys"]));
      if (!target || !positional[3]) throw usage("Recovery link requires a settlement and drill file.");
      const trust = loadTrust(options);
      const result = linkRecovery(readPinnedArtifact(target, options["expect-digest"]), readPinnedArtifact(positional[3], options["expect-other-digest"]), {
        ...settlementTrust(trust),
        trustedRecoveryKeys: trust.recovery, requireCurrent: options.at !== undefined, now: options.at ?? null,
      });
      process.stdout.write(`${JSON.stringify({ ...result, ...trust.profile }, null, 2)}\n`);
      if (!result.bindings_match) process.exitCode = 1;
      return;
    }
    if (subcommand === "compare") {
      requireNoExtra(positional, 4, "recovery-preflight compare");
      assertFlags(options, new Set(["json", "at", "expect-digest", "expect-other-digest", "trusted-keys"]));
      if (!target || !positional[3]) throw usage("Recovery comparison requires two files.");
      const trust = loadTrust(options);
      const result = compareRecovery(readPinnedArtifact(target, options["expect-digest"]), readPinnedArtifact(positional[3], options["expect-other-digest"]), {
        trustedKeys: trust.recovery, requireCurrent: options.at !== undefined, now: options.at ?? null,
      });
      process.stdout.write(`${JSON.stringify({ ...result, ...trust.profile }, null, 2)}\n`);
      return;
    }
    if (!["verify", "review"].includes(subcommand)) {
      throw usage("Missing or unknown recovery-preflight command. Expected verify, verify-many, review, compare, or link.");
    }
    if (!target) {
      throw usage(`Missing recovery-preflight file. Usage: crctl recovery-preflight ${subcommand} <file> [--json].`);
    }
    requireNoExtra(positional, 3, `recovery-preflight ${subcommand}`);
    assertFlags(options, new Set(subcommand === "review" ? ["json", "at", "expect-digest", "markdown", "out", "trusted-keys"] : ["json", "at", "expect-digest", "require-qualified", "trusted-keys"]));
    const trust = loadTrust(options);
    const bundle = readPinnedArtifact(target, options["expect-digest"]);
    if (subcommand === "review" && options.markdown) {
      printReport(recoveryMarkdown(bundle, {
        trustedKeys: trust.recovery, requireCurrent: options.at !== undefined, now: options.at ?? null,
        ...(trust.supplied ? { trustConfigDigest: trust.profile.trust_config_digest } : {}),
      }), options.out);
      return;
    }
    const result = (subcommand === "review" ? reviewRecovery : verifyRecoveryPreflight)(bundle, {
      trustedKeys: trust.recovery,
      requireCurrent: options.at !== undefined,
      now: options.at ?? null,
    });
    result.bundle_digest = digest(bundle);
    Object.assign(result, suppliedProfile(trust));
    applyQualificationExpectation(result, options["require-qualified"]);
    if (options.json || subcommand === "review") {
      printReport(serializeArtifact(result), options.out);
    } else {
      process.stdout.write(
        [
          "recovery_preflight_verification: pass",
          `qualification: ${result.qualification}`,
          `freshness: ${result.freshness_checked ? "current" : "not_checked"}`,
          `attestation: ${result.attestation_digest}`,
          `trusted_key: ${result.trusted_key_id}`,
          ...suppliedProfileLines(trust),
          ...(options["require-qualified"] ? [`qualification_expectation_met: ${result.qualification_expectation_met}`] : []),
        ].join("\n") + "\n",
      );
    }
    return;
  }

  if (command === "trust") {
    if (subcommand !== "demo") {
      throw usage("Missing or unknown trust command. Expected demo.");
    }
    requireNoExtra(positional, 2, "trust demo");
    assertFlags(options, new Set(["json", "out"]));
    printReport(serializeArtifact(demoTrustConfig()), options.out);
    return;
  }

  throw usage(
    command
      ? `Unknown command '${command}'.`
      : "Missing command.",
  );
}

main().catch((error) => {
  const output =
    error instanceof RailError
      ? error.toJSON()
      : {
          code: "INTERNAL_ERROR",
          message: error.message,
        };
  process.stderr.write(`${JSON.stringify(output)}\n`);
  process.exitCode = 1;
});
