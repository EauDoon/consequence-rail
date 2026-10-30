// External event-chain checkpoints: parseChainCheckpoint, verifyChainCheckpoint
// and crctl --expect-checkpoint.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deepClone, digest, without } from "../src/canonical.js";
import { ManualClock } from "../src/clock.js";
import { createDemoRuntime, prepareRefund } from "../src/demo.js";
import { MockRefundConnector } from "../src/mock-refund-connector.js";
import { ConsequenceRail } from "../src/rail.js";
import { repoPath, resignEventChain } from "../src/rail-test-helpers.js";
import {
  createDemoSigner,
  createSigner,
  demoConnectorTrustedKeys,
  demoTrustedKeys,
  signArtifact,
} from "../src/signing.js";
import { TRUSTED_KEYS_SCHEMA_VERSION } from "../src/trust-config.js";
import { parseChainCheckpoint, verifyBundle, verifyChainCheckpoint } from "../src/verify.js";

const trust = () => ({ trustedKeys: demoTrustedKeys(), trustedConnectorKeys: demoConnectorTrustedKeys() });
const cli = (args) => spawnSync(process.execPath, [repoPath("cmd", "crctl.js"), ...args], {
  cwd: repoPath(), encoding: "utf8", timeout: 15_000,
});
const stderrJson = (result) => JSON.parse(result.stderr.trim().split(/\r?\n/).at(-1));

// Run a demo refund and record event_count:event_chain_head from the view
// returned by every lifecycle call, as a policy system would.
async function checkpointedRun() {
  const runtime = createDemoRuntime();
  const checkpoints = [];
  for (const method of ["propose", "authorize", "reserveRecourse", "issuePermit", "execute", "verifyOutcome"]) {
    const original = runtime.rail[method].bind(runtime.rail);
    runtime.rail[method] = (...args) => {
      const record = (view) => {
        checkpoints.push(`${view.event_count}:${view.event_chain_head}`);
        return view;
      };
      const result = original(...args);
      return result instanceof Promise ? result.then(record) : record(result);
    };
  }
  const { actionId } = prepareRefund(runtime);
  await runtime.rail.execute(actionId, { fault: "none" });
  await runtime.rail.verifyOutcome(actionId, { fault: "none" });
  return {
    checkpoints,
    audit: runtime.rail.exportBundle(actionId, { profile: "audit" }),
    receipt: runtime.rail.exportBundle(actionId),
  };
}

// Rewrite the AUTHORIZED decision and re-sign the whole history and the
// receipt with the public demo rail key. Plain verification cannot tell.
function forgeHistory(bundle) {
  const forged = deepClone(bundle);
  forged.events[1].payload.details_digest = digest({ forged_policy: "other" });
  forged.events = resignEventChain(forged.events, createDemoSigner(), forged.action.action_id);
  forged.settlement_receipt = signArtifact({
    ...without(forged.settlement_receipt, ["signature"]),
    event_chain_head: forged.events.at(-1).event_hash,
  }, createDemoSigner());
  return forged;
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "cr-checkpoint-"));
}

function writeJson(dir, name, value) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

test("checkpoints recorded from every lifecycle response match the exported audit and receipt bundles", async () => {
  const { checkpoints, audit, receipt } = await checkpointedRun();
  assert.equal(checkpoints.length, 6);
  assert.equal(checkpoints.at(-1), `${audit.events.length}:${audit.events.at(-1).event_hash}`);
  for (const bundle of [audit, receipt]) {
    for (const checkpoint of checkpoints) {
      const result = verifyChainCheckpoint(bundle, checkpoint, trust());
      assert.equal(result.extends, true);
      assert.equal(`${result.event_count}:${result.event_chain_head}`, checkpoint);
      assert.equal(result.events_after_checkpoint, bundle.events.length - result.event_count);
    }
    // Every prefix of the chain is a valid checkpoint, including the head.
    bundle.events.forEach((event, index) => {
      const result = verifyChainCheckpoint(bundle, { event_count: index + 1, event_chain_head: event.event_hash }, trust());
      assert.equal(result.events_after_checkpoint, bundle.events.length - index - 1);
    });
  }
});

test("a rewritten, re-signed history verifies but fails the checkpoint recorded before the rewrite", async () => {
  const { checkpoints, audit } = await checkpointedRun();
  const forged = forgeHistory(audit);
  assert.equal(verifyBundle(forged, trust()).semantics.status, "verified");
  const afterAuthorization = checkpoints[1];
  assert.match(afterAuthorization, /^2:/);
  assert.throws(() => verifyChainCheckpoint(forged, afterAuthorization, trust()), (error) => {
    assert.equal(error.code, "CHECKPOINT_MISMATCH");
    assert.equal(error.details.checkpoint_event_count, 2);
    assert.equal(error.details.bundle_event_count, forged.events.length);
    return true;
  });
  // The proposal event was not rewritten, so the first checkpoint still holds.
  assert.equal(verifyChainCheckpoint(forged, checkpoints[0], trust()).extends, true);
});

test("checkpoint text is strictly parsed", async () => {
  const { audit } = await checkpointedRun();
  const head = audit.events[1].event_hash;
  assert.deepEqual(parseChainCheckpoint(`2:${head}`), { event_count: 2, event_chain_head: head });
  const nonCanonical = `${head.slice(0, 42)}${head.at(-1) === "B" ? "C" : "B"}`;
  for (const bad of [
    `0:${head}`, `02:${head}`, `1.5:${head}`, `+2:${head}`, `-2:${head}`, ` 2:${head}`, `2:${head} `,
    `0x2:${head}`, `2e0:${head}`, `9007199254740993:${head}`, `2:${head}=`, `2:${head.slice(1)}`,
    `2:${head}A`, `2:${nonCanonical}`, `2:${head.replace(/^./, "+")}`, `2;${head}`, `2:`, ":", "", undefined, 2,
  ]) {
    assert.throws(() => parseChainCheckpoint(bad), (error) => error.code === "CHECKPOINT_INVALID", String(bad));
  }
  for (const bad of [null, {}, { event_count: "2", event_chain_head: head }, { event_count: 2.5, event_chain_head: head },
    { event_count: 0, event_chain_head: head }, { event_count: 2, event_chain_head: 7 }]) {
    assert.throws(() => verifyChainCheckpoint(audit, bad, trust()), (error) => error.code === "CHECKPOINT_INVALID");
  }
});

test("a checkpoint beyond the chain or with another head is a mismatch", async () => {
  const { audit, receipt } = await checkpointedRun();
  const count = audit.events.length;
  for (const bundle of [audit, receipt]) {
    for (const checkpoint of [
      `${count + 1}:${audit.events.at(-1).event_hash}`,
      `${count}:${audit.events[0].event_hash}`,
      `1:${audit.events[1].event_hash}`,
    ]) {
      assert.throws(() => verifyChainCheckpoint(bundle, checkpoint, trust()), (error) => error.code === "CHECKPOINT_MISMATCH");
    }
  }
});

test("a checkpoint never weakens verification", async () => {
  const { audit, receipt } = await checkpointedRun();
  const head = `${audit.events.length}:${audit.events.at(-1).event_hash}`;
  // The round-1 binding: a relabelled receipt is still tampered.
  const relabeled = deepClone(receipt);
  relabeled.action.action_type = "demo.email.send/v1";
  assert.throws(() => verifyChainCheckpoint(relabeled, head, trust()), (error) => error.code === "BUNDLE_TAMPERED");
  // Untrusted keys are still refused.
  assert.throws(() => verifyChainCheckpoint(audit, head, {}), (error) => error.code === "UNTRUSTED_KEY");
  // Audit bundles still get lifecycle semantics.
  const semanticDefect = deepClone(audit);
  semanticDefect.settlement_receipt = signArtifact({
    ...without(semanticDefect.settlement_receipt, ["signature"]),
    closed_at: new Date(Date.parse(semanticDefect.settlement_receipt.closed_at) + 1).toISOString(),
  }, createDemoSigner());
  assert.throws(() => verifyChainCheckpoint(semanticDefect, head, trust()), (error) => error.code === "SEMANTIC_INVALID");
});

test("crctl --expect-checkpoint passes on extending bundles and reports the checkpoint", async () => {
  const dir = tempDir();
  const { checkpoints, audit, receipt } = await checkpointedRun();
  const auditPath = writeJson(dir, "audit.json", audit);
  const receiptPath = writeJson(dir, "receipt.json", receipt);
  const checkpoint = checkpoints[1];
  const expected = {
    event_count: 2,
    event_chain_head: checkpoint.slice(2),
    extends: true,
    events_after_checkpoint: audit.events.length - 2,
  };

  for (const [command, path] of [
    ["verify", auditPath], ["timeline", auditPath], ["timeline", receiptPath], ["review", auditPath],
    ["review", receiptPath], ["evidence", auditPath], ["evidence", receiptPath], ["timing", auditPath],
  ]) {
    const result = cli(["bundle", command, path, "--expect-checkpoint", checkpoint, "--json"]);
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout).checkpoint, expected, command);
  }

  const text = cli(["bundle", "verify", auditPath, `--expect-checkpoint=${checkpoint}`]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, new RegExp(`^checkpoint: ${checkpoint} extended by ${audit.events.length - 2} later events$`, "m"));
  const timeline = cli(["bundle", "timeline", receiptPath, "--expect-checkpoint", checkpoint]);
  assert.match(timeline.stdout, /^checkpoint: 2:/m);

  const markdown = cli(["bundle", "review", auditPath, "--expect-checkpoint", checkpoint, "--markdown"]);
  assert.equal(markdown.status, 0, markdown.stderr);
  assert.match(markdown.stdout, /^- Checkpoint: the first 2 events match the caller&#45;held chain head /m);

  const receiptOut = join(dir, "projection.json");
  const exported = cli(["bundle", "receipt", auditPath, "--out", receiptOut, "--expect-checkpoint", checkpoint]);
  assert.equal(exported.status, 0, exported.stderr);
  assert.deepEqual(JSON.parse(exported.stdout).checkpoint, expected);
  assert.equal(existsSync(receiptOut), true);

  // Default outputs carry no checkpoint field.
  const plain = cli(["bundle", "verify", auditPath, "--json"]);
  assert.equal(Object.hasOwn(JSON.parse(plain.stdout), "checkpoint"), false);
  assert.doesNotMatch(cli(["bundle", "verify", auditPath]).stdout, /checkpoint/);
});

test("crctl refuses a forged history under the checkpoint and writes no receipt", async () => {
  const dir = tempDir();
  const { checkpoints, audit } = await checkpointedRun();
  const forgedPath = writeJson(dir, "forged.json", forgeHistory(audit));
  const plain = cli(["bundle", "verify", forgedPath, "--json"]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(JSON.parse(plain.stdout).semantics.status, "verified");

  for (const command of ["verify", "timeline", "review", "evidence", "timing"]) {
    const result = cli(["bundle", command, forgedPath, "--expect-checkpoint", checkpoints[1], "--json"]);
    assert.equal(result.status, 1, command);
    assert.equal(result.stdout, "", command);
    assert.equal(stderrJson(result).code, "CHECKPOINT_MISMATCH", command);
  }
  const markdown = cli(["bundle", "review", forgedPath, "--expect-checkpoint", checkpoints[1], "--markdown"]);
  assert.equal(markdown.status, 1);
  assert.equal(stderrJson(markdown).code, "CHECKPOINT_MISMATCH");

  const out = join(dir, "forged-receipt.json");
  const receipt = cli(["bundle", "receipt", forgedPath, "--out", out, "--expect-checkpoint", checkpoints[1]]);
  assert.equal(receipt.status, 1);
  assert.equal(stderrJson(receipt).code, "CHECKPOINT_MISMATCH");
  assert.equal(existsSync(out), false);
});

test("a malformed checkpoint fails before any file is read", async () => {
  const { audit } = await checkpointedRun();
  const head = audit.events[1].event_hash;
  const missing = join(tempDir(), "does-not-exist.json");
  for (const value of [`0:${head}`, `02:${head}`, `2.0:${head}`, `x:${head}`, `2:${head}=`, `2:${head.slice(2)}`,
    `2:${head.slice(0, 42)}${head.at(-1) === "B" ? "C" : "B"}`]) {
    for (const args of [
      ["bundle", "verify", missing, "--expect-checkpoint", value],
      ["bundle", "review", missing, `--expect-checkpoint=${value}`, "--trusted-keys", missing],
    ]) {
      const result = cli(args);
      assert.equal(result.status, 1, value);
      const failure = stderrJson(result);
      assert.equal(failure.code, "USAGE_INVALID", value);
      assert.match(failure.message, /--expect-checkpoint must be <event_count>:<event_chain_head>/, value);
    }
  }
  const dashed = cli(["bundle", "verify", missing, "--expect-checkpoint", `-2:${head}`]);
  assert.equal(stderrJson(dashed).code, "USAGE_INVALID");
  assert.match(stderrJson(dashed).message, /--expect-checkpoint requires a value/);
});

test("only the single-bundle settlement commands accept --expect-checkpoint", async () => {
  const dir = tempDir();
  const { audit } = await checkpointedRun();
  const auditPath = writeJson(dir, "audit.json", audit);
  const checkpoint = `1:${audit.events[0].event_hash}`;
  for (const args of [
    ["bundle", "verify-many", auditPath],
    ["bundle", "compare", auditPath, auditPath],
    ["recovery-preflight", "verify", auditPath],
    ["demo", "refund"],
    ["trust", "demo"],
  ]) {
    const result = cli([...args, "--expect-checkpoint", checkpoint]);
    assert.equal(result.status, 1, args.join(" "));
    assert.deepEqual(stderrJson(result), {
      code: "USAGE_INVALID",
      message: "Flag --expect-checkpoint is not valid for this command. Run with --help.",
    }, args.join(" "));
  }
});

test("crctl combines --expect-checkpoint with --trusted-keys and --expect-digest", async () => {
  const dir = tempDir();
  const railKey = generateKeyPairSync("ed25519"), connectorKey = generateKeyPairSync("ed25519");
  const clock = new ManualClock();
  const connector = new MockRefundConnector(clock, {
    signer: createSigner({ keyId: "ops-connector", privateKey: connectorKey.privateKey }),
  });
  const rail = new ConsequenceRail({
    signer: createSigner({ keyId: "ops-rail", privateKey: railKey.privateKey }),
    clock, connector, connectorTrustedKeys: connector.trustedKeys(),
  });
  const { actionId } = prepareRefund({ clock, rail, connector, assuranceMode: "enforced" });
  const view = rail.inspect(actionId);
  const checkpoint = `${view.event_count}:${view.event_chain_head}`;
  await rail.execute(actionId, { fault: "none" });
  await rail.verifyOutcome(actionId, { fault: "none" });
  const bundle = rail.exportBundle(actionId, { profile: "audit" });
  const bundlePath = writeJson(dir, "own.json", bundle);
  const trustPath = writeJson(dir, "trust.json", {
    schema_version: TRUSTED_KEYS_SCHEMA_VERSION,
    rail: [{ key_id: "ops-rail", public_key_pem: railKey.publicKey.export({ format: "pem", type: "spki" }).toString() }],
    connector: [{ key_id: "ops-connector", public_key_pem: connectorKey.publicKey.export({ format: "pem", type: "spki" }).toString() }],
  });

  const untrusted = cli(["bundle", "verify", bundlePath, "--expect-checkpoint", checkpoint, "--json"]);
  assert.equal(stderrJson(untrusted).code, "UNTRUSTED_KEY");
  const result = cli(["bundle", "verify", bundlePath, "--trusted-keys", trustPath, "--expect-digest", digest(bundle),
    "--expect-checkpoint", checkpoint, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.trust_profile, "caller_supplied_keys");
  assert.equal(output.checkpoint.event_count, view.event_count);
  assert.equal(output.checkpoint.events_after_checkpoint, bundle.events.length - view.event_count);
  const reread = JSON.parse(readFileSync(bundlePath, "utf8"));
  assert.equal(reread.events[view.event_count - 1].event_hash, view.event_chain_head);
});

test("crctl keeps the round-1 action-type binding under a checkpoint", async () => {
  const dir = tempDir();
  const { receipt } = await checkpointedRun();
  const relabeled = deepClone(receipt);
  relabeled.action.action_type = "demo.email.send/v1";
  const path = writeJson(dir, "relabeled.json", relabeled);
  const checkpoint = `${receipt.events.length}:${receipt.events.at(-1).event_hash}`;
  for (const command of ["review", "timeline"]) {
    const result = cli(["bundle", command, path, "--expect-checkpoint", checkpoint, "--json"]);
    assert.equal(result.status, 1);
    assert.equal(stderrJson(result).code, "BUNDLE_TAMPERED");
  }
});
