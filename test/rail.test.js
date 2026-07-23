import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson, deepClone, digest } from "../src/canonical.js";
import {
  buildRefundProposal,
  buildRefundReservation,
  createDemoRuntime,
  prepareRefund,
  runRefundDemo,
} from "../src/demo.js";
import { createReferenceServer } from "../src/http-server.js";
import {
  createDemoSigner,
  demoConnectorTrustedKeys,
  demoTrustedKeys,
  signArtifact,
  verifyArtifact,
} from "../src/signing.js";
import { verifyBundle } from "../src/verify.js";

test("canonical action digest is independent of object key order", () => {
  const left = {
    alpha: 1,
    beta: {
      first: true,
      second: "value",
    },
  };
  const right = {
    beta: {
      second: "value",
      first: true,
    },
    alpha: 1,
  };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(digest(left), digest(right));
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

test("clean refund closes with a verified settled receipt", async () => {
  const result = await runRefundDemo();
  assert.equal(result.summary.state, "CLOSED");
  assert.equal(result.summary.outcome, "settled");
  assert.equal(result.summary.execute_calls, 1);
  assert.equal(result.summary.remedy_calls, 0);
  assert.equal(result.summary.bundle_verification, "pass");
});

test("duplicate refund is detected, reversed and verified", async () => {
  const result = await runRefundDemo({ fault: "duplicate" });
  assert.equal(result.summary.outcome, "compensated");
  assert.equal(result.summary.execute_calls, 1);
  assert.equal(result.summary.remedy_calls, 1);
  assert.equal(result.summary.active_refunds, 1);
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

test("stale evidence closes as disputed", async () => {
  const result = await runRefundDemo({ fault: "stale-evidence" });
  assert.equal(result.summary.outcome, "disputed");
  assert.equal(result.summary.bundle_verification, "pass");
});

test("a failed bounded remedy closes as disputed without retry", async () => {
  const result = await runRefundDemo({ fault: "remedy-failure" });
  assert.equal(result.summary.outcome, "disputed");
  assert.equal(result.summary.remedy_calls, 1);
  assert.equal(result.summary.active_refunds, 2);
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

test("lost remedy response before commit closes disputed without retry", async () => {
  const result = await runRefundDemo({
    fault: "remedy-lost-response-before-commit",
  });
  assert.equal(result.summary.outcome, "disputed");
  assert.equal(result.summary.remedy_calls, 1);
  assert.equal(result.summary.remedy_status_calls, 1);
  assert.equal(result.summary.active_refunds, 2);
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

test("bundle verification rejects an untrusted embedded key", async () => {
  const result = await runRefundDemo();
  assert.throws(
    () => verifyBundle(result.bundle),
    (error) => error.code === "UNTRUSTED_KEY",
  );
});

test("bundle verification separately requires connector trust", async () => {
  const result = await runRefundDemo();
  assert.throws(
    () =>
      verifyBundle(result.bundle, {
        trustedKeys: demoTrustedKeys(),
        trustedConnectorKeys: new Map(),
      }),
    (error) => error.code === "UNTRUSTED_KEY",
  );
});

test("event mutation is detected", async () => {
  const result = await runRefundDemo();
  const tampered = deepClone(result.bundle);
  tampered.events[0].payload.action_type = "tampered";
  assert.throws(
    () =>
      verifyBundle(tampered, {
        trustedKeys: demoTrustedKeys(),
        trustedConnectorKeys: demoConnectorTrustedKeys(),
      }),
    (error) => error.code === "BUNDLE_TAMPERED",
  );
});

test("event reordering is detected", async () => {
  const result = await runRefundDemo();
  const tampered = deepClone(result.bundle);
  [tampered.events[1], tampered.events[2]] = [tampered.events[2], tampered.events[1]];
  assert.throws(
    () =>
      verifyBundle(tampered, {
        trustedKeys: demoTrustedKeys(),
        trustedConnectorKeys: demoConnectorTrustedKeys(),
      }),
    (error) => error.code === "BUNDLE_TAMPERED",
  );
});

test("receipt signature tampering is detected", async () => {
  const result = await runRefundDemo();
  const tampered = deepClone(result.bundle);
  tampered.settlement_receipt.outcome = "disputed";
  assert.throws(
    () =>
      verifyBundle(tampered, {
        trustedKeys: demoTrustedKeys(),
        trustedConnectorKeys: demoConnectorTrustedKeys(),
      }),
    (error) => error.code === "SIGNATURE_INVALID",
  );
});

test("inspection redacts raw resource identifiers and parameters", () => {
  const runtime = createDemoRuntime();
  const proposal = buildRefundProposal(runtime.clock);
  const proposed = runtime.rail.propose(proposal);
  const serialized = JSON.stringify(proposed);
  assert.equal(serialized.includes(proposal.target.resource_id), false);
  assert.equal(serialized.includes('"amount_minor"'), false);
  assert.equal(typeof proposed.resource.id_digest, "string");
});

test("settlement receipt contains bounded technical claims", async () => {
  const result = await runRefundDemo();
  const serialized = JSON.stringify(result.bundle.settlement_receipt).toLowerCase();
  for (const prohibited of ["legally enforceable", "insurance coverage", "guaranteed recovery"]) {
    assert.equal(serialized.includes(prohibited), false);
  }
  assert.match(
    result.bundle.settlement_receipt.technical_claim,
    /configured postcondition/,
  );
});

test("receipt bundle profile omits proposal and raw evidence", async () => {
  const result = await runRefundDemo();
  const receiptBundle = result.runtime.rail.exportBundle(result.summary.action_id);
  assert.equal(receiptBundle.profile, "receipt");
  assert.equal("proposal" in receiptBundle.action, false);
  assert.equal(receiptBundle.outcome_evidence.length, 0);
  const verification = verifyBundle(receiptBundle, {
    trustedKeys: demoTrustedKeys(),
    trustedConnectorKeys: demoConnectorTrustedKeys(),
    requireSemantics: false,
  });
  assert.equal(verification.integrity.valid, true);
  assert.equal(verification.semantics.status, "not_requested");
  assert.throws(
    () =>
      verifyBundle(receiptBundle, {
        trustedKeys: demoTrustedKeys(),
        trustedConnectorKeys: demoConnectorTrustedKeys(),
        requireSemantics: true,
      }),
    (error) => error.code === "SEMANTIC_INVALID",
  );
});

test("semantic verification rejects a trusted but contradictory bundle", async () => {
  const result = await runRefundDemo();
  const contradictory = deepClone(result.bundle);
  const signer = createDemoSigner();
  const changedEvidence = signArtifact({
    ...contradictory.outcome_evidence[0],
    evaluation: {
      ...contradictory.outcome_evidence[0].evaluation,
      satisfied: false,
    },
  }, signer);
  contradictory.outcome_evidence[0] = changedEvidence;
  contradictory.evidence_manifest[0] = digest(changedEvidence);
  contradictory.settlement_receipt = signArtifact({
    ...contradictory.settlement_receipt,
    evidence_digests: contradictory.evidence_manifest,
  }, signer);

  const integrityOnly = verifyBundle(contradictory, {
    trustedKeys: demoTrustedKeys(),
    trustedConnectorKeys: demoConnectorTrustedKeys(),
    requireSemantics: false,
  });
  assert.equal(integrityOnly.integrity.valid, true);
  assert.throws(
    () =>
      verifyBundle(contradictory, {
        trustedKeys: demoTrustedKeys(),
        trustedConnectorKeys: demoConnectorTrustedKeys(),
        requireSemantics: true,
      }),
    (error) => error.code === "SEMANTIC_INVALID",
  );
});

test("semantic verification binds every signed event to the bundle action", async () => {
  const result = await runRefundDemo();
  const contradictory = deepClone(result.bundle);
  const signer = createDemoSigner();
  contradictory.events = resignEventChain(
    contradictory.events,
    signer,
    "act_different_action",
  );
  contradictory.settlement_receipt = signArtifact({
    ...contradictory.settlement_receipt,
    event_chain_head: contradictory.events.at(-1).event_hash,
  }, signer);

  const integrityOnly = verifyBundle(contradictory, {
    trustedKeys: demoTrustedKeys(),
    trustedConnectorKeys: demoConnectorTrustedKeys(),
    requireSemantics: false,
  });
  assert.equal(integrityOnly.integrity.valid, true);
  assert.throws(
    () =>
      verifyBundle(contradictory, {
        trustedKeys: demoTrustedKeys(),
        trustedConnectorKeys: demoConnectorTrustedKeys(),
        requireSemantics: true,
      }),
    (error) => error.code === "SEMANTIC_INVALID",
  );
});

test("semantic verification rejects evidence accepted before verification state", async () => {
  const result = await runRefundDemo();
  const contradictory = deepClone(result.bundle);
  const signer = createDemoSigner();
  const evidenceIndex = contradictory.events.findIndex(
    (event) => event.event_type === "EVIDENCE_ACCEPTED",
  );
  const [evidenceEvent] = contradictory.events.splice(evidenceIndex, 1);
  contradictory.events.splice(1, 0, evidenceEvent);
  contradictory.events = resignEventChain(
    contradictory.events,
    signer,
    contradictory.action.action_id,
  );
  contradictory.settlement_receipt = signArtifact({
    ...contradictory.settlement_receipt,
    event_chain_head: contradictory.events.at(-1).event_hash,
  }, signer);

  const integrityOnly = verifyBundle(contradictory, {
    trustedKeys: demoTrustedKeys(),
    trustedConnectorKeys: demoConnectorTrustedKeys(),
    requireSemantics: false,
  });
  assert.equal(integrityOnly.integrity.valid, true);
  assert.throws(
    () =>
      verifyBundle(contradictory, {
        trustedKeys: demoTrustedKeys(),
        trustedConnectorKeys: demoConnectorTrustedKeys(),
        requireSemantics: true,
      }),
    (error) => error.code === "SEMANTIC_INVALID",
  );
});

test("semantic verification rejects recourse finalized before execution", async () => {
  const result = await runRefundDemo();
  const contradictory = deepClone(result.bundle);
  const signer = createDemoSigner();
  const recourseIndex = contradictory.events.findIndex(
    (event) =>
      event.event_type === "RECOURSE_FINALIZED" ||
      event.event_type === "RECOURSE_STATUS_RECORDED",
  );
  const [recourseEvent] = contradictory.events.splice(recourseIndex, 1);
  recourseEvent.recorded_at = contradictory.events[0].recorded_at;
  contradictory.events.splice(1, 0, recourseEvent);
  contradictory.events = resignEventChain(
    contradictory.events,
    signer,
    contradictory.action.action_id,
  );
  contradictory.settlement_receipt = signArtifact({
    ...contradictory.settlement_receipt,
    event_chain_head: contradictory.events.at(-1).event_hash,
  }, signer);

  const integrityOnly = verifyBundle(contradictory, {
    trustedKeys: demoTrustedKeys(),
    trustedConnectorKeys: demoConnectorTrustedKeys(),
    requireSemantics: false,
  });
  assert.equal(integrityOnly.integrity.valid, true);
  assert.throws(
    () =>
      verifyBundle(contradictory, {
        trustedKeys: demoTrustedKeys(),
        trustedConnectorKeys: demoConnectorTrustedKeys(),
        requireSemantics: true,
      }),
    (error) => error.code === "SEMANTIC_INVALID",
  );
});

test("HTTP sidecar advertises executable and observed assurance modes", async (context) => {
  const server = createReferenceServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  const response = await fetch(
    `http://127.0.0.1:${address.port}/.well-known/consequence-rail`,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.executable_modes, ["enforced", "cooperative"]);
  assert.ok(body.assurance_modes.includes("observed"));
});

test("HTTP sidecar completes the synthetic action lifecycle", async (context) => {
  const runtime = createDemoRuntime();
  const server = createReferenceServer({ runtime });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const proposal = buildRefundProposal(runtime.clock);

  const proposed = await postJson(`${base}/v0/actions`, proposal, 201);
  await postJson(`${base}/v0/actions/${proposed.action_id}/authorize`, {
    allow: true,
    policy_id: "demo-policy/v1",
    policy_digest: digest({ allow: true }),
  });
  await postJson(
    `${base}/v0/actions/${proposed.action_id}/recourse`,
    buildRefundReservation(proposed.action_digest, proposal, runtime.clock),
  );
  await postJson(`${base}/v0/actions/${proposed.action_id}/permit`, {});
  await postJson(`${base}/v0/actions/${proposed.action_id}/execute`, {});
  const closed = await postJson(
    `${base}/v0/actions/${proposed.action_id}/verify-outcome`,
    {},
  );
  assert.equal(closed.state, "CLOSED");
  assert.equal(closed.outcome, "settled");

  const bundleResponse = await fetch(
    `${base}/v0/actions/${proposed.action_id}/bundle?profile=audit`,
  );
  assert.equal(bundleResponse.status, 200);
  const bundle = await bundleResponse.json();
  const verified = await postJson(`${base}/v0/bundles/verify`, bundle);
  assert.equal(verified.valid, true);
});

test("conformance ActionProposal fixture is accepted", () => {
  const runtime = createDemoRuntime();
  const fixture = JSON.parse(
    readFileSync(join(process.cwd(), "conformance", "refund-action.json"), "utf8"),
  );
  const result = runtime.rail.propose(fixture);
  assert.equal(result.state, "PROPOSED");
  assert.equal(result.action_type, "demo.refund.issue/v1");
});

test("runtime artifacts contain every schema-required field", async () => {
  const result = await runRefundDemo({ fault: "duplicate" });
  assertRequiredFields(
    "spec/schemas/recourse-reservation.schema.json",
    result.bundle.recourse_reservation,
  );
  assertRequiredFields(
    "spec/schemas/connector-recourse-commitment.schema.json",
    result.bundle.recourse_reservation.connector_commitment,
  );
  assertRequiredFields(
    "spec/schemas/action-permit.schema.json",
    result.bundle.action_permit,
  );
  for (const evidence of result.bundle.outcome_evidence) {
    assertRequiredFields("spec/schemas/outcome-evidence.schema.json", evidence);
  }
  assertRequiredFields(
    "spec/schemas/settlement-receipt.schema.json",
    result.bundle.settlement_receipt,
  );
  assertRequiredFields(
    "spec/schemas/settlement-bundle.schema.json",
    result.bundle,
  );
});

function prepareRefundWithoutPermit(runtime) {
  const proposal = buildRefundProposal(runtime.clock);
  const proposed = runtime.rail.propose(proposal);
  runtime.rail.authorize(proposed.action_id, {
    allow: true,
    policy_id: "demo-refund-policy/v1",
    policy_digest: digest({ allow: true }),
  });
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
  return {
    actionId: proposed.action_id,
  };
}

async function postJson(url, body, expectedStatus = 200) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, expectedStatus);
  return response.json();
}

function assertRequiredFields(schemaPath, artifact) {
  const schema = JSON.parse(readFileSync(join(process.cwd(), schemaPath), "utf8"));
  for (const field of schema.required ?? []) {
    assert.equal(
      Object.hasOwn(artifact, field),
      true,
      `${schema.title} is missing required field ${field}`,
    );
  }
}

function resignEventChain(events, signer, actionId) {
  let previousHash = null;
  return events.map((event, sequence) => {
    const {
      signature: ignoredSignature,
      event_hash: ignoredEventHash,
      ...unsigned
    } = event;
    const signed = signArtifact({
      ...unsigned,
      action_id: actionId,
      sequence,
      previous_hash: previousHash,
    }, signer);
    const rebuilt = {
      ...signed,
      event_hash: digest(signed),
    };
    previousHash = rebuilt.event_hash;
    return rebuilt;
  });
}
