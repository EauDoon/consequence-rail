// The implementation version, read from package.json so that file stays the
// only place it is written. JSON import attributes and import.meta.dirname are
// avoided because early Node 20 releases lack them.

import { readFileSync } from "node:fs";

export const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
