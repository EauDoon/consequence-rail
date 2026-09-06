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

test("duplicate allocation reverses the extra allocation and keeps the action's own", async () => {
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
  // The allocation the receipt records (the action's own) is the one still live.
  const execution = runtime.connector.executions.get(buildInventoryProposal(runtime.clock).idempotency_key);
  const live = runtime.connector.allocations.filter((item) => item.status === "active");
  assert.equal(live.length, 1);
  assert.equal(live[0].allocation_id, execution.external_id);
  assert.notEqual(released[0].allocation_id, execution.external_id);
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

test("the remedy refuses cross-order reversal, double restoration, and unknown reservations", async () => {
  const fresh = createInventoryRuntime({ clock: new ManualClock() });
  const proposal = buildInventoryProposal(fresh.clock);
  const reservation = fresh.connector.reserveRecourse(proposal, {
    action_digest: "sha256:x",
    kind: "reverse",
    connector: "mock-inventory-service",
    capability: "release-allocation",
    capability_reference: "demo-capability:release-allocation",
    expires_at: proposal.expires_at,
    remedy_window_seconds: 120,
    max_attempts: 1,
    max_quantity: proposal.parameters.quantity,
    idempotency_key: `remedy:${proposal.idempotency_key}:release`,
  });
  await fresh.connector.execute(proposal, proposal.idempotency_key);
  const first = await fresh.connector.remediate(
    proposal,
    { connector_commitment: reservation },
    "remedy:first",
  );
  assert.equal(first.status, "remediated");
  const onHandAfterFirst = fresh.connector.inventory.get("sku_demo_1");

  // A new remedy key cannot restore the same allocation twice.
  const second = await fresh.connector.remediate(
    proposal,
    { connector_commitment: reservation },
    "remedy:second",
  );
  assert.equal(second.status, "failed");
  assert.equal(fresh.connector.inventory.get("sku_demo_1"), onHandAfterFirst);

  // An allocation belonging to another order is never released.
  const other = buildInventoryProposal(fresh.clock);
  other.target.resource_id = "ord_inventory_other";
  other.idempotency_key = "allocate:ord_inventory_other:1";
  await fresh.connector.execute(other, other.idempotency_key);
  const otherReservation = fresh.connector.reserveRecourse(other, {
    action_digest: "sha256:y",
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
  const otherRemedy = await fresh.connector.remediate(
    other,
    { connector_commitment: otherReservation },
    "remedy:other",
  );
  assert.equal(otherRemedy.status, "remediated");
  assert.equal(
    fresh.connector.allocations.filter(
      (item) => item.order_id === other.target.resource_id && item.status === "active",
    ).length,
    0,
  );
  // The first order's released allocation was not touched again.
  assert.equal(fresh.connector.inventory.get("sku_demo_1"), onHandAfterFirst);

  // An unknown reservation is refused rather than silently releasing.
  await assert.rejects(
    () => fresh.connector.remediate(other, { connector_commitment: { reservation_token: "rsv_missing" } }, "remedy:unknown"),
    (error) => error.code === "RECOURSE_NOT_ACTIVE",
  );
});

test("inventory cannot over-allocate or go negative", async () => {
  const fresh = createInventoryRuntime({ clock: new ManualClock() });
  const proposal = buildInventoryProposal(fresh.clock);
  const onHand = fresh.connector.inventory.get("sku_demo_1");
  assert.throws(
    () => fresh.connector.createAllocation({ ...proposal, parameters: { ...proposal.parameters, quantity: onHand + 1 } }, "over"),
    (error) => error.code === "INVENTORY_INSUFFICIENT",
  );
  assert.equal(fresh.connector.inventory.get("sku_demo_1"), onHand);
  assert.equal(fresh.connector.allocations.length, 0);
});

test("allocation actions refuse cross-domain and undersized recourse", () => {
  const runtime = createInventoryRuntime({ clock: new ManualClock() });
  const proposal = buildInventoryProposal(runtime.clock);
  const base = {
    action_digest: "sha256:x",
    kind: "reverse",
    connector: "mock-inventory-service",
    capability: "release-allocation",
    capability_reference: "demo-capability:release-allocation",
    expires_at: proposal.expires_at,
    remedy_window_seconds: 120,
    max_attempts: 1,
    idempotency_key: `remedy:${proposal.idempotency_key}:release`,
  };
  assert.throws(
    () => runtime.connector.reserveRecourse(proposal, { ...base, max_quantity: 1 }),
    (error) => error.code === "RECOURSE_SCOPE_INSUFFICIENT",
  );
  assert.throws(
    () => runtime.connector.reserveRecourse(proposal, { ...base, max_quantity: undefined }),
    (error) => error.code === "RECOURSE_SCOPE_INSUFFICIENT",
  );
  // A refund-shaped action cannot reserve an allocation remedy here.
  assert.throws(
    () => runtime.connector.reserveRecourse({ ...proposal, action_type: "demo.refund.issue/v1" }, { ...base, max_quantity: 4 }),
    (error) => error.code === "RECOURSE_UNAVAILABLE",
  );
});

test("the remedy scope field must match the action type in verified bundles", async () => {
  const { bundle } = await runInventoryDemo({ fault: "duplicate" });
  const clone = (mutate) => {
    const copy = JSON.parse(JSON.stringify(bundle));
    mutate(copy);
    return copy;
  };
  const reject = (copy, label) => {
    assert.throws(
      () => verifyBundle(copy, {
        trustedKeys: demoTrustedKeys(),
        trustedConnectorKeys: demoConnectorTrustedKeys(),
        requireSemantics: true,
      }),
      (error) => error.code === "BUNDLE_TAMPERED",
      `${label} should be rejected`,
    );
  };
  // Inventory reservation may not carry the refund scope field.
  reject(clone((copy) => {
    delete copy.recourse_reservation.max_quantity;
    copy.recourse_reservation.max_amount_minor = 4;
  }), "inventory reservation with max_amount_minor");
  // Both scope fields is ambiguous.
  reject(clone((copy) => {
    copy.recourse_reservation.max_amount_minor = 4;
  }), "reservation with both scope fields");
  // Neither scope field leaves the remedy unbounded.
  reject(clone((copy) => {
    delete copy.recourse_reservation.max_quantity;
  }), "reservation with no scope field");
  // The commitment must use the same field as the reservation.
  reject(clone((copy) => {
    delete copy.recourse_reservation.connector_commitment.max_quantity;
    copy.recourse_reservation.connector_commitment.max_amount_minor = 4;
  }), "commitment with max_amount_minor");
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
