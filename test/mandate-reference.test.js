import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { digest, without } from "../src/canonical.js";
import { assertRequiredFields } from "../src/rail-test-helpers.js";
import { createDemoSigner, demoConnectorTrustedKeys, demoTrustedKeys, signArtifact } from "../src/signing.js";
import { buildTicketProposal, buildTicketReservation, createTicketRuntime } from "../src/ticket-demo.js";
import { verifyBundle, verifySettlementArtifact } from "../src/verify.js";

const trust = () => ({ trustedKeys: demoTrustedKeys(), trustedConnectorKeys: demoConnectorTrustedKeys() });

// A synthetic issuer compact JWS. The digest input is the text before the
// first "~": no selective disclosures and no key-binding JWT.
const ISSUER_JWS = "eyJhbGciOiJFUzI1NiJ9.eyJ0cmFuc2FjdGlvbl9pZCI6InN5bnRoZXRpYyJ9.c2lnbmF0dXJl";
const SD_JWT = `${ISSUER_JWS}~WyJzYWx0IiwiYW1vdW50IiwxMDBd~`;
const mandateDigest = (token) => createHash("sha256").update(token.split("~")[0], "ascii").digest("base64url");

function mandateReference() {
  return {
    profile: "sha256-terminal-compact-jws",
    mandate_id: createHash("sha256").update("synthetic-checkout-jwt").digest("base64url"),
    mandate_digest: mandateDigest(SD_JWT),
  };
}

async function settle(mutate) {
  const runtime = createTicketRuntime();
  const proposal = buildTicketProposal(runtime.clock);
  mutate(proposal);
  const proposed = runtime.rail.propose(proposal);
  runtime.rail.authorize(proposed.action_id, { allow: true, policy_id: "p", policy_digest: digest({ p: 1 }) });
  runtime.rail.reserveRecourse(proposed.action_id, buildTicketReservation(proposed.action_digest, proposal));
  await runtime.rail.simulate(proposed.action_id);
  runtime.rail.issuePermit(proposed.action_id);
  await runtime.rail.execute(proposed.action_id);
  await runtime.rail.verifyOutcome(proposed.action_id);
  return { runtime, proposal, actionId: proposed.action_id };
}

test("a mandate reference is bound into the action digest and copied into the signed receipt", async () => {
  assert.equal(mandateDigest(SD_JWT), mandateDigest(ISSUER_JWS));
  const reference = mandateReference();
  const { runtime, proposal, actionId } = await settle((p) => {
    p.mandate_reference = reference;
  });
  const plain = buildTicketProposal(runtime.clock);
  assert.notEqual(digest(proposal), digest(plain));
  const bundle = runtime.rail.exportBundle(actionId, { profile: "audit" });
  assert.deepEqual(bundle.action.proposal.mandate_reference, reference);
  assert.deepEqual(bundle.settlement_receipt.mandate_reference, reference);
  assertRequiredFields("spec/schemas/settlement-receipt-v0.3.schema.json", bundle.settlement_receipt);
  assert.equal(verifyBundle(bundle, { ...trust(), requireSemantics: true }).valid, true);
  const receiptOnly = runtime.rail.exportBundle(actionId, { profile: "receipt" });
  assert.deepEqual(receiptOnly.settlement_receipt.mandate_reference, reference);
  assert.equal(verifySettlementArtifact(receiptOnly, { ...trust(), allowReceiptProfile: true }).valid, true);

  // A receipt re-signed with another mandate no longer matches the proposal.
  const swapped = structuredClone(bundle);
  swapped.settlement_receipt = signArtifact(
    { ...without(bundle.settlement_receipt, ["signature"]), mandate_reference: { ...reference, mandate_digest: "A".repeat(43) } },
    createDemoSigner(),
  );
  assert.throws(() => verifyBundle(swapped, trust()), /mandate reference does not match/);
  const dropped = structuredClone(bundle);
  dropped.settlement_receipt = signArtifact(
    without(bundle.settlement_receipt, ["signature", "mandate_reference"]),
    createDemoSigner(),
  );
  assert.throws(() => verifyBundle(dropped, trust()), /mandate reference does not match/);
});

test("an action without a mandate reference settles without one", async () => {
  const { runtime, actionId } = await settle(() => {});
  const bundle = runtime.rail.exportBundle(actionId, { profile: "audit" });
  assert.equal(Object.hasOwn(bundle.settlement_receipt, "mandate_reference"), false);
  assert.equal(verifyBundle(bundle, { ...trust(), requireSemantics: true }).valid, true);
});

test("a malformed mandate reference is refused at proposal", () => {
  const runtime = createTicketRuntime();
  const cases = [
    { ...mandateReference(), profile: "sha256-full-sd-jwt" },
    { ...mandateReference(), mandate_digest: "not-a-digest" },
    { ...mandateReference(), mandate_id: "" },
    { ...mandateReference(), mandate_id: "has space" },
    { ...mandateReference(), mandate_id: "x".repeat(257) },
    { ...mandateReference(), extra: true },
    without(mandateReference(), ["mandate_id"]),
  ];
  for (const reference of cases) {
    const proposal = buildTicketProposal(runtime.clock);
    proposal.mandate_reference = reference;
    assert.throws(() => runtime.rail.propose(proposal), { code: "SCHEMA_INVALID" });
  }
});
