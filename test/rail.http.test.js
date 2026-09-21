// HTTP sidecar tests for the consequence-rail module. Covers the synthetic
// action lifecycle, host authority validation, request validation, internal
// error logging, over-cap body handling, and current-time proposals.
// Split from test/rail.test.js.

import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { digest } from "../src/canonical.js";
import { ManualClock, SystemClock } from "../src/clock.js";
import {
  buildRefundProposal,
  buildRefundReservation,
  createDemoRuntime,
} from "../src/demo.js";
import { createReferenceServer } from "../src/http-server.js";
import {
  postJson,
  rawHttpRequest,
  rawSocketRequest,
  socketOutcome,
} from "../src/rail-test-helpers.js";

test("system clock admits current-time proposals that a frozen demo clock expires", () => {
  const live = createDemoRuntime({ clock: new SystemClock() });
  const currentProposal = buildRefundProposal(live.clock);
  assert.match(live.clock.now(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(live.rail.propose(currentProposal).state, "PROPOSED");

  const frozen = createDemoRuntime({ clock: new ManualClock() });
  assert.equal(frozen.clock.now(), "2035-01-01T00:00:00.000Z");
  assert.throws(
    () => frozen.rail.propose(currentProposal),
    (error) => error.code === "ACTION_EXPIRED",
  );
  assert.equal(frozen.rail.actions.size, 0);
});

test("HTTP sidecar default runtime admits current-time proposals", async (context) => {
  const server = createReferenceServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  const proposed = await postJson(
    `http://127.0.0.1:${address.port}/v0/actions`,
    buildRefundProposal(new SystemClock()),
    201,
  );
  assert.equal(proposed.state, "PROPOSED");
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

test("HTTP sidecar rejects ambiguous Host authorities before routing", async (context) => {
  const server = createReferenceServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const { port } = server.address();

  for (const hostLines of [
    `Host: 127.0.0.1:${port}\r\nHost: attacker.invalid:${port}`,
    `Host: user@127.0.0.1:${port}`,
    `Host: 127.0.0.1:${port}/unexpected`,
  ]) {
    const response = await rawSocketRequest(
      port,
      `GET /.well-known/consequence-rail HTTP/1.1\r\n${hostLines}\r\nConnection: close\r\n\r\n`,
    );
    assert.match(response, /^HTTP\/1\.1 400 /u);
    assert.match(response, /"code":"HOST_INVALID"/u);
  }
});

test("HTTP sidecar rejects non-origin-form targets without state or rate mutation", async (context) => {
  const runtime = createDemoRuntime();
  const server = createReferenceServer({ runtime });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const { port } = server.address();
  const host = `127.0.0.1:${port}`;
  const body = JSON.stringify(buildRefundProposal(runtime.clock));
  const absoluteGet =
    `GET http://attacker.invalid/.well-known/consequence-rail HTTP/1.1\r\n` +
    `Host: ${host}\r\nConnection: close\r\n\r\n`;
  const absolutePost =
    `POST http://attacker.invalid/v0/actions HTTP/1.1\r\n` +
    `Host: ${host}\r\nContent-Type: application/json\r\n` +
    `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;

  for (const requestText of [absoluteGet, absolutePost]) {
    const response = await rawSocketRequest(port, requestText);
    assert.match(response, /^HTTP\/1\.1 400 /u);
    assert.match(response, /"code":"REQUEST_INVALID"/u);
  }
  assert.equal(runtime.rail.actions.size, 0);

  for (let count = 2; count < 600; count += 1) {
    const response = await rawSocketRequest(port, absoluteGet);
    assert.match(response, /^HTTP\/1\.1 400 /u);
  }
  const valid = await fetch(`http://${host}/.well-known/consequence-rail`);
  assert.equal(valid.status, 200);
  assert.equal(runtime.rail.actions.size, 0);
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
  assert.equal(verified.semantics.status, "verified");
  assert.equal(verified.outcome, "settled");
  assert.match(verified.event_chain_head, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(typeof verified.trusted_key_id, "string");
  assert.equal(typeof verified.trusted_connector_key_id, "string");
});

test("HTTP sidecar rejects unsafe requests before state mutation", async (context) => {
  const runtime = createDemoRuntime();
  const server = createReferenceServer({ runtime });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const proposal = JSON.stringify(buildRefundProposal(runtime.clock));

  const discovery = await fetch(`${base}/.well-known/consequence-rail`);
  assert.equal(discovery.status, 200);
  assert.equal(discovery.headers.get("x-content-type-options"), "nosniff");
  assert.match(discovery.headers.get("content-security-policy"), /default-src 'none'/);

  const wrongMethod = await fetch(`${base}/v0/actions`);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");
  const wrongMethodBody = await wrongMethod.json();
  assert.equal(wrongMethodBody.code, "METHOD_NOT_ALLOWED");
  assert.match(wrongMethodBody.request_id, /^req_[A-Za-z0-9_-]{22}$/);

  const textPlain = await fetch(`${base}/v0/actions`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: proposal,
  });
  assert.equal(textPlain.status, 415);

  const unknownQuery = await fetch(`${base}/v0/actions?unexpected=value`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: proposal,
  });
  assert.equal(unknownQuery.status, 400);
  assert.equal(runtime.rail.actions.size, 0);

  const repeatedQuery = await fetch(
    `${base}/v0/actions/act_00000000000000000000/bundle?profile=audit&profile=receipt`,
  );
  assert.equal(repeatedQuery.status, 400);
  assert.equal(runtime.rail.actions.size, 0);

  const malformed = await fetch(`${base}/v0/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not-json",
  });
  assert.equal(malformed.status, 400);
  const malformedBody = await malformed.json();
  assert.equal(malformedBody.code, "REQUEST_INVALID");
  assert.equal(malformedBody.message, "Request body must be valid JSON.");
  assert.match(malformedBody.request_id, /^req_[A-Za-z0-9_-]{22}$/);
  assert.equal(malformedBody.action_id, undefined);

  const missing = await fetch(`${base}/v0/actions/act_00000000000000000000`);
  assert.equal(missing.status, 404);
  const missingBody = await missing.json();
  assert.equal(missingBody.code, "ACTION_NOT_FOUND");
  assert.equal(missingBody.action_id, "act_00000000000000000000");
  assert.match(missingBody.request_id, /^req_[A-Za-z0-9_-]{22}$/);
  assert.notEqual(missingBody.request_id, malformedBody.request_id);

  const invalidId = await fetch(`${base}/v0/actions/not-an-action`);
  assert.equal(invalidId.status, 400);
  const invalidBody = await invalidId.json();
  assert.equal(invalidBody.code, "REQUEST_INVALID");
  assert.equal(invalidBody.message, "Action identifier is invalid.");
  assert.equal(invalidBody.action_id, "not-an-action");
  assert.match(invalidBody.request_id, /^req_[A-Za-z0-9_-]{22}$/);

  const crossOrigin = await fetch(`${base}/v0/actions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://example.invalid",
    },
    body: proposal,
  });
  assert.equal(crossOrigin.status, 403);

  const oversized = await fetch(`${base}/v0/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(65_537) }),
  });
  assert.equal(oversized.status, 413);

  const hostileHost = await rawHttpRequest({
    port: address.port,
    path: "/v0/actions",
    method: "POST",
    headers: {
      host: `example.invalid:${address.port}`,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(proposal),
    },
    body: proposal,
  });
  assert.equal(hostileHost.status, 400);
  assert.equal(runtime.rail.actions.size, 0);
});

test("HTTP propose rejects unsafe evidence max-age before consuming action capacity", async (context) => {
  const runtime = createDemoRuntime();
  const server = createReferenceServer({ runtime });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());

  const address = server.address();
  const proposal = buildRefundProposal(runtime.clock);
  proposal.evidence_plan.max_age_seconds = 1e20;
  const response = await fetch(`http://127.0.0.1:${address.port}/v0/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(proposal),
  });
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.code, "SCHEMA_INVALID");
  assert.match(body.request_id, /^req_[A-Za-z0-9_-]{22}$/);
  assert.equal(runtime.rail.actions.size, 0);
});

test("HTTP sidecar logs unexpected exceptions and returns INTERNAL_ERROR with a request id", async (context) => {
  const runtime = createDemoRuntime();
  runtime.rail.propose = () => {
    throw new Error("connector timeout detail must not escape");
  };
  const server = createReferenceServer({ runtime });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());

  const writes = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, encoding, callback) => {
    writes.push(String(chunk));
    return originalWrite(chunk, encoding, callback);
  };
  context.after(() => {
    process.stderr.write = originalWrite;
  });

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/v0/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildRefundProposal(runtime.clock)),
  });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.code, "INTERNAL_ERROR");
  assert.equal(body.message, "Request could not be processed.");
  assert.match(body.request_id, /^req_[A-Za-z0-9_-]{22}$/);
  assert.equal(JSON.stringify(body).includes("connector timeout detail"), false);
  assert.equal(runtime.rail.actions.size, 0);

  const diagnostic = writes
    .flatMap((chunk) => chunk.trim().split("\n"))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .find((item) => item?.code === "INTERNAL_ERROR" && item.request_id === body.request_id);
  assert.ok(diagnostic);
  assert.equal(diagnostic.message, "connector timeout detail must not escape");
});

test("HTTP sidecar closes an over-cap request instead of waiting for the declared body", async (context) => {
  const runtime = createDemoRuntime();
  const server = createReferenceServer({ runtime });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const { port } = server.address();
  const payload = JSON.stringify(buildRefundProposal(runtime.clock));
  assert.ok(payload.length < 65_536);
  const outcome = await socketOutcome(
    port,
    `POST /v0/actions HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: 5000000\r\n` +
      `\r\n` +
      payload,
    2_000,
  );
  assert.equal(outcome.closed, true, "server left a declared 5 MB request open after rejecting it");
});

test("HTTP sidecar still answers a valid proposal on the same route", async (context) => {
  const runtime = createDemoRuntime();
  const server = createReferenceServer({ runtime });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const { port } = server.address();
  const body = JSON.stringify(buildRefundProposal(runtime.clock));
  const response = await rawHttpRequest({
    port,
    path: "/v0/actions",
    method: "POST",
    headers: {
      host: `127.0.0.1:${port}`,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    },
    body,
  });
  assert.equal(response.status, 201);
  assert.match(response.body, /"action_id"/);
});
