// Mid-flight control over a multi-step agent plan, on the synthetic ticket
// connector. Three steps each post one comment. Two complete and are held
// with their recourse still reserved; the third is permitted when the plan
// is halted, so it is revoked and can no longer execute. Unwinding then
// deletes the two posted comments in reverse order, verifying each undo
// before the next.

import { digest } from "./canonical.js";
import { RailError } from "./errors.js";
import { buildTicketProposal, buildTicketReservation, createTicketRuntime } from "./ticket-demo.js";
import { demoConnectorTrustedKeys, demoTrustedKeys } from "./signing.js";
import { verifyBundle } from "./verify.js";

export const PLAN_DEMO_MODES = ["unwind", "commit"];
export const PLAN_DEMO_ID = "plan_support_followup";
const TICKETS = ["tkt_plan_1", "tkt_plan_2", "tkt_plan_3"];
const UNWIND_POSTCONDITION = Object.freeze({
  op: "all",
  clauses: [{ path: "comment_count", op: "eq", value: 0 }],
});

export function buildPlanStepProposal(clock, step, ticketId = TICKETS[step - 1]) {
  const proposal = buildTicketProposal(clock);
  proposal.target.resource_id = ticketId;
  proposal.idempotency_key = `comment:${ticketId}:plan`;
  proposal.parameters.visibility = "internal";
  proposal.parameters.body = `Plan step ${step}: follow-up recorded.`;
  proposal.plan = { plan_id: PLAN_DEMO_ID, step, unwind_postcondition: structuredClone(UNWIND_POSTCONDITION) };
  return proposal;
}

/** Propose, authorize, reserve and permit one step; optionally run it. */
export async function startPlanStep(runtime, step, { run = true } = {}) {
  const { rail, clock } = runtime;
  const proposal = buildPlanStepProposal(clock, step);
  const proposed = rail.propose(proposal);
  rail.authorize(proposed.action_id, {
    allow: true,
    policy_id: "demo-plan-policy/v1",
    policy_digest: digest({ plan: PLAN_DEMO_ID, max_steps: 3 }),
  });
  rail.reserveRecourse(proposed.action_id, buildTicketReservation(proposed.action_digest, proposal));
  rail.issuePermit(proposed.action_id);
  if (run) {
    await rail.execute(proposed.action_id);
    await rail.verifyOutcome(proposed.action_id);
  }
  return proposed.action_id;
}

export async function runPlanDemo({ mode = "unwind" } = {}) {
  if (!PLAN_DEMO_MODES.includes(mode)) {
    throw new RailError("SCENARIO_INVALID", `Unknown plan demo mode: ${mode}. Expected unwind or commit.`);
  }
  const runtime = createTicketRuntime();
  const { rail, connector } = runtime;
  rail.openPlan({ plan_id: PLAN_DEMO_ID });
  const first = await startPlanStep(runtime, 1);
  const second = await startPlanStep(runtime, 2);
  const third = await startPlanStep(runtime, 3, { run: false });
  const commentsBeforeHalt = connector.comments.filter((item) => item.status === "active").length;

  let killSwitch = null;
  let plan;
  if (mode === "unwind") {
    rail.haltPlan(PLAN_DEMO_ID, { reason: "OPERATOR_HALT" });
    try {
      await rail.execute(third);
    } catch (error) {
      killSwitch = error.code;
    }
    plan = await rail.unwindPlan(PLAN_DEMO_ID);
  } else {
    await rail.execute(third);
    await rail.verifyOutcome(third);
    plan = rail.commitPlan(PLAN_DEMO_ID);
  }

  const verification = [first, second, third]
    .filter((actionId) => rail.inspect(actionId).outcome)
    .map((actionId) => verifyBundle(rail.exportBundle(actionId, { profile: "audit" }), {
      trustedKeys: demoTrustedKeys(),
      trustedConnectorKeys: demoConnectorTrustedKeys(),
      requireSemantics: true,
    }).valid);
  const unwindOrder = rail.planEvents(PLAN_DEMO_ID)
    .filter((event) => event.event_type === "PLAN_STEP_UNWOUND")
    .map((event) => event.payload.step);

  const summary = {
    scenario: "synthetic-plan",
    mode,
    plan_id: PLAN_DEMO_ID,
    plan_state: plan.state,
    steps: plan.steps.map(({ step, state, outcome }) => ({ step, state, outcome })),
    comments_before_halt: commentsBeforeHalt,
    active_comments: connector.comments.filter((item) => item.status === "active").length,
    kill_switch: killSwitch,
    unwind_order: unwindOrder,
    execute_calls: connector.executeCalls,
    remedy_calls: connector.remedyCalls,
    bundle_verification: verification.length > 0 && verification.every(Boolean) ? "pass" : "fail",
  };
  return { summary, runtime };
}
