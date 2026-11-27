import assert from "node:assert/strict";
import test from "node:test";
import { validateSettlementBundle } from "../src/bundle-validation.js";
import { deepClone, digest } from "../src/canonical.js";
import { createDemoRuntime, buildRefundProposal } from "../src/demo.js";
import { assertRequiredFields } from "../src/rail-test-helpers.js";
import { createDemoSigner, demoConnectorTrustedKeys, demoTrustedKeys, signArtifact } from "../src/signing.js";
import { buildTicketProposal, buildTicketReservation, createTicketRuntime, runTicketDemo } from "../src/ticket-demo.js";
import { verifyBundle, verifySettlementArtifact } from "../src/verify.js";

const trust = () => ({ trustedKeys: demoTrustedKeys(), trustedConnectorKeys: demoConnectorTrustedKeys() });

function reserved(runtime, mutate = () => {}) {
  const proposal = buildTicketProposal(runtime.clock);
  mutate(proposal);
  const proposed = runtime.rail.propose(proposal);
  runtime.rail.authorize(proposed.action_id, { allow: true, policy_id: "p", policy_digest: digest({ p: 1 }) });
  runtime.rail.reserveRecourse(proposed.action_id, buildTicketReservation(proposed.action_digest, proposal));
  return proposed;
}

test("the dry run is bound into the permit and compared with the real effect", async () => {
  for (const [fault, diverged] of [["none", []], ["duplicate", ["comment_count"]]]) {
    const { bundle, runtime, summary } = await runTicketDemo({ fault });
    assert.equal(bundle.action_permit.schema_version, "consequence-rail/action-permit/v0.2");
    assert.equal(bundle.action_permit.simulation_digest, digest(bundle.simulation_result));
    assertRequiredFields("spec/schemas/action-permit-v0.2.schema.json", bundle.action_permit);
    assertRequiredFields("spec/schemas/simulation-result.schema.json", bundle.simulation_result);
    assert.equal(runtime.connector.simulateCalls, 1);
    const result = verifyBundle(bundle, { ...trust(), requireSemantics: true });
    assert.deepEqual(result.semantics.simulation, {
      simulation_digest: bundle.action_permit.simulation_digest,
      diverged_paths: diverged,
    });
    const receipt = runtime.rail.exportBundle(summary.action_id, { profile: "receipt" });
    assert.equal(Object.hasOwn(receipt, "simulation_result"), false);
    assert.equal(verifySettlementArtifact(receipt, { ...trust(), allowReceiptProfile: true }).valid, true);
  }
});

test("a permit needs a fresh dry run that predicts the postcondition", async () => {
  const runtime = createTicketRuntime();
  const { rail, connector, clock } = runtime;
  const first = reserved(runtime);
  assert.throws(() => rail.issuePermit(first.action_id), { code: "SIMULATION_REQUIRED" });
  await rail.simulate(first.action_id);
  assert.equal(rail.inspect(first.action_id).simulation_predicted_satisfied, true);
  clock.advance(61_000);
  assert.throws(() => rail.issuePermit(first.action_id), { code: "SIMULATION_STALE" });

  connector.lockedTickets = new Set(["tkt_locked"]);
  const locked = reserved(runtime, (proposal) => {
    proposal.target.resource_id = "tkt_locked";
    proposal.idempotency_key = "comment:tkt_locked:1";
  });
  await rail.simulate(locked.action_id);
  assert.equal(rail.inspect(locked.action_id).simulation_predicted_satisfied, false);
  assert.throws(() => rail.issuePermit(locked.action_id), { code: "SIMULATION_PREDICTS_BREACH" });
  assert.equal(connector.executeCalls, 0);
  const events = rail.eventStore.list(locked.action_id).map((event) => event.event_type);
  assert.ok(events.includes("SIMULATION_ACCEPTED"));
});

test("a dry run must be signed by a trusted connector key, bound and complete", async () => {
  const cases = [
    [(result) => ({ ...result, action_digest: digest("other") }), "SIMULATION_ACTION_MISMATCH", true],
    [(result) => ({ ...result, predicted_facts: { ...result.predicted_facts, visibility: "internal" } }), "SIMULATION_BINDING_MISMATCH", true],
    [(result) => ({ ...result, predicted_facts: { visibility: "public" } }), "SIMULATION_INCOMPLETE", true],
    [(result) => ({ ...result, extra: 1 }), "SIMULATION_INVALID", true],
    [(result) => ({ ...result, simulated_at: "2034-12-31T23:00:00.000Z" }), "SIMULATION_STALE", true],
    [(result) => ({ ...result, predicted_facts: { ...result.predicted_facts, comment_count: 2 } }), "UNTRUSTED_KEY", false],
  ];
  for (const [mutate, code, resign] of cases) {
    const runtime = createTicketRuntime();
    const simulate = runtime.connector.simulate.bind(runtime.connector);
    runtime.connector.simulate = (...args) => {
      const { signature: _signature, ...body } = mutate(simulate(...args));
      return signArtifact(body, resign ? runtime.connector.signer : createDemoSigner());
    };
    const proposed = reserved(runtime);
    await assert.rejects(() => runtime.rail.simulate(proposed.action_id), { code }, code);
    assert.equal(runtime.rail.inspect(proposed.action_id).state, "RECOURSE_RESERVED");
  }
});

test("simulation needs a v0.3 action and a connector that offers a dry run", async () => {
  const runtime = createDemoRuntime();
  const proposal = buildRefundProposal(runtime.clock);
  const proposed = runtime.rail.propose(proposal);
  runtime.rail.authorize(proposed.action_id, { allow: true, policy_id: "p", policy_digest: digest({ p: 1 }) });
  runtime.rail.reserveRecourse(proposed.action_id, {
    action_digest: proposed.action_digest,
    kind: "reverse",
    connector: "mock-refund-processor",
    capability: "void-duplicate-refund",
    capability_reference: "demo-capability:void-duplicate-refund",
    expires_at: new Date(new Date(proposal.expires_at).getTime() + 300_000).toISOString(),
    remedy_window_seconds: 120,
    max_attempts: 1,
    max_amount_minor: proposal.parameters.amount_minor,
    idempotency_key: `remedy:${proposal.idempotency_key}`,
  });
  await assert.rejects(() => runtime.rail.simulate(proposed.action_id), { code: "SIMULATION_UNSUPPORTED" });

  const ticket = createTicketRuntime();
  ticket.connector.simulate = undefined;
  const reservedTicket = reserved(ticket);
  await assert.rejects(() => ticket.rail.simulate(reservedTicket.action_id), { code: "SIMULATION_UNSUPPORTED" });
});

test("offline checks tie the simulation result to the permit", async () => {
  const { bundle, runtime, summary } = await runTicketDemo({ fault: "none" });
  const missing = deepClone(bundle);
  delete missing.simulation_result;
  assert.throws(() => validateSettlementBundle(missing), { code: "BUNDLE_TAMPERED" });
  const receipt = runtime.rail.exportBundle(summary.action_id, { profile: "receipt" });
  assert.throws(() => validateSettlementBundle({ ...receipt, simulation_result: bundle.simulation_result }), { code: "BUNDLE_TAMPERED" });
  const v2bundle = deepClone(bundle);
  v2bundle.schema_version = "consequence-rail/settlement-bundle/v0.2";
  assert.throws(() => validateSettlementBundle(v2bundle), { code: "BUNDLE_TAMPERED" });

  const swapped = deepClone(bundle);
  const { signature: _signature, ...body } = swapped.simulation_result;
  swapped.simulation_result = signArtifact(
    { ...body, predicted_facts: { ...body.predicted_facts, comment_count: 2 } },
    runtime.connector.signer,
  );
  assert.throws(() => verifyBundle(swapped, { ...trust(), requireSemantics: true }), { code: "BUNDLE_TAMPERED" });
});
