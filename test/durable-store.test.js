import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ManualClock } from "../src/clock.js";
import { FileEventStore } from "../src/file-event-store.js";
import { MockTicketConnector } from "../src/mock-ticket-connector.js";
import { FilePermitLedger, MemoryPermitLedger } from "../src/permit-ledger.js";
import { createDemoConnectorSigner, createDemoSigner, demoConnectorTrustedKeys, demoTrustedKeys } from "../src/signing.js";
import { createTicketRuntime, prepareTicket } from "../src/ticket-demo.js";
import { verifyBundle } from "../src/verify.js";

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "rail-durable-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fileRuntime(dir, extra = {}) {
  return createTicketRuntime({
    createEventStore: (signer, clock) => new FileEventStore({ dir, signer, clock }),
    ...extra,
  });
}

async function runToReceipt(runtime) {
  const { actionId } = await prepareTicket(runtime);
  await runtime.rail.execute(actionId);
  await runtime.rail.verifyOutcome(actionId);
  return actionId;
}

test("two rails sharing a permit ledger cannot both spend one permit", async (t) => {
  for (const shared of [new MemoryPermitLedger(), new FilePermitLedger({ dir: tempDir(t) })]) {
    const clock = new ManualClock();
    const connector = new MockTicketConnector(clock);
    // Only the rail ledger stops the second call here: the connector lease is
    // switched off to show that the ledger alone is enough.
    connector.consumePermit = undefined;
    const first = createTicketRuntime({ clock, connector, permitLedger: shared });
    const second = createTicketRuntime({ clock, connector, permitLedger: shared });
    const a = await prepareTicket(first);
    const b = await prepareTicket(second);
    assert.equal(first.rail.get(a.actionId).permit.jti, second.rail.get(b.actionId).permit.jti);
    await first.rail.execute(a.actionId);
    await assert.rejects(second.rail.execute(b.actionId), { code: "PERMIT_USED" });
    assert.equal(connector.executeCalls, 1);
    assert.equal(second.rail.inspect(b.actionId).state, "PERMITTED");
  }
});

test("the connector lease stops a reused permit when the rails do not share a ledger", async () => {
  const clock = new ManualClock();
  const connector = new MockTicketConnector(clock);
  const first = createTicketRuntime({ clock, connector });
  const second = createTicketRuntime({ clock, connector });
  const a = await prepareTicket(first);
  const b = await prepareTicket(second);
  await first.rail.execute(a.actionId);
  await assert.rejects(second.rail.execute(b.actionId), {
    code: "PERMIT_USED",
    message: /connector already holds/,
  });
  assert.equal(connector.executeCalls, 1);
});

test("the file permit ledger survives a new instance and prunes expired entries", (t) => {
  const dir = tempDir(t);
  const entry = { jti: "jti_one", action_digest: "d".repeat(43), expires_at: "2026-01-01T00:10:00.000Z" };
  assert.equal(new FilePermitLedger({ dir }).consume(entry), true);
  const reopened = new FilePermitLedger({ dir });
  assert.equal(reopened.has("jti_one"), true);
  assert.equal(reopened.consume(entry), false);
  assert.equal(reopened.prune("2026-01-01T00:09:59.000Z"), 0);
  assert.equal(reopened.prune("2026-01-01T00:10:01.000Z"), 1);
  assert.equal(reopened.has("jti_one"), false);
  assert.throws(() => reopened.consume({ jti: "x" }), { code: "SCHEMA_INVALID" });
});

test("a file event store keeps a verifiable history across a restart", async (t) => {
  const dir = tempDir(t);
  const signer = createDemoSigner();
  const runtime = fileRuntime(dir, { signer });
  const actionId = await runToReceipt(runtime);
  const bundle = runtime.rail.exportBundle(actionId, { profile: "audit" });
  const events = runtime.eventStore.list(actionId);
  assert.equal(
    verifyBundle(bundle, {
      trustedKeys: demoTrustedKeys(),
      trustedConnectorKeys: demoConnectorTrustedKeys(),
      requireSemantics: true,
    }).valid,
    true,
  );
  assert.deepEqual(readdirSync(dir).sort(), [".lock", `${actionId}.jsonl`]);

  assert.throws(() => new FileEventStore({ dir, signer, clock: runtime.clock }), { code: "EVENT_LOG_LOCKED" });
  runtime.eventStore.close();
  assert.deepEqual(readdirSync(dir), [`${actionId}.jsonl`]);

  const restarted = fileRuntime(dir, { signer });
  assert.deepEqual(restarted.eventStore.list(actionId), events);
  assert.deepEqual(restarted.eventStore.streams(), [actionId]);
  // The same action cannot start again from the top after a restart.
  await assert.rejects(prepareTicket(restarted), { code: "ACTION_EXISTS", message: /earlier run/ });
  assert.equal(restarted.connector.executeCalls, 0);
  restarted.eventStore.close();
});

test("a torn, edited or foreign event log does not open", async (t) => {
  const dir = tempDir(t);
  const signer = createDemoSigner();
  const runtime = fileRuntime(dir, { signer });
  const { actionId } = await prepareTicket(runtime);
  runtime.eventStore.close();
  const path = join(dir, `${actionId}.jsonl`);
  const original = readFileSync(path, "utf8");
  const open = () => new FileEventStore({ dir, signer, clock: runtime.clock });

  appendFileSync(path, '{"schema_version":');
  assert.throws(open, { code: "EVENT_LOG_CORRUPT", message: /torn/ });

  writeFileSync(path, original.replace('"PROPOSED"', '"EXECUTED"'));
  assert.throws(open, { code: "EVENT_LOG_CORRUPT" });

  writeFileSync(path, original.split("\n").slice(1).join("\n"));
  assert.throws(open, { code: "EVENT_LOG_CORRUPT" });

  writeFileSync(path, original);
  assert.throws(
    () => new FileEventStore({ dir, signer: createDemoConnectorSigner(), clock: runtime.clock }),
    (error) => error.code === "EVENT_LOG_CORRUPT" || error.code === "UNTRUSTED_KEY",
  );
  // A failed open releases its lock, and the good log opens again.
  const store = open();
  assert.equal(store.list(actionId).length > 0, true);
  store.close();
  assert.throws(() => store.append(actionId, "X", "rail", {}), { code: "EVENT_LOG_CLOSED" });
});

test("a file event store refuses unsafe stream ids", (t) => {
  const store = new FileEventStore({ dir: tempDir(t), signer: createDemoSigner(), clock: new ManualClock() });
  t.after(() => store.close());
  for (const id of ["../escape", "a/b", "", "x".repeat(81)]) {
    assert.throws(() => store.append(id, "X", "rail", {}), { code: "SCHEMA_INVALID" });
  }
});
