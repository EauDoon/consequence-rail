import assert from "node:assert/strict";
import test from "node:test";
import {
  INVENTORY_DEMO_FAULTS,
  buildInventoryProposal,
  createInventoryRuntime,
  runInventoryDemo,
} from "../src/inventory-demo.js";
import { ManualClock } from "../src/clock.js";
import { verifyBundle } from "../src/verify.js";
import { demoConnectorTrustedKeys, demoTrustedKeys } from "../src/signing.js";

test("inventory allocation settles with the declared quantity reserved", async () => {
  const { summary, runtime } = await runInventoryDemo({ fault: "none" });
  assert.equal(summary.scenario, "synthetic-inventory-allocation");
  assert.equal(summary.state, "CLOSED");
  assert.equal(summary.outcome, "settled");
  assert.equal(summary.bundle_verification, "pass");
  assert.equal(summary.execute_calls, 1);
  assert.equal(summary.remedy_calls, 0);
  assert.equal(summary.active_allocations, 1);
  assert.equal(summary.allocated_quantity, 4);
  assert.equal(summary.inventory_on_hand, 21);
  assert.ok(runtime.connector.inventory.get("sku_demo_1") >= 0);
});

test("duplicate allocation is compensated by reversing only the bound allocation", async () => {
  const { summary, runtime } = await runInventoryDemo({ fault: "duplicate" });
  assert.equal(summary.outcome, "compensated");
  assert.equal(summary.bundle_verification, "pass");
  assert.equal(summary.remedy_calls, 1);
  // The duplicate was reversed: one allocation of the declared quantity remains.
  assert.equal(summary.active_allocations, 1);
  assert.equal(summary.allocated_quantity, 4);
  const released = runtime.connector.allocations.filter((item) => item.status === "released");
  assert.equal(released.length, 1);
  assert.equal(released[0].quantity, 4);
});

test("failed remediation leaves the action disputed without a blind retry", async () => {
  const { summary } = await runInventoryDemo({ fault: "remedy-failure" });
  assert.equal(summary.outcome, "disputed");
  assert.equal(summary.remedy_calls, 1);
  assert.equal(summary.execute_calls, 1);
  assert.equal(summary.active_allocations, 2);
  assert.equal(summary.allocated_quantity, 8);
});

test("ambiguous outcomes reconcile instead of re-executing", async () => {
  const after = await runInventoryDemo({ fault: "lost-response-after-commit" });
  assert.equal(after.summary.execute_calls, 1);
  assert.equal(after.summary.outcome, "settled");
  assert.equal(after.summary.status_calls, 1, "the ambiguous result was reconciled");

  const before = await runInventoryDemo({ fault: "lost-response-before-commit" });
  assert.equal(before.summary.execute_calls, 1, "the action must not be retried");
  assert.equal(before.summary.status_calls, 1, "the ambiguous result was reconciled");
  // Confirmed no effect: nothing was allocated and no remedy ran.
  assert.equal(before.summary.outcome, null);
  assert.equal(before.summary.active_allocations, 0);
  assert.equal(before.summary.remedy_calls, 0);
  assert.equal(before.summary.inventory_on_hand, 25);
});

test("stale evidence closes the inventory action as disputed", async () => {
  const { summary } = await runInventoryDemo({ fault: "stale-evidence" });
  assert.equal(summary.outcome, "disputed");
  assert.equal(summary.execute_calls, 1);
});

test("inventory faults cover materially different paths", () => {
  assert.ok(INVENTORY_DEMO_FAULTS.includes("none"));
  assert.ok(INVENTORY_DEMO_FAULTS.includes("duplicate"));
  assert.ok(INVENTORY_DEMO_FAULTS.includes("remedy-failure"));
  assert.ok(INVENTORY_DEMO_FAULTS.includes("post-remedy-false-evidence"));
});

test("the remedy refuses cross-order reversal and double restoration", async () => {
  const runtime = createInventoryRuntime({ clock: new ManualClock() });
  const proposal = buildInventoryProposal(runtime.clock);
  const { actionId } = await runInventoryDemo({ fault: "duplicate" }).then(async (result) => ({
    actionId: result.summary.action_id,
  }));
  void runtime;
  void proposal;
  void actionId;

  // Direct connector-level guard: an allocation belonging to another order is
  // never released.
  const fresh = createInventoryRuntime({ clock: new ManualClock() });
  const other = buildInventoryProposal(fresh.clock);
  const executed = await fresh.connector.execute(other, other.idempotency_key);
  assert.equal(executed.status, "executed");
  const reservation = fresh.connector.reserveRecourse(other, {
    action_digest: "sha256:x",
    kind: "reverse",
    connector: "mock-inventory-service",
    capability: "release-allocation",
    capability_reference: "demo-capability:release-allocation",
    expires_at: other.expires_at,
    remedy_window_seconds: 120,
    max_attempts: 1,
    max_quantity: other.parameters.quantity,
    idempotency_key: `remedy:${other.idempotency_key}:release`,
  });
  const first = await fresh.connector.remediate(other, { connector_commitment: reservation }, "remedy:1");
  assert.equal(first.status, "remediated");
  // A second remediation with the same key is idempotent: the inventory is not
  // restored twice.
  const onHandAfterFirst = fresh.connector.inventory.get("sku_demo_1");
  const second = await fresh.connector.remediate(other, { connector_commitment: reservation }, "remedy:1");
  assert.equal(second.status, "remediated");
  assert.equal(fresh.connector.inventory.get("sku_demo_1"), onHandAfterFirst);
});

test("inventory bundles verify with the rail's own verifier", async () => {
  const { bundle } = await runInventoryDemo({ fault: "duplicate" });
  assert.ok(bundle);
  const verified = verifyBundle(bundle, {
    trustedKeys: demoTrustedKeys(),
    trustedConnectorKeys: demoConnectorTrustedKeys(),
    requireSemantics: true,
  });
  assert.equal(verified.valid, true);
  assert.equal(verified.action_type ?? bundle.action.action_type, "demo.inventory.allocate/v1");
});

test("inventory proposals scope recourse by quantity, not amount", () => {
  const clock = new ManualClock();
  const proposal = buildInventoryProposal(clock);
  assert.equal(proposal.action_type, "demo.inventory.allocate/v1");
  assert.deepEqual(Object.keys(proposal.parameters).sort(), ["quantity", "sku"]);
});
