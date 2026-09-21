// Shared helpers for the rail module test files. These mirror the inline
// helpers that previously lived inside test/rail.test.js. Each focused
// test file (test/rail.X.test.js) imports what it needs from here.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";
import { ManualClock } from "../src/clock.js";
import { buildRefundProposal } from "../src/demo.js";
import { MemoryEventStore } from "../src/event-store.js";
import { MockRefundConnector } from "../src/mock-refund-connector.js";
import { ConsequenceRail } from "../src/rail.js";
import { createDemoSigner, demoRecoveryTrustedKeys, signArtifact } from "../src/signing.js";
import { digest } from "../src/canonical.js";

export function createRuntimeWithEventStore(createEventStore, options = {}) {
  const clock = new ManualClock();
  const signer = createDemoSigner();
  const connector = new MockRefundConnector(clock);
  const eventStore = createEventStore(signer, clock);
  const rail = new ConsequenceRail({
    signer,
    clock,
    connector,
    connectorTrustedKeys: connector.trustedKeys(),
    recoveryTrustedKeys: demoRecoveryTrustedKeys(),
    requireRecoveryPreflight: options.requireRecoveryPreflight ?? false,
    eventStore,
  });
  return { clock, eventStore, rail };
}

export function createToggleEventStore(signer, clock) {
  const store = new MemoryEventStore(signer, clock);
  return {
    failureAtomicAppend: true,
    failOn: new Set(),
    skipTransitions: 0,
    append(...args) {
      if (args[1] === "STATE_TRANSITION" && this.skipTransitions > 0) {
        this.skipTransitions -= 1;
      } else if (this.failOn.has(args[1])) {
        throw new Error("event store unavailable");
      }
      return store.append(...args);
    },
    list(...args) {
      return store.list(...args);
    },
  };
}

export function createFailingAtomicEventStore(signer, clock) {
  const store = new MemoryEventStore(signer, clock);
  return {
    failureAtomicAppend: true,
    append(...args) {
      if (args[1] === "STATE_TRANSITION") {
        throw new Error("event store unavailable");
      }
      return store.append(...args);
    },
    list(...args) {
      return store.list(...args);
    },
  };
}

export function prepareRefundWithoutPermit(runtime) {
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

export async function postJson(url, body, expectedStatus = 200) {
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

export function rawSocketRequest(port, requestText) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      socket.end(requestText);
    });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

export function rawHttpRequest({ port, path, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers,
    }, (response) => {
      let chunks = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { chunks += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: chunks,
      }));
    });
    request.on("error", reject);
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

export function assertRequiredFields(schemaPath, artifact) {
  const schema = JSON.parse(readFileSync(join(process.cwd(), schemaPath), "utf8"));
  for (const field of schema.required ?? []) {
    assert.equal(
      Object.hasOwn(artifact, field),
      true,
      `${schema.title} is missing required field ${field}`,
    );
  }
}

const SHA256_BASE64URL = /^[A-Za-z0-9_-]{43}$/;
const ED25519_BASE64URL = /^[A-Za-z0-9_-]{86}$/;

export function assertCanonicalEncodings(value, path = "") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertCanonicalEncodings(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const next = path ? `${path}.${key}` : key;
    if (
      key.endsWith("_digest") ||
      key.endsWith("_digests") ||
      key === "event_hash" ||
      key === "previous_hash" ||
      key === "event_chain_head" ||
      key === "evidence_manifest"
    ) {
      for (const candidate of Array.isArray(item) ? item : [item]) {
        if (candidate !== null) {
          assert.match(candidate, SHA256_BASE64URL, next);
        }
      }
    }
    if (key === "signature" && item && typeof item === "object") {
      assert.match(item.value, ED25519_BASE64URL, next);
    }
    assertCanonicalEncodings(item, next);
  }
}

export function resignEventChain(events, signer, actionId) {
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

export function socketOutcome(port, requestText, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      socket.write(requestText);
    });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk;
    });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ closed: false, response });
    }, timeoutMs);
    socket.on("close", () => {
      clearTimeout(timer);
      resolve({ closed: true, response });
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve({ closed: true, response });
    });
  });
}
