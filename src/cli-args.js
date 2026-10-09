// Argument parsing for cmd/crctl.js. It lives here, not in the command file,
// because crctl runs main() on import and so cannot be unit-tested in place.

import { RailError } from "./errors.js";

export const VALUE_FLAGS = Object.freeze({
  "--fault": "fault",
  "--assurance": "assurance",
  "--out": "out",
  "--at": "at",
  "--expect-digest": "expect-digest",
  "--expect-other-digest": "expect-other-digest",
  "--require-outcome": "require-outcome",
});

export const BOOL_FLAGS = Object.freeze({
  "--json": "json",
  "--markdown": "markdown",
  "--require-qualified": "require-qualified",
});

// An unpadded base64url SHA-256 digest starts with "-" about 1 time in 64.
// No flag name has this shape, so a digest pin may begin with a dash.
const DIGEST_PIN_FLAGS = new Set(["--expect-digest", "--expect-other-digest"]);
const DIGEST_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function usage(message) {
  return new RailError("USAGE_INVALID", `${message} Run with --help.`);
}

function acceptsNextValue(flag, value) {
  if (value === undefined) return false;
  if (!value.startsWith("-")) return true;
  return DIGEST_PIN_FLAGS.has(flag) && DIGEST_TOKEN.test(value);
}

export function parseCliArgs(args) {
  const positional = [];
  const options = {};
  const setValue = (flag, name, value) => {
    if (Object.hasOwn(options, name)) {
      throw usage(`Flag ${flag} was supplied more than once.`);
    }
    options[name] = value;
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    const separator = arg.startsWith("--") ? arg.indexOf("=") : -1;
    if (separator !== -1) {
      const flag = arg.slice(0, separator);
      const value = arg.slice(separator + 1);
      if (Object.hasOwn(BOOL_FLAGS, flag)) {
        throw usage(`Flag ${flag} does not take a value.`);
      }
      if (!Object.hasOwn(VALUE_FLAGS, flag)) {
        throw usage(`Unknown flag ${flag}.`);
      }
      if (value === "") {
        throw usage(`${flag} requires a value.`);
      }
      setValue(flag, VALUE_FLAGS[flag], value);
      continue;
    }
    if (Object.hasOwn(BOOL_FLAGS, arg)) {
      setValue(arg, BOOL_FLAGS[arg], true);
      continue;
    }
    if (Object.hasOwn(VALUE_FLAGS, arg)) {
      const value = args[index + 1];
      if (!acceptsNextValue(arg, value)) {
        throw usage(`${arg} requires a value.`);
      }
      setValue(arg, VALUE_FLAGS[arg], value);
      index += 1;
      continue;
    }
    throw usage(`Unknown flag ${arg}.`);
  }
  return { positional, options };
}
