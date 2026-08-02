#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runIrreversibleDemo, runRefundDemo } from "../src/demo.js";
import { RailError } from "../src/errors.js";
import { runRecoveryPreflightDemo } from "../src/recovery-demo.js";
import { verifyRecoveryPreflight } from "../src/recovery-preflight.js";
import {
  demoConnectorTrustedKeys,
  demoRecoveryTrustedKeys,
  demoTrustedKeys,
} from "../src/signing.js";
import { verifyBundle, verifyBundleTimeline } from "../src/verify.js";

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function has(args, name) {
  return args.includes(name);
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

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || has(args, "--help") || has(args, "-h")) {
    printHelp();
    return;
  }

  if (args[0] === "demo" && args[1] === "refund") {
    const fault = option(args, "--fault", "none");
    const assuranceMode = option(args, "--assurance", "enforced");
    const result = await runRefundDemo({ fault, assuranceMode });
    const outputPath = option(args, "--out");
    if (outputPath) {
      if (!result.bundle) {
        throw new RailError("RECEIPT_NOT_AVAILABLE", "This scenario did not produce a settlement bundle.");
      }
      writeFileSync(resolve(outputPath), `${JSON.stringify(result.bundle, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    }
    printRefund(result.summary, has(args, "--json"));
    return;
  }

  if (args[0] === "demo" && args[1] === "irreversible") {
    const result = runIrreversibleDemo();
    if (has(args, "--json")) {
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

  if (args[0] === "demo" && args[1] === "recovery-preflight") {
    const result = await runRecoveryPreflightDemo({
      fault: option(args, "--fault", "none"),
    });
    const outputPath = option(args, "--out");
    if (outputPath) {
      writeFileSync(resolve(outputPath), `${JSON.stringify(result.bundle, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    }
    printRecoveryPreflight(result.summary, has(args, "--json"));
    return;
  }

  if (args[0] === "bundle" && args[1] === "verify" && args[2]) {
    const bundle = JSON.parse(readFileSync(resolve(args[2]), "utf8"));
    const result = verifyBundle(bundle, {
      trustedKeys: demoTrustedKeys(),
      trustedConnectorKeys: demoConnectorTrustedKeys(),
      requireSemantics: true,
    });
    if (has(args, "--json")) {
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

  if (args[0] === "bundle" && args[1] === "timeline" && args[2]) {
    const bundle = JSON.parse(readFileSync(resolve(args[2]), "utf8"));
    const result = verifyBundleTimeline(bundle, {
      trustedKeys: demoTrustedKeys(),
      trustedConnectorKeys: demoConnectorTrustedKeys(),
    });
    if (has(args, "--json")) {
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

  if (
    args[0] === "recovery-preflight" &&
    args[1] === "verify" &&
    args[2]
  ) {
    const bundle = JSON.parse(readFileSync(resolve(args[2]), "utf8"));
    const result = verifyRecoveryPreflight(bundle, {
      trustedKeys: demoRecoveryTrustedKeys(),
    });
    if (has(args, "--json")) {
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

  throw new RailError("USAGE_INVALID", "Unknown command. Run with --help.");
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
