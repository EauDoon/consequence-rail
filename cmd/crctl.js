#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEMO_FAULTS, runIrreversibleDemo, runRefundDemo } from "../src/demo.js";
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

const VALUE_FLAGS = {
  "--fault": "fault",
  "--assurance": "assurance",
  "--out": "out",
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
  crctl demo refund [--fault <name>] [--assurance <mode>] [--json] [--out <file>]
  crctl demo irreversible [--json]
  crctl demo recovery-preflight [--fault <name>] [--json] [--out <file>]
  crctl bundle verify <file> [--json]
  crctl bundle timeline <file> [--json]
  crctl recovery-preflight verify <file> [--json]
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
    `active_refunds: ${summary.active_refunds}`,
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

function readJsonFile(path) {
  let text;
  try {
    text = readFileSync(resolve(path), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw usage(`File not found: ${path}.`);
    }
    throw usage(`Could not read file: ${path}.`);
  }
  if (text.trim() === "") {
    throw usage(`File is empty: ${path}.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw usage(`File is not valid JSON: ${path}.`);
  }
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
    if (!subcommand) {
      throw usage("Missing demo scenario. Expected refund, irreversible, or recovery-preflight.");
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
      `Unknown demo scenario '${subcommand}'. Expected refund, irreversible, or recovery-preflight.`,
    );
  }

  if (command === "bundle") {
    if (subcommand !== "verify" && subcommand !== "timeline") {
      throw usage("Missing or unknown bundle command. Expected verify or timeline, plus a file.");
    }
    if (!target) {
      throw usage(`Missing bundle file. Usage: crctl bundle ${subcommand} <file> [--json].`);
    }
    requireNoExtra(positional, 3, `bundle ${subcommand}`);
    assertFlags(options, new Set(["json"]));
    const bundle = readJsonFile(target);
    if (subcommand === "verify") {
      const result = verifyBundle(bundle, {
        trustedKeys: demoTrustedKeys(),
        trustedConnectorKeys: demoConnectorTrustedKeys(),
        requireSemantics: true,
      });
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
    if (subcommand !== "verify") {
      throw usage("Missing or unknown recovery-preflight command. Expected verify, plus a file.");
    }
    if (!target) {
      throw usage("Missing recovery-preflight file. Usage: crctl recovery-preflight verify <file> [--json].");
    }
    requireNoExtra(positional, 3, "recovery-preflight verify");
    assertFlags(options, new Set(["json"]));
    const bundle = readJsonFile(target);
    const result = verifyRecoveryPreflight(bundle, {
      trustedKeys: demoRecoveryTrustedKeys(),
    });
    if (options.json) {
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
