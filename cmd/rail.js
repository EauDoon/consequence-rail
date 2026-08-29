#!/usr/bin/env node

import { createReferenceServer } from "../src/http-server.js";

function printHelp() {
  process.stdout.write(`Consequence Rail reference sidecar

Usage:
  rail [--port <number>]
  rail --help

Options:
  --port <number>   Loopback TCP port (default 8787). Use 0 to bind an ephemeral port.
  -h, --help        Show this help

The sidecar listens on 127.0.0.1 only and is not an authenticated boundary.
`);
}

function usageError(message) {
  const error = new Error(message);
  error.code = "USAGE_INVALID";
  return error;
}

function parseArgs(args) {
  if (args.includes("--help") || args.includes("-h")) {
    return { help: true };
  }

  let port = 8787;
  let sawPort = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--port") {
      if (sawPort) {
        throw usageError("Flag --port was supplied more than once.");
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw usageError("--port requires an integer between 0 and 65535.");
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
        throw usageError("--port must be an integer between 0 and 65535.");
      }
      port = parsed;
      sawPort = true;
      index += 1;
      continue;
    }
    throw usageError(`Unknown argument ${arg}.`);
  }
  return { help: false, port };
}

try {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    printHelp();
  } else {
    const server = createReferenceServer();
    server.listen(parsed.port, "127.0.0.1", () => {
      const address = server.address();
      process.stdout.write(
        `Consequence Rail reference sidecar listening on http://127.0.0.1:${address.port}\n`,
      );
    });
  }
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      code: error.code === "USAGE_INVALID" ? "USAGE_INVALID" : "INTERNAL_ERROR",
      message: error.message,
    })}\n`,
  );
  process.exitCode = 1;
}
