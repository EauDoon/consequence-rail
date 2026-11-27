import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { createAuthorizationDecision } from "../src/authorization.js";
import { digest } from "../src/canonical.js";
import { addMilliseconds, ManualClock } from "../src/clock.js";
import { createTicketMcpGateway, demoTicketAuthorizer } from "../src/mcp-demo.js";
import { McpGateway, MCP_META_AUTHORIZATION, MCP_META_IDEMPOTENCY_KEY } from "../src/mcp-gateway.js";
import { createMcpHttpServer, SCOPE_GATED, SCOPE_READ } from "../src/mcp-http.js";
import { repoPath } from "../src/rail-test-helpers.js";
import { createDemoAuthorizerSigner, createDemoSigner, demoConnectorTrustedKeys, demoTrustedKeys } from "../src/signing.js";
import { verifyBundle } from "../src/verify.js";

const ARGS = Object.freeze({ ticket_id: "tkt_7", body: "Refund sent, see ledger.", visibility: "internal" });
let nextId = 1;

function call(gateway, name, args, meta) {
  return gateway.handleMessage({
    jsonrpc: "2.0",
    id: nextId++,
    method: "tools/call",
    params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
  });
}

function sign(clock, actionDigest, { allow = true, signer = createDemoAuthorizerSigner() } = {}) {
  const decidedAt = clock.now();
  return createAuthorizationDecision({
    actionDigest,
    allow,
    policyId: "test-policy/v1",
    policyDigest: digest({ test: true }),
    decidedAt,
    expiresAt: addMilliseconds(decidedAt, 60_000),
  }, signer);
}

test("tool configuration refuses an ungated write and an unregistered class", () => {
  const { rail } = createTicketMcpGateway();
  const schema = { type: "object" };
  for (const tools of [
    [{ name: "write_thing", inputSchema: schema, call: () => ({}) }],
    [{ name: "write_thing", inputSchema: schema, annotations: { destructiveHint: false }, call: () => ({}) }],
    [{ name: "read_thing", inputSchema: schema, annotations: { readOnlyHint: true }, call: () => ({}), gate: {} }],
    [{
      name: "write_thing",
      inputSchema: schema,
      gate: { action_type: "other.thing.do/v1", buildProposal: () => ({}), buildReservation: () => ({}) },
    }],
    [
      { name: "same", inputSchema: schema, annotations: { readOnlyHint: true }, call: () => ({}) },
      { name: "same", inputSchema: schema, annotations: { readOnlyHint: true }, call: () => ({}) },
    ],
    [],
  ]) {
    assert.throws(() => new McpGateway({ rail, tools }), { code: "CONFIG_INVALID" });
  }
});

test("the gateway speaks MCP and marks gated tools as destructive", async () => {
  const { gateway } = createTicketMcpGateway();
  const init = await gateway.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28" } });
  assert.equal(init.result.protocolVersion, "2026-07-28");
  const fallback = await gateway.handleMessage({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal(fallback.result.protocolVersion, "2026-07-28");
  assert.equal(await gateway.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const listed = (await gateway.handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" })).result.tools;
  assert.deepEqual(listed.map((tool) => [tool.name, tool.annotations.readOnlyHint, tool.annotations.destructiveHint]), [
    ["list_ticket_comments", true, false],
    ["post_ticket_comment", false, true],
  ]);
  assert.equal(listed[1]._meta["consequence-rail/action_type"], "demo.ticket.comment/v1");
  assert.equal((await gateway.handleMessage({ jsonrpc: "2.0", id: 4, method: "resources/list" })).error.code, -32601);
  assert.equal((await gateway.handleMessage({ jsonrpc: "1.0", id: 5, method: "ping" })).error.code, -32600);
  assert.equal((await call(gateway, "no_such_tool", {})).error.code, -32602);
  assert.equal((await gateway.handleMessage({ jsonrpc: "2.0", id: 6, method: "ping" })).result.constructor, Object);
});

test("a gated call runs only after a signed decision for its exact digest", async () => {
  const { gateway, connector, clock, rail } = createTicketMcpGateway();
  const first = (await call(gateway, "post_ticket_comment", ARGS)).result;
  assert.equal(first.isError, true);
  assert.equal(first.structuredContent.status, "authorization_required");
  assert.equal(connector.executeCalls, 0);
  const { action_id: actionId, action_digest: actionDigest } = first.structuredContent;

  const unsigned = (await call(gateway, "post_ticket_comment", ARGS, {
    [MCP_META_AUTHORIZATION]: { allow: true, policy_id: "self", policy_digest: "A".repeat(43) },
  })).result;
  assert.equal(unsigned.structuredContent.code, "AUTHORIZATION_SIGNATURE_REQUIRED");

  const other = (await call(gateway, "post_ticket_comment", ARGS, {
    [MCP_META_AUTHORIZATION]: sign(clock, digest("another action")),
  })).result;
  assert.equal(other.structuredContent.code, "AUTHORIZATION_ACTION_MISMATCH");

  const forged = (await call(gateway, "post_ticket_comment", ARGS, {
    [MCP_META_AUTHORIZATION]: sign(clock, actionDigest, { signer: createDemoSigner() }),
  })).result;
  assert.equal(forged.structuredContent.code, "UNTRUSTED_KEY");
  assert.equal(connector.executeCalls, 0);
  assert.equal(rail.inspect(actionId).state, "PROPOSED");

  const done = (await call(gateway, "post_ticket_comment", ARGS, {
    [MCP_META_AUTHORIZATION]: sign(clock, actionDigest),
  })).result;
  assert.equal(done.isError, false);
  assert.equal(done.structuredContent.action_id, actionId);
  assert.equal(done.structuredContent.outcome, "settled");
  assert.match(done.structuredContent.receipt_digest, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(connector.executeCalls, 1);
  assert.equal(rail.inspect(actionId).authorizer_key_id, createDemoAuthorizerSigner().kid);

  const again = (await call(gateway, "post_ticket_comment", ARGS, {
    [MCP_META_AUTHORIZATION]: sign(clock, actionDigest),
  })).result;
  assert.equal(again.structuredContent.status, "refused");
  assert.equal(connector.executeCalls, 1, "an identical repeat never executes twice");

  const read = (await call(gateway, "list_ticket_comments", { ticket_id: "tkt_7" })).result;
  assert.equal(read.isError, false);
  assert.equal(read.structuredContent.comments.length, 1);
});

test("a policy hook decides, a denial executes nothing, and a duplicate is reversed", async () => {
  const clock = new ManualClock();
  const { gateway, connector } = createTicketMcpGateway({
    clock,
    authorizer: demoTicketAuthorizer({ clock }),
    executeOptions: { fault: "duplicate" },
  });
  const denied = (await call(gateway, "post_ticket_comment", { ...ARGS, visibility: "public" })).result;
  assert.equal(denied.structuredContent.status, "denied");
  assert.equal(connector.executeCalls, 0);

  const result = (await call(gateway, "post_ticket_comment", ARGS, { [MCP_META_IDEMPOTENCY_KEY]: "note-1" })).result;
  assert.equal(result.structuredContent.outcome, "compensated");
  assert.equal(result.isError, true);
  assert.equal(connector.listComments("tkt_7").length, 1);
  const bundle = gateway.rail.exportBundle(result.structuredContent.action_id, { profile: "audit" });
  assert.equal(verifyBundle(bundle, {
    trustedKeys: demoTrustedKeys(),
    trustedConnectorKeys: demoConnectorTrustedKeys(),
    requireSemantics: true,
  }).valid, true);
  assert.equal(bundle.action.proposal.idempotency_key, "note-1");
  assert.equal(
    (await call(gateway, "post_ticket_comment", ARGS, { [MCP_META_IDEMPOTENCY_KEY]: "" })).result.structuredContent.code,
    "SCHEMA_INVALID",
  );
});

test("the HTTP transport publishes RFC 9728 metadata and steps up for gated calls", async (context) => {
  const { gateway, clock } = createTicketMcpGateway({ authorizer: null });
  const tokens = new Map([
    ["read-token", { scopes: [SCOPE_READ] }],
    ["gated-token", { scopes: [SCOPE_READ, SCOPE_GATED] }],
  ]);
  const server = createMcpHttpServer({
    gateway,
    resource: "http://127.0.0.1/mcp",
    authorizationServers: ["https://auth.example.test"],
    verifyToken: (token) => tokens.get(token) ?? null,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, token, headers = {}) => fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });

  const metadata = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
  assert.equal(metadata.resource, "http://127.0.0.1/mcp");
  assert.deepEqual(metadata.scopes_supported, [SCOPE_READ, SCOPE_GATED]);

  const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const anonymous = await post(list);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("www-authenticate"), /resource_metadata="http:\/\/127\.0\.0\.1\/\.well-known\/oauth-protected-resource"/);
  assert.equal((await post(list, "wrong-token")).status, 401);
  assert.equal((await post(list, "read-token")).status, 200);

  const gatedCall = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "post_ticket_comment", arguments: ARGS } };
  const stepUp = await post(gatedCall, "read-token");
  assert.equal(stepUp.status, 403);
  assert.match(stepUp.headers.get("www-authenticate"), /error="insufficient_scope", scope="rail\.tools\.read rail\.tools\.gated"/);
  const readCall = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_ticket_comments", arguments: { ticket_id: "tkt_7" } } };
  assert.equal((await post(readCall, "read-token")).status, 200);

  const pending = await (await post(gatedCall, "gated-token")).json();
  assert.equal(pending.result.structuredContent.status, "authorization_required");
  const decision = sign(clock, pending.result.structuredContent.action_digest);
  const done = await (await post({ ...gatedCall, params: { ...gatedCall.params, _meta: { [MCP_META_AUTHORIZATION]: decision } } }, "gated-token")).json();
  assert.equal(done.result.structuredContent.outcome, "settled");

  assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" }, "read-token")).status, 202);
  assert.equal((await post(list, "read-token", { origin: "https://evil.example" })).status, 403);
  assert.equal((await fetch(`${base}/mcp`, { headers: { authorization: "Bearer read-token" } })).status, 405);
  assert.equal((await post([list], "read-token")).status, 400);
  const badType = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "text/plain", authorization: "Bearer read-token" },
    body: "{}",
  });
  assert.equal(badType.status, 415);
  assert.throws(() => createMcpHttpServer({ gateway, resource: "http://x/mcp", authorizationServers: ["https://a"] }), { code: "CONFIG_INVALID" });
});

test("the stdio command serves MCP with the demo authorizer", () => {
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "post_ticket_comment", arguments: ARGS } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "post_ticket_comment", arguments: { ...ARGS, visibility: "public" } } },
  ].map((message) => JSON.stringify(message)).join("\n") + "\nnot json\n";
  const result = spawnSync(process.execPath, [repoPath("cmd", "mcp.js"), "--demo-authorizer"], {
    input,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const replies = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(replies[0].result.protocolVersion, "2025-06-18");
  assert.equal(replies[1].result.structuredContent.outcome, "settled");
  assert.equal(replies[2].result.structuredContent.status, "denied");
  assert.equal(replies[3].error.code, -32700);
  const bad = spawnSync(process.execPath, [repoPath("cmd", "mcp.js"), "--bogus"], { encoding: "utf8", timeout: 5_000 });
  assert.equal(bad.status, 1);
});
