#!/usr/bin/env node

import { createInterface } from "node:readline";
import { SystemClock } from "../src/clock.js";
import { createTicketMcpGateway, demoTicketAuthorizer } from "../src/mcp-demo.js";
import { JSON_RPC } from "../src/mcp-gateway.js";
import { parseUniqueJson } from "../src/json-input.js";
import { VERSION } from "../src/version.js";

function printHelp() {
  process.stdout.write(`Consequence Rail MCP gateway ${VERSION}

Usage:
  mcp [--demo-authorizer]
  mcp --help
  mcp --version

Runs an MCP server over stdio (one JSON-RPC message per line) in front of
the synthetic ticket connector. The gateway's rail holds the only connector
credential. list_ticket_comments is read-only and passes through.
post_ticket_comment is gated: it runs only with a signed authorization
decision over its action digest, reserved recourse and a single-use permit,
and returns the settlement outcome and receipt digest.

Options:
  --demo-authorizer   Decide gated calls with the public demonstration
                      authorizer: allow internal comments, deny public ones.
                      Without it, the first call returns authorization_required
                      and the client attaches a signed decision under
                      _meta["consequence-rail/authorization"].
  -h, --help          Show this help
  --version           Print the implementation version

Logs go to stderr; stdout carries only MCP messages.
`);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printHelp();
} else if (args.includes("--version")) {
  process.stdout.write(`consequence-rail ${VERSION}\n`);
} else if (args.some((arg) => arg !== "--demo-authorizer")) {
  process.stderr.write(`${JSON.stringify({ code: "USAGE_INVALID", message: "Unknown option. Run with --help." })}\n`);
  process.exitCode = 1;
} else {
  const clock = new SystemClock();
  const { gateway } = createTicketMcpGateway({
    clock,
    authorizer: args.includes("--demo-authorizer") ? demoTicketAuthorizer({ clock }) : null,
  });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue = Promise.resolve();
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    // Handle messages in arrival order so a resumed gated call sees the
    // pending action that the previous call created.
    queue = queue.then(async () => {
      let reply;
      try {
        reply = await gateway.handleMessage(parseUniqueJson(line));
      } catch {
        reply = { jsonrpc: "2.0", id: null, error: { code: JSON_RPC.PARSE_ERROR, message: "Parse error." } };
      }
      if (reply !== null) process.stdout.write(`${JSON.stringify(reply)}\n`);
    });
  });
  process.stderr.write(`consequence-rail MCP gateway ${VERSION} on stdio\n`);
}
