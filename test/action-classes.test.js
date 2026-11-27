import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import {
  ActionClassRegistry,
  DEMO_TICKET_COMMENT_CLASS,
  defineActionClass,
  unmetBindings,
} from "../src/action-classes.js";
import { validateSettlementBundle } from "../src/bundle-validation.js";
import { deepClone } from "../src/canonical.js";
import { ManualClock } from "../src/clock.js";
import { createReferenceServer } from "../src/http-server.js";
import { MockTicketConnector } from "../src/mock-ticket-connector.js";
import { ConsequenceRail } from "../src/rail.js";
import { assertRequiredFields } from "../src/rail-test-helpers.js";
import { createDemoSigner, demoConnectorTrustedKeys, demoRecoveryTrustedKeys, demoTrustedKeys } from "../src/signing.js";
import {
  buildTicketProposal,
  buildTicketReservation,
  createTicketRuntime,
  prepareTicket,
  runTicketDemo,
} from "../src/ticket-demo.js";
import { verifyBundle, verifySettlementArtifact } from "../src/verify.js";

const trust = () => ({
  trustedKeys: demoTrustedKeys(),
  trustedConnectorKeys: demoConnectorTrustedKeys(),
});

function authorize(rail, actionId) {
  rail.authorize(actionId, { allow: true, policy_id: "test-policy/v1", policy_digest: "A".repeat(43) });
}

test("action class definitions are closed and cannot claim a reserved demo type", () => {
  const base = deepClone(DEMO_TICKET_COMMENT_CLASS);
  base.action_type = "test.thing.do/v1";
  assert.equal(defineActionClass(base).action_type, "test.thing.do/v1");
  for (const [mutate, pattern] of [
    [(item) => { item.action_type = "demo.refund.issue/v1"; }, /reserved/],
    [(item) => { item.action_type = "Not A Type"; }, /domain\.verb\/v1/],
    [(item) => { item.extra = true; }, /unsupported field|unknown/i],
    [(item) => { item.parameters.body.type = "number"; }, /string, integer or boolean/],
    [(item) => { item.recourse.covers_parameter = "body"; }, /integer parameter/],
    [(item) => { item.recourse.kinds = ["reverse", "reverse"]; }, /distinct/],
    [(item) => { item.evidence_bindings = [{ fact: "x", parameter: "missing" }]; }, /declared parameter/],
  ]) {
    const candidate = deepClone(base);
    mutate(candidate);
    assert.throws(() => defineActionClass(candidate), (error) => {
      assert.equal(error.code, "ACTION_CLASS_INVALID");
      assert.match(error.message, pattern);
      return true;
    });
  }
  const registry = new ActionClassRegistry([DEMO_TICKET_COMMENT_CLASS]);
  assert.throws(() => registry.register(DEMO_TICKET_COMMENT_CLASS), { code: "ACTION_CLASS_INVALID" });
  const listed = registry.list();
  listed[0].parameters.body.max_length = 1;
  assert.equal(registry.get("demo.ticket.comment/v1").parameters.body.max_length, 2_000);
});

test("a rail refuses a v0.3 proposal for an unregistered class", () => {
  const clock = new ManualClock();
  const connector = new MockTicketConnector(clock);
  const rail = new ConsequenceRail({
    signer: createDemoSigner(),
    clock,
    connector,
    connectorTrustedKeys: connector.trustedKeys(),
    recoveryTrustedKeys: demoRecoveryTrustedKeys(),
  });
  assert.throws(() => rail.propose(buildTicketProposal(clock)), { code: "ACTION_CLASS_UNREGISTERED" });
  assert.throws(
    () => new ConsequenceRail({
      signer: createDemoSigner(),
      clock,
      connector,
      connectorTrustedKeys: connector.trustedKeys(),
      actionClasses: "demo.ticket.comment/v1",
    }),
    { code: "CONFIG_INVALID" },
  );
});

test("v0.3 parameters, recourse scope and bindings must match the registered class", () => {
  const { clock, rail } = createTicketRuntime();
  const cases = [
    (proposal) => { proposal.parameters.visibility = "everyone"; },
    (proposal) => { proposal.parameters.cc = "x"; },
    (proposal) => { delete proposal.parameters.body; },
    (proposal) => { proposal.parameters.body = ""; },
    (proposal) => { proposal.recourse_scope = { field: "max_amount_minor", covers_parameter: null }; },
    (proposal) => { proposal.evidence_plan.parameter_bindings = []; },
    (proposal) => { delete proposal.recourse_scope; },
    (proposal) => { proposal.schema_version = "consequence-rail/action-proposal/v0.2"; },
  ];
  for (const mutate of cases) {
    const proposal = buildTicketProposal(clock);
    mutate(proposal);
    assert.throws(() => rail.propose(proposal), { code: "SCHEMA_INVALID" }, mutate.toString());
  }
  assert.equal(rail.propose(buildTicketProposal(clock)).state, "PROPOSED");
});

test("the class limits remedy kinds and an integer parameter must be covered", () => {
  const { clock, rail } = createTicketRuntime();
  const proposal = buildTicketProposal(clock);
  const proposed = rail.propose(proposal);
  authorize(rail, proposed.action_id);
  const reservation = buildTicketReservation(proposed.action_digest, proposal);
  assert.throws(
    () => rail.reserveRecourse(proposed.action_id, { ...reservation, kind: "compensate" }),
    { code: "RECOURSE_INVALID" },
  );

  const grant = defineActionClass({
    action_type: "test.credit.grant/v1",
    parameters: { amount_minor: { type: "integer", minimum: 1 }, note: { type: "string" } },
    recourse: { scope_field: "max_amount_minor", covers_parameter: "amount_minor", kinds: ["reverse"] },
    evidence_bindings: [],
  });
  const connector = new MockTicketConnector(clock);
  const grantRail = new ConsequenceRail({
    signer: createDemoSigner(),
    clock,
    connector,
    connectorTrustedKeys: connector.trustedKeys(),
    actionClasses: new ActionClassRegistry([grant]),
  });
  const grantProposal = {
    ...buildTicketProposal(clock),
    action_type: "test.credit.grant/v1",
    parameters: { amount_minor: 500, note: "goodwill" },
    evidence_plan: { source: "mock-ticket-service", max_age_seconds: 60, parameter_bindings: [] },
    recourse_scope: { field: "max_amount_minor", covers_parameter: "amount_minor" },
  };
  const granted = grantRail.propose(grantProposal);
  authorize(grantRail, granted.action_id);
  const { max_quantity: _quantity, ...money } = buildTicketReservation(granted.action_digest, grantProposal);
  assert.throws(
    () => grantRail.reserveRecourse(granted.action_id, { ...money, max_amount_minor: 499 }),
    (error) => error.code === "RECOURSE_INVALID" && /amount_minor/.test(error.message),
  );
});

test("evidence that contradicts a bound parameter is rejected, not settled", async () => {
  const runtime = createTicketRuntime();
  const observe = runtime.connector.observe.bind(runtime.connector);
  runtime.connector.observe = async (...args) => {
    const evidence = await observe(...args);
    evidence.facts.visibility = "internal";
    return evidence;
  };
  const { actionId } = await prepareTicket(runtime);
  await runtime.rail.execute(actionId);
  const view = await runtime.rail.verifyOutcome(actionId);
  assert.equal(view.outcome, "disputed");
  const rejected = runtime.rail.eventStore.list(actionId)
    .find((event) => event.event_type === "EVIDENCE_REJECTED");
  assert.equal(rejected.payload.code, "EVIDENCE_BINDING_MISMATCH");
  assert.deepEqual(unmetBindings(buildTicketProposal(runtime.clock), { visibility: "internal" }), [0]);
});

test("the offline verifier catches a rail that settled on contradicting evidence", async () => {
  const runtime = createTicketRuntime();
  const observe = runtime.connector.observe.bind(runtime.connector);
  runtime.connector.observe = async (...args) => {
    const evidence = await observe(...args);
    evidence.facts.visibility = "internal";
    return evidence;
  };
  // Simulate a faulty rail that skips the binding check.
  const validate = runtime.rail.validateEvidence.bind(runtime.rail);
  runtime.rail.validateEvidence = (record, input) => {
    const proposal = record.proposal;
    record.proposal = { ...proposal, evidence_plan: { ...proposal.evidence_plan, parameter_bindings: [] } };
    try {
      return validate(record, input);
    } finally {
      record.proposal = proposal;
    }
  };
  const { actionId } = await prepareTicket(runtime);
  await runtime.rail.execute(actionId);
  assert.equal((await runtime.rail.verifyOutcome(actionId)).outcome, "settled");
  const bundle = runtime.rail.exportBundle(actionId, { profile: "audit" });
  assert.throws(
    () => verifyBundle(bundle, { ...trust(), requireSemantics: true }),
    (error) => error.code === "SEMANTIC_INVALID" && /binds them/.test(error.message),
  );
});

test("a ticket bundle verifies offline as v0.3 in both profiles", async () => {
  const { bundle, runtime, summary } = await runTicketDemo({ fault: "duplicate" });
  assert.equal(summary.outcome, "compensated");
  assert.equal(summary.active_comments, 1);
  assert.equal(bundle.schema_version, "consequence-rail/settlement-bundle/v0.3");
  assert.equal(bundle.settlement_receipt.schema_version, "consequence-rail/settlement-receipt/v0.3");
  assert.equal(bundle.settlement_receipt.proposal_schema_version, "consequence-rail/action-proposal/v0.3");
  assertRequiredFields("spec/schemas/settlement-bundle-v0.3.schema.json", bundle);
  assertRequiredFields("spec/schemas/settlement-receipt-v0.3.schema.json", bundle.settlement_receipt);
  assertRequiredFields("spec/schemas/action-proposal-v0.3.schema.json", bundle.action.proposal);
  assertRequiredFields("spec/schemas/action-class.schema.json", DEMO_TICKET_COMMENT_CLASS);
  assert.equal(verifyBundle(bundle, { ...trust(), requireSemantics: true }).valid, true);

  const receipt = runtime.rail.exportBundle(summary.action_id, { profile: "receipt" });
  assert.equal(Object.hasOwn(receipt.action, "proposal"), false);
  assert.equal(verifySettlementArtifact(receipt, { ...trust(), allowReceiptProfile: true }).valid, true);

  for (const mutate of [
    (copy) => { copy.action.proposal.recourse_scope.field = "max_amount_minor"; },
    (copy) => { copy.action.proposal.recourse_scope.extra = 1; },
    (copy) => { copy.action.proposal.evidence_plan.parameter_bindings[0].parameter = "missing"; },
    (copy) => { copy.action.proposal.parameters.nested = { a: 1 }; },
    (copy) => { copy.settlement_receipt.proposal_schema_version = "consequence-rail/action-proposal/v0.2"; },
  ]) {
    const copy = deepClone(bundle);
    mutate(copy);
    assert.throws(() => validateSettlementBundle(copy), { code: "BUNDLE_TAMPERED" }, mutate.toString());
  }
  const twoScopes = deepClone(receipt);
  twoScopes.recourse_reservation.max_amount_minor = 1;
  assert.throws(() => validateSettlementBundle(twoScopes), { code: "BUNDLE_TAMPERED" });
});

test("the sidecar advertises registered classes and refuses unregistered ones", async (context) => {
  const runtime = createTicketRuntime();
  const server = createReferenceServer({ runtime });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const known = await (await fetch(`${base}/.well-known/consequence-rail`)).json();
  assert.deepEqual(known.registered_action_types, ["demo.ticket.comment/v1"]);
  assert.ok(known.optional_features.includes("action-classes/v0.3"));

  const proposal = buildTicketProposal(runtime.clock);
  const accepted = await fetch(`${base}/v0/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(proposal),
  });
  assert.equal(accepted.status, 201);
  const refused = await fetch(`${base}/v0/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...proposal, action_type: "other.thing.do/v1", idempotency_key: "other" }),
  });
  assert.equal(refused.status, 422);
  assert.equal((await refused.json()).code, "ACTION_CLASS_UNREGISTERED");
});
