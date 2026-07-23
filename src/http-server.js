import { createServer } from "node:http";
import { createDemoRuntime } from "./demo.js";
import { RailError } from "./errors.js";
import { demoConnectorTrustedKeys, demoTrustedKeys } from "./signing.js";
import { verifyBundle } from "./verify.js";

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function errorStatus(error) {
  if (error.code === "ACTION_NOT_FOUND") return 404;
  if (error.code === "SCHEMA_INVALID" || error.code?.startsWith("EVIDENCE_")) return 422;
  if (
    error.code === "ILLEGAL_TRANSITION" ||
    error.code === "PERMIT_USED" ||
    error.code === "MODE_NOT_EXECUTABLE"
  ) {
    return 409;
  }
  return 400;
}

export function createReferenceServer({ runtime = createDemoRuntime() } = {}) {
  const { rail } = runtime;
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const path = url.pathname;

      if (request.method === "GET" && path === "/.well-known/consequence-rail") {
        send(response, 200, {
          protocol_version: "v0.1",
          implementation: "consequence-rail-node-reference",
          assurance_modes: ["enforced", "cooperative", "observed"],
          executable_modes: ["enforced", "cooperative"],
          connector: runtime.connector.capabilities(),
        });
        return;
      }

      if (request.method === "POST" && path === "/v0/actions") {
        send(response, 201, rail.propose(await readJson(request)));
        return;
      }

      if (request.method === "POST" && path === "/v0/bundles/verify") {
        send(response, 200, verifyBundle(await readJson(request), {
          trustedKeys: demoTrustedKeys(),
          trustedConnectorKeys: demoConnectorTrustedKeys(),
          requireSemantics: true,
        }));
        return;
      }

      const match = path.match(/^\/v0\/actions\/([^/]+)(?:\/([^/]+))?$/);
      if (match) {
        const [, actionId, operation] = match;
        if (request.method === "GET" && !operation) {
          send(response, 200, rail.inspect(actionId));
          return;
        }
        if (request.method === "GET" && operation === "bundle") {
          send(response, 200, rail.exportBundle(actionId, {
            profile: url.searchParams.get("profile") ?? "receipt",
          }));
          return;
        }
        if (request.method === "POST" && operation === "authorize") {
          send(response, 200, rail.authorize(actionId, await readJson(request)));
          return;
        }
        if (request.method === "POST" && operation === "recourse") {
          send(response, 200, rail.reserveRecourse(actionId, await readJson(request)));
          return;
        }
        if (request.method === "POST" && operation === "permit") {
          send(response, 200, rail.issuePermit(actionId));
          return;
        }
        if (request.method === "POST" && operation === "execute") {
          send(response, 200, await rail.execute(actionId, await readJson(request)));
          return;
        }
        if (request.method === "POST" && operation === "reconcile") {
          send(response, 200, await rail.reconcile(actionId));
          return;
        }
        if (request.method === "POST" && operation === "verify-outcome") {
          send(response, 200, await rail.verifyOutcome(actionId, await readJson(request)));
          return;
        }
        if (request.method === "POST" && operation === "remediate") {
          send(response, 200, await rail.remediate(actionId, await readJson(request)));
          return;
        }
        if (request.method === "POST" && operation === "reconcile-remedy") {
          send(response, 200, await rail.reconcileRemedy(actionId, await readJson(request)));
          return;
        }
      }

      send(response, 404, {
        code: "ROUTE_NOT_FOUND",
        message: "Route was not found.",
      });
    } catch (error) {
      const railError =
        error instanceof RailError
          ? error
          : new RailError("REQUEST_INVALID", error.message);
      send(response, errorStatus(railError), railError.toJSON());
    }
  });
}
