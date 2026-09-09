#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
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
import { verifyBundle, verifyBundleTimeline } from "../src/verify.js";

import { assertArtifactDigest, readArtifactFile } from "../src/artifact-files.js";
import { compareBundles, reviewBundle, receiptBundle, evidenceInventory, lifecycleTiming } from "../src/review.js";
import { verifyArtifactFiles } from "../src/batch.js";
import { scenarioCatalog } from "../src/scenarios.js";
import { runScenarioMatrix } from "../src/scenario-matrix.js";
import { digest } from "../src/canonical.js";
import { reviewRecovery, compareRecovery } from "../src/recovery-review.js";

const VALUE_FLAGS = {
  "--fault": "fault",
  "--assurance": "assurance",
  "--out": "out",
  "--at": "at",
  "--expect-digest": "expect-digest",
};
const BOOL_FLAGS = {
  "--json": "json",
};

function usage(message) {
  return new RailError("USAGE_INVALID", `${message} Run with --help.`);
}

function parseCliArgs(args) {
  const positional = [];
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    const boolName = BOOL_FLAGS[arg];
    if (boolName) {
      if (Object.hasOwn(options, boolName)) {
        throw usage(`Flag ${arg} was supplied more than once.`);
      }
      options[boolName] = true;
      continue;
    }
    const valueName = VALUE_FLAGS[arg];
    if (valueName) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw usage(`${arg} requires a value.`);
      }
      if (Object.hasOwn(options, valueName)) {
        throw usage(`Flag ${arg} was supplied more than once.`);
      }
      options[valueName] = value;
      index += 1;
      continue;
    }
    throw usage(`Unknown flag ${arg}.`);
  }
  return { positional, options };
}

function assertFlags(options, allowed) {
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) {
      throw usage(`Flag --${name} is not valid for this command.`);
    }
  }
}

function printHelp() {
  process.stdout.write(`Consequence Rail CLI

Usage:
  crctl demo list [--json]
  crctl demo matrix [all|refund|inventory|recovery-preflight|irreversible] [--json]
  crctl demo inventory [--fault <name>] [--assurance <mode>] [--json] [--out <file>]
  crctl demo refund [--fault <name>] [--assurance <mode>] [--json] [--out <file>]
  crctl demo irreversible [--json]
  crctl demo recovery-preflight [--fault <name>] [--json] [--out <file>]
  crctl bundle verify <file> [--expect-digest <digest>] [--json]
  crctl bundle verify-many <file>... [--json]
  crctl bundle timeline <file> [--json]
  crctl bundle review <file> [--json]
  crctl bundle receipt <file> --out <new-file> [--json]
  crctl bundle evidence <file> [--json]
  crctl bundle timing <audit-file> [--json]
  crctl bundle compare <left> <right> [--json]
  crctl recovery-preflight verify <file> [--at <ISO timestamp>] [--expect-digest <digest>] [--json]
  crctl recovery-preflight review <file> [--at <ISO timestamp>] [--json]
  crctl recovery-preflight compare <left> <right> [--at <ISO timestamp>] [--json]
  crctl --help

Refund demo faults:
  ${DEMO_FAULTS.join(", ")}

Recovery-preflight demo faults:
  ${RECOVERY_DEMO_FAULTS.join(", ")}

Assurance modes:
  ${ASSURANCE_MODES.join(", ")} (refund demo default: enforced)

Flags:
  --fault <name>        Synthetic fault to inject
  --assurance <mode>    Refund demo assurance mode
  --json                Print machine-readable JSON
  --out <file>          Write the settlement or drill bundle (must not exist)
  --at <ISO timestamp>  Require recovery qualification to be current at this instant
  --expect-digest <digest> Require the recorded canonical artifact digest
  -h, --help            Show this help

Examples:
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
  try {
    writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw usage(`Refusing to overwrite existing file: ${path}.`);
    }
    throw usage(`Could not write file: ${path}.`);
  }
}

function requireNoExtra(positional, count, command) {
  if (positional.length > count) {
    throw usage(`Unexpected extra argument for ${command}.`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const { positional, options } = parseCliArgs(args);
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
      assertFlags(options, new Set(["json", "out"]));
      if (!target || !options.out) throw usage("Receipt export requires input and --out.");
      const bundle = receiptBundle(readArtifactFile(target), {
        trustedKeys: demoTrustedKeys(), trustedConnectorKeys: demoConnectorTrustedKeys(),
      });
      writeExclusiveJson(options.out, bundle);
      process.stdout.write(`${JSON.stringify({ valid: true, profile: "receipt", bundle_digest: digest(bundle), trust_profile: "public_demo_keys_only", semantics: "not_checked_in_exported_profile" }, null, 2)}\n`);
      return;
    }
    if (subcommand === "verify-many") {
      assertFlags(options, new Set(["json"]));
      const result = verifyArtifactFiles(positional.slice(2), {
        trustedKeys: demoTrustedKeys(), trustedConnectorKeys: demoConnectorTrustedKeys(),
      });
      process.stdout.write(`${JSON.stringify({ ...result, trust_profile: "public_demo_keys_only" }, null, 2)}\n`);
      if (!result.valid) process.exitCode = 1;
      return;
    }
    if (subcommand === "compare") {
      requireNoExtra(positional, 4, "bundle compare");
      assertFlags(options, new Set(["json"]));
      if (!target || !positional[3]) throw usage("Bundle comparison requires two files.");
      const result = compareBundles(readArtifactFile(target), readArtifactFile(positional[3]), {
        trustedKeys: demoTrustedKeys(), trustedConnectorKeys: demoConnectorTrustedKeys(),
      });
      process.stdout.write(`${JSON.stringify({ ...result, trust_profile: "public_demo_keys_only" }, null, 2)}\n`);
      return;
    }
    if (!["verify", "timeline", "review", "evidence", "timing"].includes(subcommand)) {
      throw usage("Missing or unknown bundle command. Expected verify, verify-many, timeline, review, or compare.");
    }
    if (!target) {
      throw usage(`Missing bundle file. Usage: crctl bundle ${subcommand} <file> [--json].`);
    }
    requireNoExtra(positional, 3, `bundle ${subcommand}`);
    assertFlags(options, new Set(subcommand === "verify" ? ["json", "expect-digest"] : ["json"]));
    const bundle = readArtifactFile(target);
    if (options["expect-digest"] !== undefined) assertArtifactDigest(bundle, options["expect-digest"]);
    if (["review", "evidence", "timing"].includes(subcommand)) {
      const report = { review: reviewBundle, evidence: evidenceInventory, timing: lifecycleTiming }[subcommand];
      const result = report(bundle, {
        trustedKeys: demoTrustedKeys(), trustedConnectorKeys: demoConnectorTrustedKeys(),
      });
      result.trust_profile = "public_demo_keys_only";
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    if (subcommand === "verify") {
      const result = verifyBundle(bundle, {
        trustedKeys: demoTrustedKeys(),
        trustedConnectorKeys: demoConnectorTrustedKeys(),
        requireSemantics: true,
      });
      result.bundle_digest = digest(bundle);
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
            `trusted_key: ${result.trusted_key_id}`,
          ].join("\n") + "\n",
        );
      }
      return;
    }
    const result = verifyBundleTimeline(bundle, {
      trustedKeys: demoTrustedKeys(),
      trustedConnectorKeys: demoConnectorTrustedKeys(),
    });
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
    if (subcommand === "compare") {
      requireNoExtra(positional, 4, "recovery-preflight compare");
      assertFlags(options, new Set(["json", "at"]));
      if (!target || !positional[3]) throw usage("Recovery comparison requires two files.");
      const result = compareRecovery(readArtifactFile(target), readArtifactFile(positional[3]), {
        trustedKeys: demoRecoveryTrustedKeys(), requireCurrent: options.at !== undefined, now: options.at ?? null,
      });
      process.stdout.write(`${JSON.stringify({ ...result, trust_profile: "public_demo_keys_only" }, null, 2)}\n`);
      return;
    }
    if (!["verify", "review"].includes(subcommand)) {
      throw usage("Missing or unknown recovery-preflight command. Expected verify, plus a file.");
    }
    if (!target) {
      throw usage("Missing recovery-preflight file. Usage: crctl recovery-preflight verify <file> [--json].");
    }
    requireNoExtra(positional, 3, "recovery-preflight verify");
    assertFlags(options, new Set(["json", "at", "expect-digest"]));
    const bundle = readArtifactFile(target);
    if (options["expect-digest"] !== undefined) assertArtifactDigest(bundle, options["expect-digest"]);
    const result = (subcommand === "review" ? reviewRecovery : verifyRecoveryPreflight)(bundle, {
      trustedKeys: demoRecoveryTrustedKeys(),
      requireCurrent: options.at !== undefined,
      now: options.at ?? null,
    });
    result.bundle_digest = digest(bundle);
    if (options.json || subcommand === "review") {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        [
          "recovery_preflight_verification: pass",
          `qualification: ${result.qualification}`,
          `freshness: ${result.freshness_checked ? "current" : "not_checked"}`,
          `attestation: ${result.attestation_digest}`,
          `trusted_key: ${result.trusted_key_id}`,
        ].join("\n") + "\n",
      );
    }
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
