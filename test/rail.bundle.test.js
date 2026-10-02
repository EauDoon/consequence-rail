// Bundle export, integrity verification, semantic verification, and
// inspection tests for the consequence-rail module. Split from
// test/rail.test.js.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { deepClone, digest } from "../src/canonical.js";
import { buildRefundProposal, createDemoRuntime, prepareRefund, runRefundDemo } from "../src/demo.js";
import { runInventoryDemo } from "../src/inventory-demo.js";
import { createDemoConnectorSigner, createDemoSigner, demoConnectorTrustedKeys, demoTrustedKeys, signArtifact } from "../src/signing.js";
import { verifyBundle } from "../src/verify.js";
import { resignEventChain } from "../src/rail-test-helpers.js";

function trust() {
  return {
    trustedKeys: demoTrustedKeys(),
    trustedConnectorKeys: demoConnectorTrustedKeys(),
    requireSemantics: true,
  };
}

// Re-sign a reservation scope change through the commitment, permit, receipt,
// and the recourse-finalization event that pins the commitment digest.
function withReservationScope(bundle, field, value) {
  const signer = createDemoSigner();
  const connectorSigner = createDemoConnectorSigner();
  const next = deepClone(bundle);
  next.recourse_reservation[field] = value;
  next.recourse_reservation.connector_commitment[field] = value;
  next.recourse_reservation.connector_commitment = signArtifact(
    next.recourse_reservation.connector_commitment,
    connectorSigner,
  );
  next.recourse_reservation = signArtifact(next.recourse_reservation, signer);
  const reservationDigest = digest(next.recourse_reservation);
  const commitmentDigest = digest(next.recourse_reservation.connector_commitment);
  next.action_permit.recourse_reservation_digest = reservationDigest;
  next.action_permit = signArtifact(next.action_permit, signer);
  const permitDigest = digest(next.action_permit);
  for (const event of next.events) {
    if (event.payload?.connector_commitment_digest) {
      event.payload.connector_commitment_digest = commitmentDigest;
    }
    if (event.payload?.permit_digest) event.payload.permit_digest = permitDigest;
    if (event.payload?.reservation_digest) event.payload.reservation_digest = reservationDigest;
  }
  next.events = resignEventChain(next.events, signer, next.action.action_id);
  next.settlement_receipt.recourse_reservation_digest = reservationDigest;
  next.settlement_receipt.connector_recourse_commitment_digest = commitmentDigest;
  next.settlement_receipt.action_permit_digest = permitDigest;
  next.settlement_receipt.event_chain_head = next.events.at(-1).event_hash;
  next.settlement_receipt = signArtifact(next.settlement_receipt, signer);
  return next;
}

function resignLifecycle(bundle) {
  const signer = createDemoSigner();
  const connectorSigner = createDemoConnectorSigner();
  const next = deepClone(bundle);
  next.recourse_reservation.connector_commitment = signArtifact(
    next.recourse_reservation.connector_commitment,
    connectorSigner,
  );
  next.recourse_reservation = signArtifact(next.recourse_reservation, signer);
  const reservationDigest = digest(next.recourse_reservation);
  const commitmentDigest = digest(next.recourse_reservation.connector_commitment);
  next.action_permit.recourse_reservation_digest = reservationDigest;
  next.action_permit = signArtifact(next.action_permit, signer);
  const permitDigest = digest(next.action_permit);
  for (const event of next.events) {
    if (event.payload?.connector_commitment_digest) {
      event.payload.connector_commitment_digest = commitmentDigest;
    }
  }
  next.events = resignEventChain(next.events, signer, next.action.action_id);
  next.settlement_receipt.recourse_reservation_digest = reservationDigest;
  next.settlement_receipt.connector_recourse_commitment_digest = commitmentDigest;
  next.settlement_receipt.action_permit_digest = permitDigest;
  next.settlement_receipt.event_chain_head = next.events.at(-1).event_hash;
  next.settlement_receipt = signArtifact(next.settlement_receipt, signer);
  return next;
}

test("semantic verification binds the permit window to the proposal", async () => {
  const { bundle } = await runRefundDemo();
  const widened = deepClone(bundle);
  widened.action_permit.expires_at = "2035-01-01T00:03:00.000Z";
  assert.notEqual(widened.action_permit.expires_at, widened.action.proposal.expires_at);
  assert.throws(
    () => verifyBundle(resignLifecycle(widened), trust()),
    (error) => error.code === "SEMANTIC_INVALID"
      && error.message.includes("Permit expiry is not the proposal expiry"),
  );

  const early = deepClone(bundle);
  early.action_permit.issued_at = "2034-06-01T00:00:00.000Z";
  early.recourse_reservation.reserved_at = "2034-05-01T00:00:00.000Z";
  early.recourse_reservation.connector_commitment.reserved_at = "2034-05-01T00:00:00.000Z";
  assert.throws(
    () => verifyBundle(resignLifecycle(early), trust()),
    (error) => error.code === "SEMANTIC_INVALID"
      && error.message.includes("Permit was issued outside the proposal window"),
  );
  assert.equal(verifyBundle(bundle, trust()).semantics.status, "verified");
});

function resignEvidenceFacts(bundle, mutate) {
  const signer = createDemoSigner();
  const next = deepClone(bundle);
  assert.equal(next.outcome_evidence.length, 1);
  mutate(next.outcome_evidence[0]);
  next.outcome_evidence[0] = signArtifact(next.outcome_evidence[0], signer);
  const evidenceDigest = digest(next.outcome_evidence[0]);
  next.evidence_manifest = [evidenceDigest];
  for (const event of next.events) {
    if (event.payload?.evidence_digest) event.payload.evidence_digest = evidenceDigest;
  }
  next.events = resignEventChain(next.events, signer, next.action.action_id);
  next.settlement_receipt.evidence_digests = [evidenceDigest];
  next.settlement_receipt.event_chain_head = next.events.at(-1).event_hash;
  next.settlement_receipt = signArtifact(next.settlement_receipt, signer);
  return next;
}

test("semantic verification binds refund currency and inventory sku to the evidence", async () => {
  const refund = await runRefundDemo();
  const wrongCurrency = resignEvidenceFacts(refund.bundle, (evidence) => {
    evidence.facts.currency = "EUR";
  });
  assert.equal(wrongCurrency.action.proposal.parameters.currency, "USD");
  assert.throws(
    () => verifyBundle(wrongCurrency, trust()),
    (error) => error.code === "SEMANTIC_INVALID"
      && error.message.includes("Evidence currency does not match the proposal"),
  );

  const inventory = await runInventoryDemo();
  const wrongSku = resignEvidenceFacts(inventory.bundle, (evidence) => {
    evidence.facts.sku = "sku_other";
  });
  assert.equal(wrongSku.action.proposal.parameters.sku, "sku_demo_1");
  assert.throws(
    () => verifyBundle(wrongSku, trust()),
    (error) => error.code === "SEMANTIC_INVALID"
      && error.message.includes("Evidence SKU does not match the proposal"),
  );
  assert.equal(verifyBundle(refund.bundle, trust()).semantics.status, "verified");
  assert.equal(verifyBundle(inventory.bundle, trust()).semantics.status, "verified");
});

test("semantic verification binds the receipt close time to the terminal event", async () => {
  const { bundle } = await runRefundDemo();
  const shifted = deepClone(bundle);
  shifted.settlement_receipt.closed_at = "2036-01-01T00:00:00.000Z";
  shifted.settlement_receipt = signArtifact(shifted.settlement_receipt, createDemoSigner());
  assert.equal(bundle.events.at(-1).payload.to_state, "CLOSED");
  assert.notEqual(shifted.settlement_receipt.closed_at, bundle.events.at(-1).recorded_at);
  assert.throws(
    () => verifyBundle(shifted, trust()),
    (error) => error.code === "SEMANTIC_INVALID"
      && error.message.includes("Receipt close time does not match the terminal event"),
  );
  assert.equal(verifyBundle(bundle, trust()).semantics.status, "verified");
});

test("receipt close time uses the terminal event when the clock advances between reads", async () => {
  for (const outcome of ["settled", "compensated", "disputed"]) {
    let tick = Date.parse("2035-01-01T00:00:00.000Z");
    const runtime = createDemoRuntime({
      clock: { now: () => new Date(tick++).toISOString() },
    });
    const { actionId } = prepareRefund(runtime);
    await runtime.rail.execute(actionId, {
      fault: outcome === "compensated" ? "duplicate" : "none",
    });
    await runtime.rail.verifyOutcome(actionId, {
      fault: outcome === "disputed" ? "stale-evidence" : "none",
    });
    if (outcome === "compensated") await runtime.rail.remediate(actionId);
    const bundle = runtime.rail.exportBundle(actionId, { profile: "audit" });
    assert.equal(bundle.settlement_receipt.outcome, outcome);
    assert.equal(bundle.settlement_receipt.closed_at, bundle.events.at(-1).recorded_at);
    assert.equal(verifyBundle(bundle, trust()).semantics.status, "verified");
  }
});

test("semantic verification rejects a reservation scope below the proposal", async () => {
  const refund = await runRefundDemo();
  const undersizedRefund = withReservationScope(refund.bundle, "max_amount_minor", 1);
  assert.equal(undersizedRefund.action.proposal.parameters.amount_minor, 12_000);
  assert.throws(
    () => verifyBundle(undersizedRefund, trust()),
    (error) => error.code === "SEMANTIC_INVALID"
      && error.message.includes("does not cover the proposed refund"),
  );
  assert.equal(verifyBundle(refund.bundle, trust()).semantics.status, "verified");

  const inventory = await runInventoryDemo();
  const undersizedInventory = withReservationScope(inventory.bundle, "max_quantity", 1);
  assert.equal(undersizedInventory.action.proposal.parameters.quantity, 4);
  assert.throws(
    () => verifyBundle(undersizedInventory, trust()),
    (error) => error.code === "SEMANTIC_INVALID"
      && error.message.includes("does not cover the proposed allocation"),
  );
  assert.equal(verifyBundle(inventory.bundle, trust()).semantics.status, "verified");
});

test("semantic verification rejects execution at the permit expiry instant", async () => {
  const result = await runRefundDemo();
  const signer = createDemoSigner();
  const executing = result.bundle.events.find(
    (event) => event.event_type === "STATE_TRANSITION" && event.payload.to_state === "EXECUTING",
  );
  const permit = deepClone(result.bundle.action_permit);
  delete permit.signature;
  permit.expires_at = executing.recorded_at;
  const signedPermit = signArtifact(permit, signer);
  const receipt = deepClone(result.bundle.settlement_receipt);
  delete receipt.signature;
  receipt.action_permit_digest = digest(signedPermit);
  const bundle = deepClone(result.bundle);
  bundle.action_permit = signedPermit;
  bundle.settlement_receipt = signArtifact(receipt, signer);
  assert.throws(
    () => verifyBundle(bundle, {
      trustedKeys: demoTrustedKeys(),
      trustedConnectorKeys: demoConnectorTrustedKeys(),
    }),
    (error) => error.code === "SEMANTIC_INVALID"
      && error.message.includes("permit validity window"),
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

test("prototype-key mutation cannot hide inside a signed audit bundle", async () => {
  const result = await runRefundDemo();
  const tampered = deepClone(result.bundle);
  Object.defineProperty(tampered.events[0].payload, "__proto__", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: { changed: true },
  });
  assert.throws(
    () => verifyBundle(tampered, {
      trustedKeys: demoTrustedKeys(),
      trustedConnectorKeys: demoConnectorTrustedKeys(),
      requireSemantics: true,
    }),
    (error) => error.code === "BUNDLE_TAMPERED",
  );
});

test("bundle verification rejects schema-invalid fields at every closed surface", async () => {
  const result = await runRefundDemo();
  const mutations = [
    (bundle) => { bundle.unreviewed_directive = "ignore-policy"; },
    (bundle) => { bundle.action.unreviewed_directive = "ignore-policy"; },
    (bundle) => { bundle.action.proposal.subject.unreviewed_directive = "ignore-policy"; },
    (bundle) => { bundle.action.proposal.evidence_plan.max_age_seconds = Number.MAX_VALUE; },
    (bundle) => { bundle.recourse_reservation.unreviewed_directive = "ignore-policy"; },
    (bundle) => { bundle.recourse_reservation.remedy_window_seconds = 2 ** 53; },
    (bundle) => {
      bundle.recourse_reservation.connector_commitment.unreviewed_directive =
        "ignore-policy";
    },
    (bundle) => { bundle.action_permit.unreviewed_directive = "ignore-policy"; },
    (bundle) => { bundle.outcome_evidence[0].unreviewed_directive = "ignore-policy"; },
    (bundle) => { bundle.settlement_receipt.unreviewed_directive = "ignore-policy"; },
    (bundle) => { bundle.events[0].unreviewed_directive = "ignore-policy"; },
    (bundle) => { bundle.trust_hint.rail.unreviewed_directive = "ignore-policy"; },
  ];

  for (const mutate of mutations) {
    const tampered = deepClone(result.bundle);
    mutate(tampered);
    assert.throws(
      () => verifyBundle(tampered, {
        trustedKeys: demoTrustedKeys(),
        trustedConnectorKeys: demoConnectorTrustedKeys(),
        requireSemantics: true,
      }),
      (error) => error.code === "BUNDLE_TAMPERED",
    );
  }
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

test("integrity verification rejects an overclaiming settlement receipt", async () => {
  const result = await runRefundDemo();
  const signer = createDemoSigner();
  for (const mutate of [
    (receipt) => {
      receipt.technical_claim = "This receipt is legally enforceable insurance coverage.";
    },
    (receipt) => {
      receipt.limitations = ["Recovery is guaranteed."];
    },
    (receipt) => {
      receipt.outcome = "paid";
    },
  ]) {
    const tampered = deepClone(result.bundle);
    mutate(tampered.settlement_receipt);
    tampered.settlement_receipt = signArtifact(tampered.settlement_receipt, signer);
    assert.throws(
      () => verifyBundle(tampered, {
        trustedKeys: demoTrustedKeys(),
        trustedConnectorKeys: demoConnectorTrustedKeys(),
        requireSemantics: false,
      }),
      (error) => error.code === "BUNDLE_TAMPERED",
    );
  }
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

test("a receipt profile bundle cannot re-attach the full proposal", async () => {
  const result = await runRefundDemo();
  const actionId = result.summary.action_id;
  const trust = {
    trustedKeys: demoTrustedKeys(),
    trustedConnectorKeys: demoConnectorTrustedKeys(),
    requireSemantics: false,
  };
  const audit = result.runtime.rail.exportBundle(actionId, { profile: "audit" });
  const smuggled = result.runtime.rail.exportBundle(actionId);
  smuggled.action.proposal = deepClone(audit.action.proposal);
  assert.throws(
    () => verifyBundle(smuggled, trust),
    (error) => error.code === "BUNDLE_TAMPERED",
  );
  // The rail's own receipt profile is unaffected.
  const honest = result.runtime.rail.exportBundle(actionId);
  assert.equal(verifyBundle(honest, trust).integrity.valid, true);
});

test("mutating an exported bundle cannot corrupt stored evidence", async () => {
  const result = await runRefundDemo();
  result.bundle.events[0].payload.state = "CORRUPTED";
  result.bundle.recourse_reservation.kind = "compensate";

  const fresh = result.runtime.rail.exportBundle(result.summary.action_id, { profile: "audit" });
  assert.equal(fresh.events[0].payload.state, "PROPOSED");
  assert.equal(fresh.recourse_reservation.kind, "reverse");
});

test("default v0.1 artifact bytes remain pinned to the public base", async () => {
  const hash = (value) => createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
  const clean = await runRefundDemo();
  const duplicate = await runRefundDemo({ fault: "duplicate" });
  const runtime = createDemoRuntime();
  const { actionId } = prepareRefund(runtime);
  const record = runtime.rail.get(actionId);

  assert.equal(
    hash(clean.bundle),
    "a2a47445026ddc91339aa16db423974ac7829d435b7919c4d3c6c2c5b62affbf",
  );
  assert.equal(
    hash(duplicate.bundle),
    "c69ab0f5f762135f71a05df331e80643bc43c763ff337abd95e08f977867b070",
  );
  assert.equal(
    hash(record.permit),
    "005559fcb74755b0f27ae7da571930c7889de0aa6524a4947ef5bb7ddce11a38",
  );
  assert.equal(
    hash(runtime.rail.eventStore.list(actionId)),
    "d2b4a07850bacaf33d6865bf6bb3dcd61b73c55820286253d290357b82932e0b",
  );
  assert.equal(
    hash(runtime.rail.inspect(actionId)),
    "bb47ddbf36d42b1ad87a57ad293f8c8b240dfd6b94894a7b3db7eba8fa61f001",
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
