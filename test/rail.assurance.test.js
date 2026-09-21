// Assurance mode and permit issuance tests for the consequence-rail module.
// Split from test/rail.test.js.

import assert from "node:assert/strict";
import test from "node:test";
import { buildRefundProposal, createDemoRuntime, prepareRefund, runRefundDemo } from "../src/demo.js";
import { digest } from "../src/canonical.js";
import { prepareRefundWithoutPermit } from "../src/rail-test-helpers.js";

test("observed mode cannot reserve recourse or issue a permit", () => {
  const runtime = createDemoRuntime({ assuranceMode: "observed" });
  const proposal = buildRefundProposal(runtime.clock, "observed");
  const proposed = runtime.rail.propose(proposal);
  runtime.rail.authorize(proposed.action_id, {
    allow: true,
    policy_id: "demo-policy/v1",
    policy_digest: digest({ allow: true }),
  });
  assert.throws(
    () =>
      runtime.rail.reserveRecourse(proposed.action_id, {
        action_digest: proposed.action_digest,
      }),
    (error) => error.code === "MODE_NOT_EXECUTABLE",
  );
  assert.equal(runtime.connector.executeCalls, 0);
});

test("enforced mode requires exclusive connector credential custody", () => {
  const runtime = createDemoRuntime();
  const { actionId } = prepareRefundWithoutPermit(runtime);
  runtime.connector.exclusiveCredentialCustody = false;
  assert.throws(
    () => runtime.rail.issuePermit(actionId),
    (error) => error.code === "ASSURANCE_UNSUPPORTED",
  );
});

test("permit issuance rejects a connector reservation that is no longer active", () => {
  const runtime = createDemoRuntime();
  const { actionId } = prepareRefundWithoutPermit(runtime);
  const token =
    runtime.rail.get(actionId).reservation.connector_commitment.reservation_token;
  runtime.connector.releaseRecourse(token);
  assert.throws(
    () => runtime.rail.issuePermit(actionId),
    (error) => error.code === "RECOURSE_NOT_ACTIVE",
  );
});

test("execution rechecks connector recourse immediately before side effects", async () => {
  const runtime = createDemoRuntime();
  const { actionId } = prepareRefund(runtime);
  const token =
    runtime.rail.get(actionId).reservation.connector_commitment.reservation_token;
  runtime.connector.releaseRecourse(token);
  await assert.rejects(
    runtime.rail.execute(actionId),
    (error) => error.code === "RECOURSE_NOT_ACTIVE",
  );
  assert.equal(runtime.connector.executeCalls, 0);
  assert.equal(runtime.rail.inspect(actionId).state, "REVOKED");
});

test("cooperative mode discloses bypass possibility in permit and receipt", async () => {
  const result = await runRefundDemo({ assuranceMode: "cooperative" });
  assert.equal(result.summary.bypass_possible, true);
  assert.equal(result.bundle.action_permit.bypass_possible, true);
  assert.equal(result.bundle.settlement_receipt.bypass_possible, true);
});

test("expired permit is rejected before connector invocation", async () => {
  const runtime = createDemoRuntime();
  const { actionId } = prepareRefund(runtime);
  runtime.clock.advance(121_000);
  await assert.rejects(
    runtime.rail.execute(actionId),
    (error) => error.code === "PERMIT_EXPIRED",
  );
  assert.equal(runtime.connector.executeCalls, 0);
  assert.equal(runtime.rail.inspect(actionId).state, "EXPIRED");
  const token =
    runtime.rail.get(actionId).reservation.connector_commitment.reservation_token;
  assert.equal(runtime.connector.recourseStatus(token).status, "released");
});

test("connector recourse status expires when its deadline passes", () => {
  const runtime = createDemoRuntime();
  const { actionId } = prepareRefund(runtime);
  const reservation = runtime.rail.get(actionId).reservation;
  runtime.clock.advance(
    new Date(reservation.expires_at).getTime() -
      new Date(runtime.clock.now()).getTime() +
      1,
  );
  assert.equal(
    runtime.connector.recourseStatus(
      reservation.connector_commitment.reservation_token,
    ).status,
    "expired",
  );
});

test("recourse reservation must bind the exact action digest", () => {
  const runtime = createDemoRuntime();
  const proposal = buildRefundProposal(runtime.clock);
  const proposed = runtime.rail.propose(proposal);
  runtime.rail.authorize(proposed.action_id, {
    allow: true,
    policy_id: "demo-policy/v1",
    policy_digest: digest({ allow: true }),
  });
  assert.throws(
    () =>
      runtime.rail.reserveRecourse(proposed.action_id, {
        action_digest: digest({ different: true }),
      }),
    (error) => error.code === "RECOURSE_INVALID",
  );
});
