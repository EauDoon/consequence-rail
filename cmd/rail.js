#!/usr/bin/env node

import { createReferenceServer } from "../src/http-server.js";

function parsePort(args) {
  const index = args.indexOf("--port");
  if (index < 0) return 8787;
  const port = Number(args[index + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("--port must be an integer between 0 and 65535.");
  }
  return port;
}

const port = parsePort(process.argv.slice(2));
const server = createReferenceServer();
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(
    `Consequence Rail reference sidecar listening on http://127.0.0.1:${address.port}\n`,
  );
});
