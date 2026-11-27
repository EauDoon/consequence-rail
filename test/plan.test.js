import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { validateSettlementBundle } from "../src/bundle-validation.js";
import { deepClone } from "../src/canonical.js";
import { PLAN_DEMO_ID, buildPlanStepProposal, runPlanDemo, startPlanStep } from "../src/plan-demo.js";
import { assertRequiredFields, repoPath } from "../src/rail-test-helpers.js";
import { demoConnectorTrustedKeys, demoTrustedKeys } from "../src/signing.js";
import { createTicketRuntime } from "../src/ticket-demo.js";
import { verifyBundle } from "../src/verify.js";

const verify = (bundle) => verifyBundle(bundle, {
  trustedKeys: demoTrustedKeys(),
  trustedConnectorKeys: demoConnectorTrustedKeys(),
  requireSemantics: true,
});

function planRuntime() {
  const runtime = createTicketRuntime();
  runtime.rail.openPlan({ plan_id: PLAN_DEMO_ID });
  return runtime;
}

test("halting a plan revokes waiting steps and unwinding undoes held steps last to first", async () => {
  const { summary, runtime } = await runPlanDemo({ mode: "unwind" });
  assert.equal(summary.plan_state, "unwound");
  assert.equal(summary.kill_switch, "PLAN_HALTED");
  assert.deepEqual(summary.unwind_order, [2, 1]);
  assert.deepEqual(summary.steps.map((step) => step.outcome), ["compensated", "compensated", null]);
  assert.equal(summary.steps[2].state, "REVOKED");
  assert.equal(summary.comments_before_halt, 2);
  assert.equal(summary.active_comments, 0);
  assert.equal(summary.execute_calls, 2);
  assert.equal(summary.bundle_verification, "pass");

  const { rail, clock } = runtime;
  assert.throws(() => rail.propose(buildPlanStepProposal(clock, 4, "tkt_plan_4")), { code: "PLAN_CLOSED" });
  assert.throws(() => rail.commitPlan(PLAN_DEMO_ID), { code: "PLAN_CLOSED" });
  const [firstStep] = rail.inspectPlan(PLAN_DEMO_ID).steps;
  const bundle = rail.exportBundle(firstStep.action_id, { profile: "audit" });
  assertRequiredFields("spec/schemas/action-proposal-v0.3.schema.json", bundle.action.proposal);
  assert.deepEqual(bundle.outcome_evidence.map((item) => item.phase ?? "initial"), ["initial", "post-unwind"]);
  const transitions = bundle.events
    .filter((event) => event.event_type === "STATE_TRANSITION")
    .map((event) => event.payload.to_state);
  assert.deepEqual(transitions.slice(-6), ["SATISFIED", "UNWIND_DUE", "REMEDIATING", "REMEDY_VERIFYING", "REMEDIATED", "CLOSED"]);
  const events = rail.planEvents(PLAN_DEMO_ID).map((event) => event.event_type);
  assert.deepEqual(events, [
    "PLAN_OPENED", "PLAN_STEP_ADDED", "PLAN_STEP_ADDED", "PLAN_STEP_ADDED", "PLAN_HALTED",
    "PLAN_UNWIND_STARTED", "PLAN_STEP_UNWOUND", "PLAN_STEP_UNWOUND", "PLAN_UNWOUND",
  ]);
});

test("committing keeps every effect and settles held steps", async () => {
  const { summary } = await runPlanDemo({ mode: "commit" });
  assert.equal(summary.plan_state, "committed");
  assert.deepEqual(summary.steps.map((step) => step.outcome), ["settled", "settled", "settled"]);
  assert.equal(summary.active_comments, 3);
  assert.equal(summary.bundle_verification, "pass");
});

test("a held step has no receipt until the plan ends", async () => {
  const runtime = planRuntime();
  const actionId = await startPlanStep(runtime, 1);
  const view = runtime.rail.inspect(actionId);
  assert.equal(view.state, "SATISFIED");
  assert.equal(view.plan_held, true);
  assert.equal(view.outcome, null);
  assert.throws(() => runtime.rail.exportBundle(actionId, { profile: "audit" }));
  assert.equal(runtime.connector.recourseStatus(
    runtime.rail.actions.get(actionId).reservation.connector_commitment.reservation_token,
  ).status, "active");
});

test("an undo that does not verify stops the unwind and leaves earlier steps held", async () => {
  const runtime = planRuntime();
  const first = await startPlanStep(runtime, 1);
  const second = await startPlanStep(runtime, 2);
  const remediate = runtime.connector.remediate.bind(runtime.connector);
  runtime.connector.remediate = (proposal, reservation, key) =>
    remediate(proposal, reservation, key, proposal.plan.step === 2 ? "remedy-failure" : "none");
  const plan = await runtime.rail.unwindPlan(PLAN_DEMO_ID);
  assert.equal(plan.state, "unwind_failed");
  assert.deepEqual(plan.steps.map((step) => [step.state, step.outcome, step.held]), [
    ["SATISFIED", null, true],
    ["CLOSED", "disputed", false],
  ]);
  assert.equal(verify(runtime.rail.exportBundle(second, { profile: "audit" })).valid, true);
  const committed = runtime.rail.commitPlan(PLAN_DEMO_ID);
  assert.equal(committed.state, "committed");
  assert.equal(runtime.rail.inspect(first).outcome, "settled");
  assert.equal(verify(runtime.rail.exportBundle(first, { profile: "audit" })).valid, true);
});

test("plan membership and the kill switch are enforced at every step", async () => {
  const runtime = createTicketRuntime();
  const { rail, clock } = runtime;
  assert.throws(() => rail.propose(buildPlanStepProposal(clock, 1)), { code: "PLAN_NOT_FOUND" });
  rail.openPlan({ plan_id: PLAN_DEMO_ID });
  assert.throws(() => rail.openPlan({ plan_id: PLAN_DEMO_ID }), { code: "PLAN_EXISTS" });
  assert.throws(() => rail.openPlan({ plan_id: "not a plan" }), { code: "SCHEMA_INVALID" });
  assert.throws(() => rail.propose(buildPlanStepProposal(clock, 2)), { code: "PLAN_STEP_INVALID" });
  const bad = buildPlanStepProposal(clock, 1);
  bad.plan.extra = true;
  assert.throws(() => rail.propose(bad), { code: "SCHEMA_INVALID" });

  const proposed = rail.propose(buildPlanStepProposal(clock, 1));
  const executed = await startPlanStep(runtime, 2, { run: false });
  await rail.execute(executed);
  await assert.rejects(() => rail.unwindPlan(PLAN_DEMO_ID), { code: "PLAN_BUSY" });
  assert.equal(rail.inspectPlan(PLAN_DEMO_ID).state, "halted");
  assert.throws(
    () => rail.authorize(proposed.action_id, { allow: true, policy_id: "p", policy_digest: "A".repeat(43) }),
    { code: "PLAN_HALTED" },
  );
  await rail.verifyOutcome(executed);
  assert.equal(rail.inspect(executed).plan_held, true, "a step that was in flight is held for the unwind");
  const plan = await rail.unwindPlan(PLAN_DEMO_ID);
  assert.equal(plan.state, "unwound");
  assert.deepEqual(plan.steps.map((step) => step.state), ["PROPOSED", "CLOSED"]);
});

test("offline validation checks the plan reference in a v0.3 proposal", async () => {
  const { runtime } = await runPlanDemo({ mode: "commit" });
  const [step] = runtime.rail.inspectPlan(PLAN_DEMO_ID).steps;
  const bundle = runtime.rail.exportBundle(step.action_id, { profile: "audit" });
  for (const mutate of [
    (copy) => { copy.action.proposal.plan.step = 0; },
    (copy) => { copy.action.proposal.plan.plan_id = "x"; },
    (copy) => { copy.action.proposal.plan.extra = 1; },
    (copy) => { copy.action.proposal.plan.unwind_postcondition = { op: "any", clauses: [] }; },
  ]) {
    const copy = deepClone(bundle);
    mutate(copy);
    assert.throws(() => validateSettlementBundle(copy), { code: "BUNDLE_TAMPERED" }, mutate.toString());
  }
});

test("crctl demo plan runs both modes", () => {
  for (const [args, state] of [[[], "unwound"], [["--commit"], "committed"]]) {
    const result = spawnSync(process.execPath, [repoPath("cmd", "crctl.js"), "demo", "plan", ...args, "--json"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).plan_state, state);
  }
});
