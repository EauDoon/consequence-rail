import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { SystemClock } from "./clock.js";
import { createDemoRuntime } from "./demo.js";
import { RailError } from "./errors.js";
import { demoConnectorTrustedKeys, demoTrustedKeys } from "./signing.js";
import { verifyBundle } from "./verify.js";

const MAX_BODY_BYTES = 65_536;
const MAX_URL_BYTES = 2_048;
const MAX_CONCURRENT_REQUESTS = 32;
const MAX_REQUESTS_PER_MINUTE = 600;
const ACTION_ID = /^act_[A-Za-z0-9_-]{20}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;

function createRequestId() {
  return `req_${randomBytes(16).toString("base64url")}`;
}

function requestError(code, message, details = {}) {
  return new RailError(code, message, details);
}

async function readJson(request, { required = false } = {}) {
  const contentEncoding = request.headers["content-encoding"];
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    throw requestError(
      "CONTENT_ENCODING_UNSUPPORTED",
      "Request content encoding is not supported.",
    );
  }

  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined) {
    if (!/^\d+$/.test(declaredLength)) {
      throw requestError("REQUEST_INVALID", "Content-Length is invalid.");
    }
    if (Number(declaredLength) > MAX_BODY_BYTES) {
      throw requestError("REQUEST_TOO_LARGE", "Request body is too large.");
    }
  }

  const contentType = request.headers["content-type"];
  const mayHaveBody =
    required ||
    Number(declaredLength ?? 0) > 0 ||
    request.headers["transfer-encoding"] !== undefined;
  if (mayHaveBody && (!contentType || !JSON_CONTENT_TYPE.test(contentType))) {
    throw requestError(
      "MEDIA_TYPE_UNSUPPORTED",
      "JSON requests require application/json with optional UTF-8 charset.",
    );
  }

  const chunks = [];
  let received = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      tooLarge = true;
      // Destroy the request so the body stops streaming. Without this, the
      // client keeps sending bytes and the loop continues until EOF, which
      // is a cheap bandwidth-exhaustion DoS for any host the sidecar runs on.
      request.destroy();
      break;
    }
    if (!tooLarge) chunks.push(chunk);
  }
  if (tooLarge) {
    throw requestError("REQUEST_TOO_LARGE", "Request body is too large.");
  }
  if (received === 0) {
    if (required) {
      throw requestError("REQUEST_INVALID", "A JSON request body is required.");
    }
    return {};
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw requestError("REQUEST_INVALID", "Request body must be valid UTF-8 JSON.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw requestError("REQUEST_INVALID", "Request body must be valid JSON.");
  }
}

function assertNoBody(request) {
  if (
    Number(request.headers["content-length"] ?? 0) !== 0 ||
    request.headers["transfer-encoding"] !== undefined
  ) {
    throw requestError("REQUEST_INVALID", "This route does not accept a request body.");
  }
}

async function readEmptyJson(request) {
  const body = await readJson(request);
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.getPrototypeOf(body) !== Object.prototype ||
    Object.keys(body).length !== 0
  ) {
    throw requestError("REQUEST_INVALID", "This route accepts only an empty JSON object.");
  }
}

function send(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function errorStatus(error) {
  if (error.code === "INTERNAL_ERROR") return 500;
  if (error.code === "ACTION_NOT_FOUND" || error.code === "ROUTE_NOT_FOUND") return 404;
  if (error.code === "METHOD_NOT_ALLOWED") return 405;
  if (error.code === "REQUEST_TOO_LARGE") return 413;
  if (
    error.code === "MEDIA_TYPE_UNSUPPORTED" ||
    error.code === "CONTENT_ENCODING_UNSUPPORTED"
  ) return 415;
  if (error.code === "ORIGIN_FORBIDDEN") return 403;
  if (error.code === "RATE_LIMITED") return 429;
  if (error.code === "ACTION_CAPACITY_REACHED") return 503;
  if (
    error.code === "SCHEMA_INVALID" ||
    error.code?.startsWith("EVIDENCE_") ||
    error.code?.startsWith("RECOVERY_")
  ) return 422;
  if (
    error.code === "ILLEGAL_TRANSITION" ||
    error.code === "PERMIT_USED" ||
    error.code === "MODE_NOT_EXECUTABLE"
  ) {
    return 409;
  }
  return 400;
}

function failureBody(error, requestId, extra = {}) {
  return {
    ...(error instanceof RailError ? error.toJSON() : {
      code: error.code,
      message: error.message,
    }),
    ...extra,
    request_id: requestId,
  };
}

function hostUrl(request) {
  const host = request.headers.host;
  const hostHeaderCount = request.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === "host",
  ).length;
  if (hostHeaderCount !== 1 || typeof host !== "string" || host.length > 255) {
    throw requestError("HOST_INVALID", "Host must identify this loopback server.");
  }
  let parsed;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    throw requestError("HOST_INVALID", "Host must identify this loopback server.");
  }
  const localPort = String(request.socket.localPort);
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    !LOOPBACK_HOSTS.has(parsed.hostname) ||
    parsed.port !== localPort
  ) {
    throw requestError("HOST_INVALID", "Host must identify this loopback server.");
  }
  return parsed;
}

function assertRequestBoundary(request) {
  const target = request.url;
  if (
    typeof target !== "string" ||
    Buffer.byteLength(target, "utf8") > MAX_URL_BYTES ||
    !target.startsWith("/") ||
    target.startsWith("//") ||
    target.includes("\\") ||
    target.includes("#")
  ) {
    throw requestError("REQUEST_INVALID", "Request target is invalid.");
  }
  const remoteAddress = request.socket.remoteAddress;
  if (
    !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddress)
  ) {
    throw requestError("ORIGIN_FORBIDDEN", "Only loopback clients are accepted.");
  }
  const host = hostUrl(request);
  const origin = request.headers.origin;
  if (origin !== undefined) {
    let parsedOrigin;
    try {
      parsedOrigin = new URL(origin);
    } catch {
      throw requestError("ORIGIN_FORBIDDEN", "Origin is not accepted.");
    }
    if (parsedOrigin.origin !== host.origin) {
      throw requestError("ORIGIN_FORBIDDEN", "Origin is not accepted.");
    }
  }
  return new URL(target, "http://127.0.0.1");
}

function methodNotAllowed(response, allowed, requestId) {
  send(
    response,
    405,
    {
      code: "METHOD_NOT_ALLOWED",
      message: "Method is not allowed for this route.",
      request_id: requestId,
    },
    { allow: allowed.join(", ") },
  );
}

function assertQueryParameters(url, allowed = []) {
  const keys = [...url.searchParams.keys()];
  const allowedSet = new Set(allowed);
  if (
    keys.some((key) => !allowedSet.has(key)) ||
    new Set(keys).size !== keys.length
  ) {
    throw requestError("REQUEST_INVALID", "Unknown or repeated query parameter.");
  }
}

export function createReferenceServer({
  runtime = createDemoRuntime({ clock: new SystemClock() }),
} = {}) {
  const { rail } = runtime;
  let activeRequests = 0;
  const rateByAddress = new Map();

  const server = createServer({ maxHeaderSize: 16_384 }, async (request, response) => {
    const requestId = createRequestId();
    if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
      send(response, 503, {
        code: "SERVER_BUSY",
        message: "The local reference server is busy.",
        request_id: requestId,
      });
      return;
    }
    activeRequests += 1;
    let actionId;
    try {
      const url = assertRequestBoundary(request);
      const now = Date.now();
      const address = request.socket.remoteAddress;
      const rate = rateByAddress.get(address);
      const currentRate = !rate || now - rate.startedAt >= 60_000
        ? { startedAt: now, count: 0 }
        : rate;
      currentRate.count += 1;
      rateByAddress.set(address, currentRate);
      if (currentRate.count > MAX_REQUESTS_PER_MINUTE) {
        throw requestError("RATE_LIMITED", "Request rate limit exceeded.");
      }

      const path = url.pathname;

      if (path === "/.well-known/consequence-rail") {
        assertQueryParameters(url);
        if (request.method !== "GET") {
          methodNotAllowed(response, ["GET"], requestId);
          return;
        }
        assertNoBody(request);
        send(response, 200, {
          protocol_version: "v0.1",
          implementation: "consequence-rail-node-reference",
          assurance_modes: ["enforced", "cooperative", "observed"],
          executable_modes: ["enforced", "cooperative"],
          optional_features: ["recovery-preflight/v0.1"],
          connector: runtime.connector.capabilities(),
        });
        return;
      }

      if (path === "/v0/actions") {
        assertQueryParameters(url);
        if (request.method !== "POST") {
          methodNotAllowed(response, ["POST"], requestId);
          return;
        }
        send(response, 201, rail.propose(await readJson(request, { required: true })));
        return;
      }

      if (path === "/v0/bundles/verify") {
        assertQueryParameters(url);
        if (request.method !== "POST") {
          methodNotAllowed(response, ["POST"], requestId);
          return;
        }
        send(response, 200, verifyBundle(await readJson(request, { required: true }), {
          trustedKeys: demoTrustedKeys(),
          trustedConnectorKeys: demoConnectorTrustedKeys(),
          requireSemantics: true,
        }));
        return;
      }

      const match = path.match(/^\/v0\/actions\/([^/]+)(?:\/([^/]+))?$/);
      if (match) {
        const [, matchedActionId, operation] = match;
        actionId = matchedActionId;
        assertQueryParameters(url, operation === "bundle" ? ["profile"] : []);
        if (!ACTION_ID.test(actionId)) {
          throw requestError("REQUEST_INVALID", "Action identifier is invalid.", {
            action_id: actionId,
          });
        }
        const allowedMethod = !operation || operation === "bundle" ? "GET" : "POST";
        const knownOperations = new Set([
          undefined,
          "bundle",
          "authorize",
          "recourse",
          "recovery-preflight",
          "permit",
          "execute",
          "reconcile",
          "verify-outcome",
          "remediate",
          "reconcile-remedy",
        ]);
        if (!knownOperations.has(operation)) {
          throw requestError("ROUTE_NOT_FOUND", "Route was not found.");
        }
        if (request.method !== allowedMethod) {
          methodNotAllowed(response, [allowedMethod], requestId);
          return;
        }
        if (!operation) {
          assertNoBody(request);
          send(response, 200, rail.inspect(actionId));
          return;
        }
        if (operation === "bundle") {
          assertNoBody(request);
          send(response, 200, rail.exportBundle(actionId, {
            profile: url.searchParams.get("profile") ?? "receipt",
          }));
          return;
        }
        if (operation === "authorize") {
          send(response, 200, rail.authorize(actionId, await readJson(request, { required: true })));
          return;
        }
        if (operation === "recourse") {
          send(response, 200, rail.reserveRecourse(actionId, await readJson(request, { required: true })));
          return;
        }
        if (operation === "recovery-preflight") {
          send(response, 200, rail.acceptRecoveryQualification(
            actionId,
            await readJson(request, { required: true }),
          ));
          return;
        }
        if (operation === "permit") {
          await readEmptyJson(request);
          send(response, 200, rail.issuePermit(actionId));
          return;
        }
        if (operation === "execute") {
          send(response, 200, await rail.execute(actionId, await readJson(request)));
          return;
        }
        if (operation === "reconcile") {
          await readEmptyJson(request);
          send(response, 200, await rail.reconcile(actionId));
          return;
        }
        if (operation === "verify-outcome") {
          send(response, 200, await rail.verifyOutcome(actionId, await readJson(request)));
          return;
        }
        if (operation === "remediate") {
          send(response, 200, await rail.remediate(actionId, await readJson(request)));
          return;
        }
        send(response, 200, await rail.reconcileRemedy(actionId, await readJson(request)));
        return;
      }

      throw requestError("ROUTE_NOT_FOUND", "Route was not found.");
    } catch (error) {
      const extra = actionId && error?.details?.action_id === undefined
        ? { action_id: actionId }
        : {};
      if (error instanceof RailError) {
        send(response, errorStatus(error), failureBody(error, requestId, extra));
        return;
      }
      process.stderr.write(
        `${JSON.stringify({
          code: "INTERNAL_ERROR",
          request_id: requestId,
          ...(extra.action_id ? { action_id: extra.action_id } : {}),
          message: error instanceof Error ? error.message : "Request could not be processed.",
        })}\n`,
      );
      send(
        response,
        500,
        failureBody(
          new RailError("INTERNAL_ERROR", "Request could not be processed."),
          requestId,
          extra,
        ),
      );
    } finally {
      activeRequests -= 1;
    }
  });

  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  return server;
}
