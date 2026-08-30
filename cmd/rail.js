#!/usr/bin/env node

import { createSidecarClock, SIDECAR_CLOCKS } from "../src/clock.js";
import { createDemoRuntime } from "../src/demo.js";
import { createReferenceServer } from "../src/http-server.js";

function printHelp() {
  process.stdout.write(`Consequence Rail reference sidecar

Usage:
  rail [--port <number>] [--clock <system|demo>]
  rail --help

Options:
  --port <number>         Loopback TCP port (default 8787, or CONSEQUENCE_RAIL_PORT).
                          Use 0 to bind an ephemeral port.
  --clock <system|demo>   Time source (default system, or CONSEQUENCE_RAIL_CLOCK).
                          system uses the host clock; demo freezes 2035-01-01T00:00:00.000Z.
  -h, --help              Show this help

The sidecar listens on 127.0.0.1 only and is not an authenticated boundary.
`);
}

function usageError(message) {
  const error = new Error(message);
  error.code = "USAGE_INVALID";
  return error;
}

function envValue(env, name) {
  const value = env[name];
  if (value === undefined || value === "") {
    return undefined;
  }
  return value;
}

function parsePort(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw usageError(`${label} must be an integer between 0 and 65535.`);
  }
  return parsed;
}

function parseClock(value, label) {
  if (!SIDECAR_CLOCKS.includes(value)) {
    throw usageError(`${label} must be one of: ${SIDECAR_CLOCKS.join(", ")}.`);
  }
  return value;
}

function parseArgs(args, env = process.env) {
  if (args.includes("--help") || args.includes("-h")) {
    return { help: true };
  }

  let port;
  let clock;
  let sawPort = false;
  let sawClock = false;
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
      port = parsePort(value, "--port");
      sawPort = true;
      index += 1;
      continue;
    }
    if (arg === "--clock") {
      if (sawClock) {
        throw usageError("Flag --clock was supplied more than once.");
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw usageError("--clock requires a value of system or demo.");
      }
      clock = parseClock(value, "--clock");
      sawClock = true;
      index += 1;
      continue;
    }
    throw usageError(`Unknown argument ${arg}.`);
  }
  if (!sawPort) {
    const envPort = envValue(env, "CONSEQUENCE_RAIL_PORT");
    port = envPort === undefined ? 8787 : parsePort(envPort, "CONSEQUENCE_RAIL_PORT");
  }
  if (!sawClock) {
    const envClock = envValue(env, "CONSEQUENCE_RAIL_CLOCK");
    clock = envClock === undefined ? "system" : parseClock(envClock, "CONSEQUENCE_RAIL_CLOCK");
  }
  return { help: false, port, clock };
}

try {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    printHelp();
  } else {
    const server = createReferenceServer({
      runtime: createDemoRuntime({ clock: createSidecarClock(parsed.clock) }),
    });
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
