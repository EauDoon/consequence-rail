// Signed authorization decisions: the proposer cannot approve its own
// action when the rail requires a decision from a trusted authorizer key.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import {
  AUTHORIZATION_DECISION_SCHEMA_VERSION,
  createAuthorizationDecision,
  verifyAuthorizationDecision,
} from "../src/authorization.js";
import { digest } from "../src/canonical.js";
import { addMilliseconds } from "../src/clock.js";
import { buildRefundProposal, buildRefundReservation, createDemoRuntime } from "../src/demo.js";
import { createReferenceServer } from "../src/http-server.js";
import { ConsequenceRail } from "../src/rail.js";
import { assertRequiredFields, postJson, repoPath } from "../src/rail-test-helpers.js";
import {
  createDemoAuthorizerSigner,
  createDemoSigner,
  createDeterministicDemoSigner,
  demoAuthorizerTrustedKeys,
} from "../src/signing.js";
import { parseTrustedKeys } from "../src/trust-config.js";
import { MockRefundConnector } from "../src/mock-refund-connector.js";
import { ManualClock } from "../src/clock.js";

const POLICY_DIGEST = digest({ max_amount_minor: 25_000, currency: "USD" });

function signedDecision(runtime, actionDigest, overrides = {}, signer = createDemoAuthorizerSigner()) {
  const now = runtime.clock.now();
  return createAuthorizationDecision({
    actionDigest,
    allow: true,
    policyId: "demo-refund-policy/v1",
    policyDigest: POLICY_DIGEST,
    evaluationInputDigest: digest({ amount_minor: 1250 }),
    decidedAt: now,
    expiresAt: addMilliseconds(now, 60_000),
    ...overrides,
  }, signer);
}

function strictRuntime(options = {}) {
  return createDemoRuntime({ requireSignedAuthorization: true, ...options });
}

test("a signed decision authorizes the exact action and is recorded in the event chain", () => {
  const runtime = strictRuntime();
  const proposal = buildRefundProposal(runtime.clock);
  const proposed = runtime.rail.propose(proposal);
  const decision = signedDecision(runtime, proposed.action_digest);
  assertRequiredFields("spec/schemas/authorization-decision.schema.json", decision);
  assert.equal(decision.schema_version, AUTHORIZATION_DECISION_SCHEMA_VERSION);
  assert.match(decision.decision_id, /^authz_[A-Za-z0-9_-]{20}$/);

  const view = runtime.rail.authorize(proposed.action_id, decision);
  assert.equal(view.state, "AUTHORIZED");
  assert.equal(view.authorization_decision_digest, digest(decision));
  assert.equal(view.authorizer_key_id, createDemoAuthorizerSigner().kid);
  const events = runtime.rail.eventStore.list(proposed.action_id);
  const accepted = events.find((event) => event.event_type === "AUTHORIZATION_DECISION_ACCEPTED");
  assert.equal(accepted.actor, "authorizer");
  assert.equal(accepted.payload.decision_digest, digest(decision));
  assert.equal(accepted.payload.allow, true);

  // The rest of the lifecycle is unchanged.
  runtime.rail.reserveRecourse(
    proposed.action_id,
    buildRefundReservation(proposed.action_digest, proposal, runtime.clock),
  );
  assert.equal(runtime.rail.issuePermit(proposed.action_id).state, "PERMITTED");
});

test("a signed deny closes the path to execution", () => {
  const runtime = strictRuntime();
  const proposed = runtime.rail.propose(buildRefundProposal(runtime.clock));
  const view = runtime.rail.authorize(
    proposed.action_id,
    signedDecision(runtime, proposed.action_digest, { allow: false }),
  );
  assert.equal(view.state, "DENIED");
});

test("a strict rail refuses the unsigned claim the proposer could make itself", () => {
  const runtime = strictRuntime();
  const proposed = runtime.rail.propose(buildRefundProposal(runtime.clock));
  const before = runtime.rail.eventStore.list(proposed.action_id).length;
  assert.throws(
    () => runtime.rail.authorize(proposed.action_id, {
      allow: true,
      policy_id: "self-approved",
      policy_digest: POLICY_DIGEST,
    }),
    (error) => error.code === "AUTHORIZATION_SIGNATURE_REQUIRED",
  );
  assert.equal(runtime.rail.inspect(proposed.action_id).state, "PROPOSED");
  assert.equal(runtime.rail.eventStore.list(proposed.action_id).length, before);
});

test("the default rail still accepts the unsigned form for 0.4.0 callers", () => {
  const runtime = createDemoRuntime();
  const proposed = runtime.rail.propose(buildRefundProposal(runtime.clock));
  const view = runtime.rail.authorize(proposed.action_id, {
    allow: true,
    policy_id: "demo-refund-policy/v1",
    policy_digest: POLICY_DIGEST,
  });
  assert.equal(view.state, "AUTHORIZED");
  assert.equal(view.authorization_decision_digest, undefined);
});

test("refused decisions leave the action PROPOSED with no new event", () => {
  const runtime = strictRuntime();
  const proposal = buildRefundProposal(runtime.clock);
  const proposed = runtime.rail.propose(proposal);
  const other = runtime.rail.propose({ ...proposal, idempotency_key: "refund:other" });
  const untrusted = createDeterministicDemoSigner("someone-else", "other-authorizer");
  const railSigner = createDemoSigner();
  const now = runtime.clock.now();
  const valid = signedDecision(runtime, proposed.action_digest);
  const tamperedAllow = { ...signedDecision(runtime, proposed.action_digest, { allow: false }), allow: true };
  const cases = [
    ["wrong action", signedDecision(runtime, other.action_digest), "AUTHORIZATION_ACTION_MISMATCH"],
    ["untrusted key", signedDecision(runtime, proposed.action_digest, {}, untrusted), "UNTRUSTED_KEY"],
    ["the rail's own key", signedDecision(runtime, proposed.action_digest, {}, railSigner), "UNTRUSTED_KEY"],
    ["flipped allow", tamperedAllow, "AUTHORIZATION_INVALID"],
    [
      "decided in the future",
      signedDecision(runtime, proposed.action_digest, {
        decidedAt: addMilliseconds(now, 1_000),
        expiresAt: addMilliseconds(now, 60_000),
      }),
      "AUTHORIZATION_FROM_FUTURE",
    ],
    ["unknown field", { ...valid, extra: true }, "AUTHORIZATION_INVALID"],
    ["missing signature", (({ signature, ...rest }) => rest)(valid), "AUTHORIZATION_INVALID"],
  ];
  for (const [label, decision, code] of cases) {
    const before = runtime.rail.eventStore.list(proposed.action_id).length;
    assert.throws(
      () => runtime.rail.authorize(proposed.action_id, decision),
      (error) => error.code === code,
      label,
    );
    assert.equal(runtime.rail.inspect(proposed.action_id).state, "PROPOSED", label);
    assert.equal(runtime.rail.eventStore.list(proposed.action_id).length, before, label);
  }
});

test("an expired decision is refused", () => {
  const runtime = strictRuntime();
  const proposed = runtime.rail.propose(buildRefundProposal(runtime.clock));
  const decision = signedDecision(runtime, proposed.action_digest);
  runtime.clock.advance(60_000);
  assert.throws(
    () => runtime.rail.authorize(proposed.action_id, decision),
    (error) => error.code === "AUTHORIZATION_EXPIRED",
  );
});

test("a signed decision cannot outlive the maximum lifetime", () => {
  const clock = new ManualClock();
  assert.throws(
    () => createAuthorizationDecision({
      actionDigest: digest({ a: 1 }),
      allow: true,
      policyId: "p",
      policyDigest: POLICY_DIGEST,
      decidedAt: clock.now(),
      expiresAt: addMilliseconds(clock.now(), 86_400_001),
    }, createDemoAuthorizerSigner()),
    (error) => error.code === "AUTHORIZATION_INVALID",
  );
});

test("a decision may require recovery preflight, and a rail-wide requirement cannot be lowered", () => {
  const runtime = strictRuntime({ requireRecoveryPreflight: true });
  const proposed = runtime.rail.propose(buildRefundProposal(runtime.clock));
  const view = runtime.rail.authorize(
    proposed.action_id,
    signedDecision(runtime, proposed.action_digest, { requireRecoveryPreflight: false }),
  );
  assert.equal(view.recovery_preflight_required, true);

  const lenient = strictRuntime();
  const second = lenient.rail.propose(buildRefundProposal(lenient.clock));
  assert.equal(
    lenient.rail.authorize(
      second.action_id,
      signedDecision(lenient, second.action_digest, { requireRecoveryPreflight: true }),
    ).recovery_preflight_required,
    true,
  );
});

test("a strict rail needs a trusted authorizer key at construction", () => {
  const clock = new ManualClock();
  const connector = new MockRefundConnector(clock);
  assert.throws(
    () => new ConsequenceRail({
      signer: createDemoSigner(),
      clock,
      connector,
      connectorTrustedKeys: connector.trustedKeys(),
      requireSignedAuthorization: true,
    }),
    (error) => error.code === "CONFIG_INVALID",
  );
  // A caller mutating its own map later does not change the rail's trust.
  const keys = demoAuthorizerTrustedKeys();
  const rail = new ConsequenceRail({
    signer: createDemoSigner(),
    clock,
    connector,
    connectorTrustedKeys: connector.trustedKeys(),
    authorizerTrustedKeys: keys,
    requireSignedAuthorization: true,
  });
  keys.clear();
  assert.equal(rail.authorizerTrustedKeys.size, 1);
});

test("verifyAuthorizationDecision reports the decision digest and key", () => {
  const runtime = createDemoRuntime();
  const actionDigest = digest({ any: "action" });
  const decision = signedDecision(runtime, actionDigest);
  const result = verifyAuthorizationDecision(decision, {
    trustedKeys: demoAuthorizerTrustedKeys(),
    actionDigest,
    now: runtime.clock.now(),
  });
  assert.equal(result.decision_digest, digest(decision));
  assert.equal(result.key_id, createDemoAuthorizerSigner().kid);
  assert.throws(
    () => verifyAuthorizationDecision(decision, { trustedKeys: new Map(), actionDigest, now: runtime.clock.now() }),
    (error) => error.code === "AUTHORIZER_UNTRUSTED",
  );
});

test("trusted-keys files accept an authorizer role without changing existing digests", () => {
  const signer = createDemoAuthorizerSigner();
  const base = {
    schema_version: "consequence-rail/trusted-keys/v0.1",
    rail: [{ key_id: createDemoSigner().kid, public_key_pem: createDemoSigner().publicKeyPem }],
  };
  const withEmpty = parseTrustedKeys({ ...base, authorizer: [] });
  assert.equal(withEmpty.trust_config_digest, parseTrustedKeys(base).trust_config_digest);
  const withKey = parseTrustedKeys({
    ...base,
    authorizer: [{ key_id: signer.kid, public_key_pem: signer.publicKeyPem }],
  });
  assert.equal(withKey.authorizer.size, 1);
  assert.notEqual(withKey.trust_config_digest, withEmpty.trust_config_digest);
});

test("the strict sidecar refuses self-approval over HTTP and accepts a signed decision", async (context) => {
  const runtime = strictRuntime();
  const server = createReferenceServer({ runtime });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const wellKnown = await (await fetch(`${base}/.well-known/consequence-rail`)).json();
  assert.equal(wellKnown.signed_authorization_required, true);
  assert.ok(wellKnown.optional_features.includes("signed-authorization/v0.1"));

  const proposed = await postJson(`${base}/v0/actions`, buildRefundProposal(runtime.clock), 201);
  const refused = await postJson(`${base}/v0/actions/${proposed.action_id}/authorize`, {
    allow: true,
    policy_id: "self-approved",
    policy_digest: POLICY_DIGEST,
  }, 403);
  assert.equal(refused.code, "AUTHORIZATION_SIGNATURE_REQUIRED");
  const accepted = await postJson(
    `${base}/v0/actions/${proposed.action_id}/authorize`,
    signedDecision(runtime, proposed.action_digest),
  );
  assert.equal(accepted.state, "AUTHORIZED");
});

test("rail --require-signed-authorization announces the requirement", async (context) => {
  const child = spawn(process.execPath, [
    repoPath("cmd", "rail.js"),
    "--port", "0",
    "--clock", "demo",
    "--require-signed-authorization",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  context.after(() => child.kill());
  let stdout = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) {
    stdout += chunk;
    if (stdout.split("\n").length >= 3) break;
  }
  const lines = stdout.trim().split("\n");
  assert.match(lines[0], /^Consequence Rail reference sidecar listening on http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(
    lines[1],
    "Authorization requires a signed decision from the public demonstration authorizer key",
  );
});

test("a settlement bundle with a signed authorization still verifies offline", async () => {
  const { verifyBundle } = await import("../src/verify.js");
  const { demoConnectorTrustedKeys, demoTrustedKeys } = await import("../src/signing.js");
  const runtime = strictRuntime();
  const proposal = buildRefundProposal(runtime.clock);
  const proposed = runtime.rail.propose(proposal);
  runtime.rail.authorize(proposed.action_id, signedDecision(runtime, proposed.action_digest));
  runtime.rail.reserveRecourse(
    proposed.action_id,
    buildRefundReservation(proposed.action_digest, proposal, runtime.clock),
  );
  runtime.rail.issuePermit(proposed.action_id);
  await runtime.rail.execute(proposed.action_id);
  await runtime.rail.verifyOutcome(proposed.action_id);
  const bundle = runtime.rail.exportBundle(proposed.action_id, { profile: "audit" });
  const result = verifyBundle(bundle, {
    trustedKeys: demoTrustedKeys(),
    trustedConnectorKeys: demoConnectorTrustedKeys(),
  });
  assert.equal(result.outcome, "settled");
  assert.ok(bundle.events.some((event) => event.event_type === "AUTHORIZATION_DECISION_ACCEPTED"));
});
