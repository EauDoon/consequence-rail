// Streamable HTTP transport for the MCP gateway, with the authorization
// surface of the MCP specification: the server is an OAuth 2.1 protected
// resource, publishes RFC 9728 metadata, answers a missing or invalid bearer
// token with 401, and answers a gated tool call without the gated scope with
// 403 insufficient_scope so the client can step up. Token validation is the
// operator's verifyToken hook; this module never issues tokens.

import { createServer } from "node:http";
import { parseUniqueJson } from "./json-input.js";
import { JSON_RPC } from "./mcp-gateway.js";
import { RailError } from "./errors.js";

export const MCP_PATH = "/mcp";
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
export const SCOPE_READ = "rail.tools.read";
export const SCOPE_GATED = "rail.tools.gated";
const MAX_BODY_BYTES = 262_144;

function sendJson(response, status, body, headers = {}) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
    ...headers,
  });
  response.end(text);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new RailError("REQUEST_TOO_LARGE", "Request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function bearerToken(request) {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/.exec(header);
  return match ? match[1] : null;
}

/**
 * @param {object} options
 * @param {import("./mcp-gateway.js").McpGateway} options.gateway
 * @param {string} options.resource The canonical URL of this MCP server.
 * @param {string[]} options.authorizationServers Issuer URLs for clients.
 * @param {Function} options.verifyToken (token) => { scopes: string[] } or
 *   null. It must check issuer, audience (this resource) and expiry.
 * @param {string[]} [options.allowedOrigins] Browser origins allowed to call.
 */
export function createMcpHttpServer({
  gateway,
  resource,
  authorizationServers,
  verifyToken,
  allowedOrigins = [],
} = {}) {
  if (!gateway || typeof gateway.handleMessage !== "function") {
    throw new RailError("CONFIG_INVALID", "createMcpHttpServer needs an McpGateway.");
  }
  if (typeof resource !== "string" || !/^https?:\/\//.test(resource)) {
    throw new RailError("CONFIG_INVALID", "resource must be the server's absolute URL.");
  }
  if (!Array.isArray(authorizationServers) || authorizationServers.length === 0) {
    throw new RailError("CONFIG_INVALID", "At least one authorization server is required.");
  }
  if (typeof verifyToken !== "function") {
    throw new RailError("CONFIG_INVALID", "verifyToken is required; the MCP gateway does not run without auth.");
  }
  const metadataUrl = new URL(PROTECTED_RESOURCE_METADATA_PATH, resource).href;
  const metadata = {
    resource,
    authorization_servers: [...authorizationServers],
    scopes_supported: [SCOPE_READ, SCOPE_GATED],
    bearer_methods_supported: ["header"],
    resource_name: "Consequence Rail MCP gateway",
  };
  const origins = new Set(allowedOrigins);

  const challenge = (extra = "") =>
    `Bearer resource_metadata="${metadataUrl}", scope="${SCOPE_READ}"${extra}`;

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      // DNS rebinding guard: a browser Origin must be explicitly allowed.
      if (request.headers.origin !== undefined && !origins.has(request.headers.origin)) {
        sendJson(response, 403, { error: "origin_forbidden" });
        return;
      }
      if (url.pathname === PROTECTED_RESOURCE_METADATA_PATH) {
        if (request.method !== "GET") {
          sendJson(response, 405, { error: "method_not_allowed" }, { allow: "GET" });
          return;
        }
        sendJson(response, 200, metadata);
        return;
      }
      if (url.pathname !== MCP_PATH) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      if (request.method !== "POST") {
        // This transport answers each POST with one JSON body and keeps no
        // server-initiated stream, so GET and DELETE are not offered.
        sendJson(response, 405, { error: "method_not_allowed" }, { allow: "POST" });
        return;
      }

      const token = bearerToken(request);
      const grant = token === null ? null : await verifyToken(token);
      const scopes = new Set(Array.isArray(grant?.scopes) ? grant.scopes : []);
      if (!grant || !scopes.has(SCOPE_READ)) {
        sendJson(response, 401, { error: "invalid_token" }, { "www-authenticate": challenge(', error="invalid_token"') });
        return;
      }
      const contentType = String(request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (contentType !== "application/json") {
        sendJson(response, 415, { error: "unsupported_media_type" });
        return;
      }
      let message;
      try {
        message = parseUniqueJson(await readBody(request));
      } catch (error) {
        if (error?.code === "REQUEST_TOO_LARGE") {
          sendJson(response, 413, { error: "request_too_large" });
          return;
        }
        sendJson(response, 400, { jsonrpc: "2.0", id: null, error: { code: JSON_RPC.PARSE_ERROR, message: "Parse error." } });
        return;
      }
      if (Array.isArray(message)) {
        sendJson(response, 400, { jsonrpc: "2.0", id: null, error: { code: JSON_RPC.INVALID_REQUEST, message: "Batches are not supported." } });
        return;
      }
      // Per-operation step-up: reading the catalog needs only the read
      // scope; a gated tool call needs the gated scope as well.
      if (
        message?.method === "tools/call" &&
        gateway.isGated(message.params?.name) &&
        !scopes.has(SCOPE_GATED)
      ) {
        sendJson(response, 403, { error: "insufficient_scope" }, {
          "www-authenticate":
            `Bearer error="insufficient_scope", scope="${SCOPE_READ} ${SCOPE_GATED}", resource_metadata="${metadataUrl}"`,
        });
        return;
      }
      const reply = await gateway.handleMessage(message);
      if (reply === null) {
        response.writeHead(202, { "content-length": 0 });
        response.end();
        return;
      }
      sendJson(response, 200, reply);
    } catch {
      if (!response.headersSent) sendJson(response, 500, { error: "internal_error" });
    }
  });
}
