// Lifecycle tests for the consequence-rail module: signature verification,
// proposal validation, the propose -> authorize -> reserve -> permit ->
// execute -> verify -> remediate lifecycle, and connector result binding.
// Split from test/rail.test.js.

import assert from "node:assert/strict";
import test from "node:test";
import { deepClone, digest } from "../src/canonical.js";
import { buildRefundProposal, buildRefundReservation, createDemoRuntime, prepareRefund, runRefundDemo } from "../src/demo.js";
import { evaluatePostcondition } from "../src/postconditions.js";
import { createDemoSigner, demoConnectorTrustedKeys, demoTrustedKeys, signArtifact, verifyArtifact } from "../src/signing.js";
import { verifyBundle, verifyBundleTimeline } from "../src/verify.js";

test("signature verification rejects non-canonical base64url encodings", () => {
  const signer = createDemoSigner();
  const artifact = signArtifact({ safe: true }, signer);
  const canonical = artifact.signature.value;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  artifact.signature.value = `${canonical.slice(0, -1)}${alphabet[alphabet.indexOf(canonical.at(-1)) + 1]}`;
  assert.deepEqual(Buffer.from(artifact.signature.value, "base64url"), Buffer.from(canonical, "base64url"));
  assert.throws(
    () => verifyArtifact(artifact, new Map([[signer.kid, signer.publicKey]])),
    (error) => error.code === "SIGNATURE_INVALID",
  );
});

test("nested proposal fields and prototype postcondition paths fail closed", () => {
  for (const mutate of [
    (proposal) => { proposal.subject.unreviewed = true; },
    (proposal) => { proposal.target.unreviewed = true; },
    (proposal) => { proposal.parameters.unreviewed = true; },
    (proposal) => { proposal.evidence_plan.unreviewed = true; },
    (proposal) => { proposal.postcondition.clauses[0].unreviewed = true; },
    (proposal) => { proposal.postcondition.clauses[0].path = "constructor.name"; },
  ]) {
    const runtime = createDemoRuntime();
    const proposal = buildRefundProposal(runtime.clock);
    mutate(proposal);
    assert.throws(
      () => runtime.rail.propose(proposal),
      (error) => ["SCHEMA_INVALID", "POSTCONDITION_INVALID"].includes(error.code),
    );
    assert.equal(runtime.rail.actions.size, 0);
  }
});

test("unknown ActionProposal fields fail closed", () => {
  const runtime = createDemoRuntime();
  const proposal = buildRefundProposal(runtime.clock);
  proposal.unreviewed_field = true;
  assert.throws(
    () => runtime.rail.propose(proposal),
    (error) => error.code === "SCHEMA_INVALID",
  );
});

test("postcondition operators reject inherited and unknown names", () => {
  for (const op of [...Object.getOwnPropertyNames(Object.prototype), "unknown", ""]) {
    assert.throws(
      () => evaluatePostcondition({
        op: "all",
        clauses: [{ path: "active_refund_count", op, value: 0 }],
      }, { facts: { active_refund_count: 1 } }),
      (error) => error.code === "POSTCONDITION_INVALID",
      `Operator ${op} must be rejected.`,
    );
  }
});

test("postcondition operators reject non-string values without coercion", () => {
  let coercionCalls = 0;
  const coercible = {
    [Symbol.toPrimitive]() {
      coercionCalls += 1;
      return "eq";
    },
  };
  for (const op of [null, undefined, true, false, 1, 1n, [], ["eq"], {}, new String("eq"), Symbol("eq"), coercible]) {
    assert.throws(
      () => evaluatePostcondition({
        op: "all",
        clauses: [{ path: "active_refund_count", op, value: 1 }],
      }, { facts: { active_refund_count: 1 } }),
      (error) => error.code === "POSTCONDITION_INVALID",
    );
  }
  assert.equal(coercionCalls, 0);
});

test("postcondition operators preserve eq gte and lte boolean results", () => {
  for (const [op, actual, expected, satisfied] of [
    ["eq", 1, 1, true],
    ["eq", 1, 0, false],
    ["eq", 1, "1", false],
    ["gte", 2, 1, true],
    ["gte", 1, 1, true],
    ["gte", 0, 1, false],
    ["lte", 0, 1, true],
    ["lte", 1, 1, true],
    ["lte", 2, 1, false],
  ]) {
    const result = evaluatePostcondition({
      op: "all",
      clauses: [{ path: "active_refund_count", op, value: expected }],
    }, { facts: { active_refund_count: actual } });
    assert.deepEqual(result, {
      satisfied,
      evaluations: [{ path: "active_refund_count", operator: op, expected, actual, satisfied }],
    });
  }
});

test("invalid postcondition operators are rejected before action admission", () => {
  for (const op of [...Object.getOwnPropertyNames(Object.prototype), "unknown", "", null, true, 1, ["eq"], {}]) {
    const runtime = createDemoRuntime();
    const proposal = buildRefundProposal(runtime.clock);
    proposal.postcondition.clauses = [{ path: "active_refund_count", op, value: 0 }];
    assert.throws(
      () => runtime.rail.propose(proposal),
      (error) => error.code === "POSTCONDITION_INVALID",
    );
    assert.equal(runtime.rail.actions.size, 0);
    assert.equal(runtime.connector.executeCalls, 0);
    assert.equal(runtime.connector.reserveRecourseCalls, 0);
    assert.equal(runtime.connector.refunds.length, 0);
  }
});

test("expired proposals are rejected before consuming action capacity", () => {
  const runtime = createDemoRuntime();
  const proposal = buildRefundProposal(runtime.clock);
  runtime.clock.advance(120_000);

  assert.throws(
    () => runtime.rail.propose(proposal),
    (error) => error.code === "ACTION_EXPIRED",
  );
  assert.equal(runtime.rail.actions.size, 0);
});

test("proposal duration and amount fields reject unsafe or non-integral numbers", () => {
  const maxDurationSeconds = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);
  for (const [field, value] of [
    ["max_age_seconds", Number.MAX_VALUE],
    ["max_age_seconds", 2 ** 53],
    ["max_age_seconds", maxDurationSeconds + 1],
    ["max_age_seconds", Number.POSITIVE_INFINITY],
    ["max_age_seconds", Number.NaN],
    ["max_age_seconds", 1.5],
    ["max_age_seconds", 0],
    ["amount_minor", 2 ** 53],
    ["amount_minor", Number.NaN],
    ["amount_minor", 12_000.5],
  ]) {
    const runtime = createDemoRuntime();
    const proposal = buildRefundProposal(runtime.clock);
    if (field === "max_age_seconds") {
      proposal.evidence_plan.max_age_seconds = value;
    } else {
      proposal.parameters.amount_minor = value;
    }
    assert.throws(
      () => runtime.rail.propose(proposal),
      (error) => error.code === "SCHEMA_INVALID",
      `${field}=${value} must be rejected.`,
    );
    assert.equal(runtime.rail.actions.size, 0);
  }

  const runtime = createDemoRuntime();
  const proposal = buildRefundProposal(runtime.clock);
  proposal.evidence_plan.max_age_seconds = maxDurationSeconds;
  assert.equal(runtime.rail.propose(proposal).state, "PROPOSED");
});

test("recourse duration and attempt fields reject unsafe or non-integral numbers", () => {
  const maxDurationSeconds = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);
  for (const [field, value] of [
    ["max_attempts", Number.MAX_VALUE],
    ["max_attempts", 2 ** 53],
    ["max_attempts", 0],
    ["max_attempts", 1.5],
    ["max_attempts", Number.NaN],
    ["remedy_window_seconds", Number.MAX_VALUE],
    ["remedy_window_seconds", 2 ** 53],
    ["remedy_window_seconds", maxDurationSeconds + 1],
    ["remedy_window_seconds", -1],
    ["remedy_window_seconds", 0.5],
    ["max_amount_minor", 2 ** 53],
    ["max_amount_minor", -1],
  ]) {
    const runtime = createDemoRuntime();
    const proposal = buildRefundProposal(runtime.clock);
    const proposed = runtime.rail.propose(proposal);
    runtime.rail.authorize(proposed.action_id, {
      allow: true,
      policy_id: "demo-refund-policy/v1",
      policy_digest: digest({ allow: true }),
    });
    const reservation = buildRefundReservation(
      proposed.action_digest,
      proposal,
      runtime.clock,
    );
    reservation[field] = value;
    assert.throws(
      () => runtime.rail.reserveRecourse(proposed.action_id, reservation),
      (error) => error.code === "RECOURSE_INVALID",
      `${field}=${value} must be rejected.`,
    );
    assert.equal(runtime.rail.inspect(proposed.action_id).state, "AUTHORIZED");
    assert.equal(runtime.connector.reserveRecourseCalls, 0);
  }
});

test("clean refund closes with a verified settled receipt", async () => {
  const result = await runRefundDemo();
  assert.equal(result.summary.state, "CLOSED");
  assert.equal(result.summary.outcome, "settled");
  assert.equal(result.summary.execute_calls, 1);
  assert.equal(result.summary.remedy_calls, 0);
  assert.equal(result.summary.bundle_verification, "pass");
});

test("offline bundle timeline verification reuses full bundle integrity and lifecycle semantics", async () => {
  const result = await runRefundDemo();
  const timeline = verifyBundleTimeline(result.bundle, {
    trustedKeys: demoTrustedKeys(),
    trustedConnectorKeys: demoConnectorTrustedKeys(),
  });
  assert.equal(timeline.valid, true);
  assert.equal(timeline.outcome, "settled");
  assert.equal(timeline.event_count, result.bundle.events.length);
  assert.equal(timeline.events.at(-1).to_state, "CLOSED");
  assert.equal(Object.hasOwn(timeline.events[0], "payload"), false);
  const receiptTimeline = verifyBundleTimeline(result.runtime.rail.exportBundle(result.summary.action_id), {
    trustedKeys: demoTrustedKeys(),
    trustedConnectorKeys: demoConnectorTrustedKeys(),
  });
  assert.equal(receiptTimeline.valid, true);
  assert.equal(receiptTimeline.semantics.status, "not_requested");
  const tampered = deepClone(result.bundle);
  tampered.events[1].payload.reason_code = "MUTATED";
  assert.throws(
    () => verifyBundleTimeline(tampered, {
      trustedKeys: demoTrustedKeys(),
      trustedConnectorKeys: demoConnectorTrustedKeys(),
    }),
    (error) => error.code === "BUNDLE_TAMPERED" || error.code === "SEMANTIC_INVALID",
  );
});

test("duplicate refund is detected, reversed and verified", async () => {
  const result = await runRefundDemo({ fault: "duplicate" });
  assert.equal(result.summary.outcome, "compensated");
  assert.equal(result.summary.execute_calls, 1);
  assert.equal(result.summary.remedy_calls, 1);
  assert.equal(result.summary.active_refunds, 1);
});

test("caller-supplied evidence cannot mint a false settled receipt", async () => {
  const runtime = createDemoRuntime();
  const { actionId } = prepareRefund(runtime);
  await runtime.rail.execute(actionId, { fault: "duplicate" });
  const forgedEvidence = {
    schema_version: "consequence-rail/outcome-evidence/v0.1",
    action_digest: runtime.rail.get(actionId).action_digest,
    source: "mock-refund-processor",
    resource: { type: "order", id: "ord_demo_42" },
    observed_at: runtime.clock.now(),
    facts: {
      active_refund_count: 1,
      net_refunded_minor: 12_000,
      currency: "USD",
    },
  };

  await assert.rejects(
    () => runtime.rail.verifyOutcome(actionId, { evidenceOverride: forgedEvidence }),
    (error) => error.code === "SCHEMA_INVALID",
  );
  assert.equal(runtime.rail.inspect(actionId).state, "EXECUTED");
  assert.equal(runtime.rail.get(actionId).receipt, null);

  const observed = await runtime.rail.verifyOutcome(actionId);
  assert.equal(observed.state, "REMEDY_DUE");
  assert.equal(observed.outcome, null);
});

test("recourse is reserved by the connector and cryptographically authenticated", () => {
  const runtime = createDemoRuntime();
  const { actionId } = prepareRefund(runtime);
  const reservation = runtime.rail.get(actionId).reservation;
  assert.equal(runtime.connector.reserveRecourseCalls, 1);
  assert.equal(reservation.connector_commitment.status, "active");
  assert.equal(
    verifyArtifact(
      reservation.connector_commitment,
      demoConnectorTrustedKeys(),
    ).valid,
    true,
  );
});

test("lost response after commit reconciles without re-execution", async () => {
  const result = await runRefundDemo({ fault: "lost-response-after-commit" });
  assert.equal(result.summary.outcome, "settled");
  assert.equal(result.summary.execute_calls, 1);
  assert.equal(result.summary.status_calls, 1);
});

test("lost response before commit confirms no effect without retry", async () => {
  const result = await runRefundDemo({ fault: "lost-response-before-commit" });
  assert.equal(result.summary.state, "FAILED");
  assert.equal(result.summary.outcome, null);
  assert.equal(result.summary.execute_calls, 1);
  assert.equal(result.summary.status_calls, 1);
  assert.equal(result.summary.active_refunds, 0);
  const record = result.runtime.rail.get(result.summary.action_id);
  const token = record.reservation.connector_commitment.reservation_token;
  assert.equal(result.runtime.connector.recourseStatus(token).status, "released");
});

test("direct execution accepts only a bound executed connector result", async () => {
  for (const invalidResult of [
    (key) => ({ status: "executed", external_id: "rf_unrelated", idempotency_key: `${key}:other` }),
    (key) => ({ status: "no_effect", idempotency_key: key }),
  ]) {
    const runtime = createDemoRuntime();
    const { actionId } = prepareRefund(runtime);
    const key = runtime.rail.get(actionId).proposal.idempotency_key;
    runtime.connector.execute = async () => invalidResult(key);

    assert.equal((await runtime.rail.execute(actionId)).state, "UNKNOWN");
    assert.deepEqual(runtime.rail.get(actionId).execution, {
      status: "unknown",
      idempotency_key: key,
      external_id: null,
    });
  }
});

test("execution connector results are immutable rail-owned snapshots", async () => {
  const direct = createDemoRuntime();
  const { actionId: directActionId } = prepareRefund(direct);
  const directKey = direct.rail.get(directActionId).proposal.idempotency_key;
  const directResult = {
    status: "executed",
    external_id: "rf_direct",
    idempotency_key: directKey,
  };
  direct.connector.execute = async () => directResult;
  await direct.rail.execute(directActionId);
  directResult.idempotency_key = "foreign";
  assert.equal(direct.rail.get(directActionId).execution.idempotency_key, directKey);
  assert.equal(Object.isFrozen(direct.rail.get(directActionId).execution), true);

  const reconciled = createDemoRuntime();
  const { actionId: reconciledActionId } = prepareRefund(reconciled);
  await reconciled.rail.execute(reconciledActionId, { fault: "lost-response-after-commit" });
  const reconciledKey = reconciled.rail.get(reconciledActionId).proposal.idempotency_key;
  const statusResult = {
    status: "executed",
    external_id: "rf_reconciled",
    idempotency_key: reconciledKey,
  };
  reconciled.connector.status = async () => statusResult;
  await reconciled.rail.reconcile(reconciledActionId);
  statusResult.idempotency_key = "foreign";
  assert.equal(reconciled.rail.get(reconciledActionId).execution.idempotency_key, reconciledKey);
  assert.equal(Object.isFrozen(reconciled.rail.get(reconciledActionId).execution), true);
});

test("non-canonical reconciliation results map to the boundary error", async () => {
  for (const invalidResult of [
    (key) => Object.defineProperty({ idempotency_key: key }, "status", {
      enumerable: true,
      get() { throw new Error("must not run"); },
    }),
    (key) => new Proxy({ status: "executed", idempotency_key: key }, {}),
  ]) {
    const runtime = createDemoRuntime();
    const { actionId } = prepareRefund(runtime);
    await runtime.rail.execute(actionId, { fault: "lost-response-after-commit" });
    const key = runtime.rail.get(actionId).proposal.idempotency_key;
    runtime.connector.status = async () => invalidResult(key);

    await assert.rejects(
      runtime.rail.reconcile(actionId),
      (error) => error.code === "RECONCILIATION_INVALID",
    );
    assert.equal(runtime.rail.inspect(actionId).state, "UNKNOWN");
  }
});

test("connector result status and idempotency key must be own fields", async () => {
  const runtime = createDemoRuntime();
  const { actionId } = prepareRefund(runtime);
  const key = runtime.rail.get(actionId).proposal.idempotency_key;
  const fields = new Map([
    ["status", Object.getOwnPropertyDescriptor(Object.prototype, "status")],
    ["idempotency_key", Object.getOwnPropertyDescriptor(Object.prototype, "idempotency_key")],
  ]);
  try {
    Object.defineProperties(Object.prototype, {
      status: { configurable: true, value: "executed" },
      idempotency_key: { configurable: true, value: key },
    });
    runtime.connector.execute = async () => ({});

    assert.equal((await runtime.rail.execute(actionId)).state, "UNKNOWN");
    assert.equal(Object.hasOwn(runtime.rail.get(actionId).execution, "status"), true);
    assert.equal(Object.hasOwn(runtime.rail.get(actionId).execution, "idempotency_key"), true);
  } finally {
    for (const [field, descriptor] of fields) {
      if (descriptor) Object.defineProperty(Object.prototype, field, descriptor);
      else Reflect.deleteProperty(Object.prototype, field);
    }
  }
});

test("connector result snapshots ignore inherited optional fields", async () => {
  const runtime = createDemoRuntime();
  const { actionId } = prepareRefund(runtime);
  const key = runtime.rail.get(actionId).proposal.idempotency_key;
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, "external_id");
  try {
    Object.defineProperty(Object.prototype, "external_id", {
      configurable: true,
      value: "rf_inherited",
    });
    runtime.connector.execute = async () => ({
      status: "executed",
      idempotency_key: key,
    });

    assert.equal((await runtime.rail.execute(actionId)).state, "EXECUTED");
    const execution = runtime.rail.get(actionId).execution;
    assert.equal(Object.getPrototypeOf(execution), null);
    assert.equal(execution.external_id, undefined);
    const event = runtime.rail.eventStore.list(actionId).find(
      (item) => item.payload.reason_code === "CONNECTOR_EXECUTED",
    );
    assert.equal(event.payload.details_digest, digest({
      external_reference_digest: digest(key),
    }));
  } finally {
    if (previous) Object.defineProperty(Object.prototype, "external_id", previous);
    else Reflect.deleteProperty(Object.prototype, "external_id");
  }
});

test("reconciliation rejects status for another idempotency key", async () => {
  const runtime = createDemoRuntime();
  const { actionId } = prepareRefund(runtime);
  assert.equal(
    (await runtime.rail.execute(actionId, {
      fault: "lost-response-after-commit",
    })).state,
    "UNKNOWN",
  );
  runtime.connector.status = async () => ({
    status: "executed",
    external_id: "rf_unrelated",
    idempotency_key: "unrelated",
  });

  await assert.rejects(
    runtime.rail.reconcile(actionId),
    (error) => error.code === "RECONCILIATION_INVALID",
  );
  assert.equal(runtime.rail.inspect(actionId).state, "UNKNOWN");
});

test("untyped execution errors reconcile without releasing recourse or re-executing", async () => {
  const runtime = createDemoRuntime();
  const { actionId } = prepareRefund(runtime);
  const execute = runtime.connector.execute.bind(runtime.connector);
  const failure = Proxy.revocable({}, {});
  failure.revoke();
  runtime.connector.execute = async (...args) => {
    await execute(...args);
    throw failure.proxy;
  };

  assert.equal((await runtime.rail.execute(actionId)).state, "UNKNOWN");
  const token = runtime.rail.get(actionId).reservation.connector_commitment.reservation_token;
  assert.equal(runtime.connector.recourseStatus(token).status, "active");
  assert.equal((await runtime.rail.reconcile(actionId)).state, "EXECUTED");
  assert.equal(runtime.connector.executeCalls, 1);
});

test("stale evidence closes as disputed", async () => {
  const result = await runRefundDemo({ fault: "stale-evidence" });
  assert.equal(result.summary.outcome, "disputed");
  assert.equal(result.summary.bundle_verification, "pass");
});

test("connector observation exceptions fail closed before remedy and cannot be retried", async () => {
  const runtime = createDemoRuntime();
  const { actionId } = prepareRefund(runtime);
  await runtime.rail.execute(actionId);
  runtime.connector.observe = async () => {
    throw new Error("connector timeout detail must not escape");
  };

  const result = await runtime.rail.verifyOutcome(actionId);
  assert.equal(result.state, "CLOSED");
  assert.equal(result.outcome, "disputed");
  const events = runtime.rail.exportBundle(actionId, { profile: "receipt" }).events;
  assert.equal(runtime.rail.get(actionId).state, "CLOSED");
  assert.equal(runtime.rail.get(actionId).receipt.outcome, "disputed");
  assert.equal(runtime.rail.get(actionId).receipt.limitations.some((item) => item.includes("truth")), true);
  const rejection = events.find((event) => event.event_type === "EVIDENCE_REJECTED");
  assert.equal(rejection?.payload.code, "EVIDENCE_UNAVAILABLE");
  assert.equal(JSON.stringify(events).includes("connector timeout detail"), false);
  await assert.rejects(
    () => runtime.rail.verifyOutcome(actionId),
    (error) => error.code === "ILLEGAL_TRANSITION",
  );
});

test("timeout-like connector failures after a breach fail closed during remedy verification", async () => {
  const runtime = createDemoRuntime();
  const { actionId } = prepareRefund(runtime);
  await runtime.rail.execute(actionId, { fault: "duplicate" });
  const breached = await runtime.rail.verifyOutcome(actionId);
  assert.equal(breached.state, "REMEDY_DUE");
  runtime.connector.observe = async () => Promise.reject(new Error("timeout"));

  const result = await runtime.rail.remediate(actionId);
  assert.equal(result.state, "CLOSED");
  assert.equal(result.outcome, "disputed");
  assert.equal(runtime.rail.get(actionId).receipt.outcome, "disputed");
  await assert.rejects(
    () => runtime.rail.remediate(actionId),
    (error) => error.code === "ILLEGAL_TRANSITION",
  );
});

test("unknown final recourse refuses receipt generation and preserves review-required state", async () => {
  const runtime = createDemoRuntime();
  const { actionId } = prepareRefund(runtime);
  await runtime.rail.execute(actionId, { fault: "duplicate" });
  await runtime.rail.verifyOutcome(actionId);
  assert.equal(runtime.rail.get(actionId).state, "REMEDY_DUE");
  const expectedToken = runtime.rail.get(actionId).reservation.connector_commitment.reservation_token;
  const evidenceCount = runtime.rail.get(actionId).evidence.length;
  runtime.connector.recourseReservations.clear();
  await assert.rejects(
    () => runtime.rail.remediate(actionId),
    (error) => error.code === "RECEIPT_UNSUPPORTED",
  );
  const record = runtime.rail.get(actionId);
  assert.equal(record.state, "REVIEW_REQUIRED");
  assert.equal(record.receipt, null);
  assert.equal(record.reservation.connector_commitment.reservation_token, expectedToken);
  assert.equal(record.evidence.length, evidenceCount);
  const finalized = runtime.rail.eventStore
    .list(actionId)
    .filter((event) => event.event_type === "RECOURSE_FINALIZED");
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].payload.status, "unknown");
  assert.throws(
    () => runtime.rail.exportBundle(actionId),
    (error) => error.code === "RECEIPT_NOT_AVAILABLE",
  );
});

test("a disputed receipt with determined recourse verifies under both bundle profiles", async () => {
  const runtime = createDemoRuntime();
  const { actionId } = prepareRefund(runtime);
  await runtime.rail.execute(actionId, { fault: "duplicate" });
  await runtime.rail.verifyOutcome(actionId);
  runtime.connector.observe = async () => Promise.reject(new Error("timeout"));
  const result = await runtime.rail.remediate(actionId);
  assert.equal(result.state, "CLOSED");
  assert.equal(runtime.rail.get(actionId).receipt.outcome, "disputed");
  assert.equal(runtime.rail.get(actionId).receipt.recourse_final_status, "consumed");
  const receiptVerification = verifyBundle(runtime.rail.exportBundle(actionId, { profile: "receipt" }), {
    trustedKeys: demoTrustedKeys(),
    trustedConnectorKeys: demoConnectorTrustedKeys(),
    requireSemantics: false,
  });
  assert.equal(receiptVerification.outcome, "disputed");
  const auditVerification = verifyBundle(runtime.rail.exportBundle(actionId, { profile: "audit" }), {
    trustedKeys: demoTrustedKeys(),
    trustedConnectorKeys: demoConnectorTrustedKeys(),
  });
  assert.equal(auditVerification.outcome, "disputed");
  const timeline = verifyBundleTimeline(runtime.rail.exportBundle(actionId, { profile: "audit" }), {
    trustedKeys: demoTrustedKeys(),
    trustedConnectorKeys: demoConnectorTrustedKeys(),
  });
  assert.equal(timeline.outcome, "disputed");
});

test("bundle verification rejects altered recourse status and false success outcomes", async () => {
  const runtime = createDemoRuntime();
  const { actionId } = prepareRefund(runtime);
  await runtime.rail.execute(actionId, { fault: "duplicate" });
  await runtime.rail.verifyOutcome(actionId);
  runtime.connector.observe = async () => Promise.reject(new Error("timeout"));
  await runtime.rail.remediate(actionId);
  const options = {
    trustedKeys: demoTrustedKeys(),
    trustedConnectorKeys: demoConnectorTrustedKeys(),
  };
  const unknownStatus = deepClone(runtime.rail.exportBundle(actionId, { profile: "audit" }));
  unknownStatus.settlement_receipt.recourse_final_status = "unknown";
  assert.throws(
    () => verifyBundle(unknownStatus, options),
    (error) => error.code === "BUNDLE_TAMPERED",
  );
  const falseSettled = deepClone(runtime.rail.exportBundle(actionId, { profile: "audit" }));
  falseSettled.settlement_receipt.outcome = "settled";
  assert.throws(() => verifyBundle(falseSettled, options));
  const mismatchedHistory = deepClone(runtime.rail.exportBundle(actionId, { profile: "audit" }));
  mismatchedHistory.events.find(
    (event) => event.event_type === "RECOURSE_FINALIZED",
  ).payload.status = "released";
  assert.throws(() => verifyBundle(mismatchedHistory, options));
});

test("a failed bounded remedy closes as disputed without retry", async () => {
  const result = await runRefundDemo({ fault: "remedy-failure" });
  assert.equal(result.summary.outcome, "disputed");
  assert.equal(result.summary.remedy_calls, 1);
  assert.equal(result.summary.active_refunds, 2);
});

test("direct remediation accepts only a bound remedy result", async () => {
  for (const invalidResult of [
    (key) => ({ status: "remediated", external_id: "rf_unrelated", idempotency_key: `${key}:other` }),
    (key) => ({ status: "executed", idempotency_key: key }),
  ]) {
    const runtime = createDemoRuntime();
    const { actionId } = prepareRefund(runtime);
    await runtime.rail.execute(actionId, { fault: "duplicate" });
    await runtime.rail.verifyOutcome(actionId);
    const key = runtime.rail.get(actionId).remedy_idempotency_key;
    runtime.connector.remediate = async () => invalidResult(key);

    assert.equal((await runtime.rail.remediate(actionId)).state, "REMEDY_UNKNOWN");
    assert.equal(runtime.rail.get(actionId).remedy_result.idempotency_key, key);
  }
});

test("remedy connector results are immutable rail-owned snapshots", async () => {
  const direct = createDemoRuntime();
  const { actionId: directActionId } = prepareRefund(direct);
  await direct.rail.execute(directActionId, { fault: "duplicate" });
  await direct.rail.verifyOutcome(directActionId);
  const remediate = direct.connector.remediate.bind(direct.connector);
  let directResult;
  direct.connector.remediate = async (...args) => {
    directResult = await remediate(...args);
    return directResult;
  };
  await direct.rail.remediate(directActionId);
  const directKey = direct.rail.get(directActionId).remedy_idempotency_key;
  directResult.idempotency_key = "foreign";
  assert.equal(direct.rail.get(directActionId).remedy_result.idempotency_key, directKey);
  assert.equal(Object.isFrozen(direct.rail.get(directActionId).remedy_result), true);

  const reconciled = createDemoRuntime();
  const { actionId: reconciledActionId } = prepareRefund(reconciled);
  await reconciled.rail.execute(reconciledActionId, { fault: "duplicate" });
  await reconciled.rail.verifyOutcome(reconciledActionId);
  await reconciled.rail.remediate(reconciledActionId, {
    fault: "remedy-lost-response-after-commit",
  });
  const reconciledKey = reconciled.rail.get(reconciledActionId).remedy_idempotency_key;
  const statusResult = {
    status: "remediated",
    external_id: "rf_reconciled",
    idempotency_key: reconciledKey,
  };
  reconciled.connector.remedyStatus = async () => statusResult;
  await reconciled.rail.reconcileRemedy(reconciledActionId);
  statusResult.idempotency_key = "foreign";
  assert.equal(reconciled.rail.get(reconciledActionId).remedy_result.idempotency_key, reconciledKey);
  assert.equal(Object.isFrozen(reconciled.rail.get(reconciledActionId).remedy_result), true);
});

test("lost remedy response after commit reconciles without retry", async () => {
  const result = await runRefundDemo({
    fault: "remedy-lost-response-after-commit",
  });
  assert.equal(result.summary.outcome, "compensated");
  assert.equal(result.summary.remedy_calls, 1);
  assert.equal(result.summary.remedy_status_calls, 1);
  assert.equal(result.summary.active_refunds, 1);
});

test("remedy reconciliation rejects status for another idempotency key", async () => {
  const runtime = createDemoRuntime();
  const { actionId } = prepareRefund(runtime);
  await runtime.rail.execute(actionId, { fault: "duplicate" });
  await runtime.rail.verifyOutcome(actionId);
  assert.equal(
    (await runtime.rail.remediate(actionId, {
      fault: "remedy-lost-response-after-commit",
    })).state,
    "REMEDY_UNKNOWN",
  );
  runtime.connector.remedyStatus = async () => ({
    status: "remediated",
    external_id: "rf_unrelated",
    idempotency_key: "unrelated",
  });

  await assert.rejects(
    runtime.rail.reconcileRemedy(actionId),
    (error) => error.code === "RECONCILIATION_INVALID",
  );
  assert.equal(runtime.rail.inspect(actionId).state, "REMEDY_UNKNOWN");
});

test("lost remedy response before commit closes disputed without retry", async () => {
  const result = await runRefundDemo({
    fault: "remedy-lost-response-before-commit",
  });
  assert.equal(result.summary.outcome, "disputed");
  assert.equal(result.summary.remedy_calls, 1);
  assert.equal(result.summary.remedy_status_calls, 1);
  assert.equal(result.summary.active_refunds, 2);
});

test("untyped remedy errors reconcile without repeating remediation", async () => {
  const runtime = createDemoRuntime();
  const { actionId } = prepareRefund(runtime);
  await runtime.rail.execute(actionId, { fault: "duplicate" });
  await runtime.rail.verifyOutcome(actionId);
  const remediate = runtime.connector.remediate.bind(runtime.connector);
  const failure = Proxy.revocable({}, {});
  failure.revoke();
  runtime.connector.remediate = async (...args) => {
    await remediate(...args);
    throw failure.proxy;
  };

  assert.equal((await runtime.rail.remediate(actionId)).state, "REMEDY_UNKNOWN");
  const reconciled = await runtime.rail.reconcileRemedy(actionId);
  assert.equal(reconciled.outcome, "compensated");
  assert.equal(runtime.connector.remedyCalls, 1);
});

test("stale post-remedy evidence closes disputed", async () => {
  const result = await runRefundDemo({
    fault: "post-remedy-stale-evidence",
  });
  assert.equal(result.summary.outcome, "disputed");
  assert.equal(result.summary.remedy_calls, 1);
  assert.equal(result.summary.active_refunds, 1);
});

test("unsatisfied post-remedy evidence closes disputed", async () => {
  const result = await runRefundDemo({
    fault: "post-remedy-false-evidence",
  });
  assert.equal(result.summary.outcome, "disputed");
  assert.equal(result.summary.remedy_calls, 1);
});

test("permit replay is rejected and connector executes once", async () => {
  const result = await runRefundDemo({ fault: "permit-replay" });
  assert.equal(result.summary.expected_rejection.code, "PERMIT_USED");
  assert.equal(result.summary.execute_calls, 1);
});

test("mutating an authorized action is rejected before side effects", async () => {
  const result = await runRefundDemo({ fault: "action-mutation" });
  assert.equal(result.summary.expected_rejection.code, "DIGEST_MISMATCH");
  assert.equal(result.summary.execute_calls, 0);
  assert.equal(result.summary.state, "PERMITTED");
});

test("concurrent execution attempts consume a permit once", async () => {
  const runtime = createDemoRuntime();
  const { actionId } = prepareRefund(runtime);
  const results = await Promise.allSettled([
    runtime.rail.execute(actionId),
    runtime.rail.execute(actionId),
  ]);
  assert.equal(runtime.connector.executeCalls, 1);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  const rejected = results.find((item) => item.status === "rejected");
  assert.equal(rejected.reason.code, "PERMIT_USED");
});
