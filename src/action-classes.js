// Registered action classes. ActionProposal v0.3 admits any action type that
// the rail operator registers here, instead of the fixed demo enum of v0.1
// and v0.2. A class declares a closed parameter schema, the remedy scope
// field and the parameter it must cover, the remedy kinds it allows, and the
// evidence facts that must equal named parameters. A v0.3 proposal repeats
// the scope and bindings, so an offline verifier can check them without the
// registry.

import { deepClone, deepFreeze } from "./canonical.js";
import { RailError } from "./errors.js";

export const ACTION_TYPE_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+\/v[1-9][0-9]*$/;
export const SCOPE_FIELDS = Object.freeze(["max_amount_minor", "max_quantity"]);
export const REMEDY_KINDS = Object.freeze(["reverse", "compensate", "escalate"]);
export const RESERVED_ACTION_TYPES = Object.freeze([
  "demo.refund.issue/v1",
  "demo.email.send/v1",
  "demo.inventory.allocate/v1",
]);

/** True for a well-formed, non-reserved v0.3 action type. */
export function isOpenActionType(value) {
  return typeof value === "string" &&
    ACTION_TYPE_PATTERN.test(value) &&
    !RESERVED_ACTION_TYPES.includes(value);
}
const PARAMETER_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const FACT_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const MAX_PARAMETERS = 32;
const MAX_STRING_LENGTH = 4_096;
const MAX_PATTERN_LENGTH = 256;

const CLASS_FIELDS = new Set(["action_type", "parameters", "recourse", "evidence_bindings", "description"]);
const STRING_SPEC_FIELDS = new Set(["type", "min_length", "max_length", "pattern", "enum"]);
const INTEGER_SPEC_FIELDS = new Set(["type", "minimum", "maximum"]);
const BOOLEAN_SPEC_FIELDS = new Set(["type"]);
const RECOURSE_FIELDS = new Set(["scope_field", "covers_parameter", "kinds"]);
const BINDING_FIELDS = new Set(["fact", "parameter"]);

function invalid(message, code = "ACTION_CLASS_INVALID") {
  return new RailError(code, message);
}

function isPlainObject(value) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function closed(value, fields, label, required = fields) {
  if (!isPlainObject(value)) throw invalid(`${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) throw invalid(`${label} has an unsupported field ${key}.`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw invalid(`${label} is missing ${key}.`);
  }
}

function optionalSafeInteger(value, label, min = Number.MIN_SAFE_INTEGER) {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < min) {
    throw invalid(`${label} must be a safe integer.`);
  }
}

function checkParameterSpec(name, spec) {
  const label = `Action class parameter ${name}`;
  if (!isPlainObject(spec)) throw invalid(`${label} must be an object.`);
  if (spec.type === "string") {
    closed(spec, STRING_SPEC_FIELDS, label, ["type"]);
    optionalSafeInteger(spec.min_length, `${label}.min_length`, 0);
    optionalSafeInteger(spec.max_length, `${label}.max_length`, 1);
    if ((spec.max_length ?? MAX_STRING_LENGTH) > MAX_STRING_LENGTH) {
      throw invalid(`${label}.max_length may not exceed ${MAX_STRING_LENGTH}.`);
    }
    if (spec.pattern !== undefined) {
      if (typeof spec.pattern !== "string" || spec.pattern.length === 0 || spec.pattern.length > MAX_PATTERN_LENGTH) {
        throw invalid(`${label}.pattern must be a short non-empty string.`);
      }
      try {
        new RegExp(spec.pattern, "u");
      } catch {
        throw invalid(`${label}.pattern is not a valid regular expression.`);
      }
    }
    if (spec.enum !== undefined) {
      if (
        !Array.isArray(spec.enum) ||
        spec.enum.length === 0 ||
        !spec.enum.every((item) => typeof item === "string") ||
        new Set(spec.enum).size !== spec.enum.length
      ) {
        throw invalid(`${label}.enum must be a non-empty list of distinct strings.`);
      }
    }
    return;
  }
  if (spec.type === "integer") {
    closed(spec, INTEGER_SPEC_FIELDS, label, ["type"]);
    optionalSafeInteger(spec.minimum, `${label}.minimum`);
    optionalSafeInteger(spec.maximum, `${label}.maximum`);
    if (spec.minimum !== undefined && spec.maximum !== undefined && spec.minimum > spec.maximum) {
      throw invalid(`${label}.minimum exceeds maximum.`);
    }
    return;
  }
  if (spec.type === "boolean") {
    closed(spec, BOOLEAN_SPEC_FIELDS, label, ["type"]);
    return;
  }
  throw invalid(`${label}.type must be string, integer or boolean.`);
}

/** Check one class definition and return a frozen copy. */
export function defineActionClass(definition) {
  closed(definition, CLASS_FIELDS, "Action class", ["action_type", "parameters", "recourse", "evidence_bindings"]);
  if (typeof definition.action_type !== "string" || !ACTION_TYPE_PATTERN.test(definition.action_type)) {
    throw invalid("Action class action_type must look like domain.verb/v1 in lower case.");
  }
  if (RESERVED_ACTION_TYPES.includes(definition.action_type)) {
    // The v0.1 and v0.2 demo types keep their own published schemas.
    throw invalid("Action class action_type is reserved by an earlier proposal schema.");
  }
  if (definition.description !== undefined && typeof definition.description !== "string") {
    throw invalid("Action class description must be a string.");
  }
  if (!isPlainObject(definition.parameters)) throw invalid("Action class parameters must be an object.");
  const names = Object.keys(definition.parameters);
  if (names.length === 0 || names.length > MAX_PARAMETERS) {
    throw invalid(`Action class must declare 1 to ${MAX_PARAMETERS} parameters.`);
  }
  for (const name of names) {
    if (!PARAMETER_NAME.test(name)) throw invalid(`Action class parameter name ${name} is invalid.`);
    checkParameterSpec(name, definition.parameters[name]);
  }
  closed(definition.recourse, RECOURSE_FIELDS, "Action class recourse");
  if (!SCOPE_FIELDS.includes(definition.recourse.scope_field)) {
    throw invalid(`Action class recourse.scope_field must be one of ${SCOPE_FIELDS.join(", ")}.`);
  }
  const covers = definition.recourse.covers_parameter;
  if (covers !== null) {
    if (definition.parameters[covers]?.type !== "integer") {
      throw invalid("Action class recourse.covers_parameter must name an integer parameter or be null.");
    }
  }
  const kinds = definition.recourse.kinds;
  if (
    !Array.isArray(kinds) ||
    kinds.length === 0 ||
    !kinds.every((kind) => REMEDY_KINDS.includes(kind)) ||
    new Set(kinds).size !== kinds.length
  ) {
    throw invalid(`Action class recourse.kinds must be distinct values from ${REMEDY_KINDS.join(", ")}.`);
  }
  checkBindings(definition.evidence_bindings, definition.parameters, invalid);
  return deepFreeze(deepClone(definition));
}

function checkBindings(bindings, parameters, fail) {
  if (!Array.isArray(bindings) || bindings.length > MAX_PARAMETERS) {
    throw fail(`Evidence bindings must be a list of at most ${MAX_PARAMETERS} entries.`);
  }
  const seen = new Set();
  for (const [index, binding] of bindings.entries()) {
    const label = `Evidence binding ${index}`;
    if (!isPlainObject(binding)) throw fail(`${label} must be an object.`);
    for (const key of Object.keys(binding)) {
      if (!BINDING_FIELDS.has(key)) throw fail(`${label} has an unsupported field.`);
    }
    if (typeof binding.fact !== "string" || !FACT_PATH.test(binding.fact)) {
      throw fail(`${label}.fact must be a dot-separated fact path.`);
    }
    if (typeof binding.parameter !== "string" || !Object.hasOwn(parameters, binding.parameter)) {
      throw fail(`${label}.parameter must name a declared parameter.`);
    }
    const key = `${binding.fact}\u0000${binding.parameter}`;
    if (seen.has(key)) throw fail(`${label} repeats an earlier binding.`);
    seen.add(key);
  }
}

/** Check proposal parameters against a class's closed parameter schema. */
export function validateClassParameters(actionClass, parameters) {
  const fail = (message) => new RailError("SCHEMA_INVALID", message);
  if (!isPlainObject(parameters)) throw fail("ActionProposal.parameters must be an object.");
  for (const key of Object.keys(parameters)) {
    if (!Object.hasOwn(actionClass.parameters, key)) {
      throw fail(`ActionProposal.parameters.${key} is not declared by ${actionClass.action_type}.`);
    }
  }
  for (const [name, spec] of Object.entries(actionClass.parameters)) {
    const label = `ActionProposal.parameters.${name}`;
    if (!Object.hasOwn(parameters, name)) throw fail(`${label} is required.`);
    const value = parameters[name];
    if (spec.type === "string") {
      if (typeof value !== "string") throw fail(`${label} must be a string.`);
      if (value.length < (spec.min_length ?? 1) || value.length > (spec.max_length ?? MAX_STRING_LENGTH)) {
        throw fail(`${label} has an unsupported length.`);
      }
      if (spec.pattern !== undefined && !new RegExp(spec.pattern, "u").test(value)) {
        throw fail(`${label} does not match its declared pattern.`);
      }
      if (spec.enum !== undefined && !spec.enum.includes(value)) {
        throw fail(`${label} is not one of its declared values.`);
      }
    } else if (spec.type === "integer") {
      if (
        !Number.isSafeInteger(value) ||
        value < (spec.minimum ?? Number.MIN_SAFE_INTEGER) ||
        value > (spec.maximum ?? Number.MAX_SAFE_INTEGER)
      ) {
        throw fail(`${label} must be an integer within its declared bounds.`);
      }
    } else if (typeof value !== "boolean") {
      throw fail(`${label} must be boolean.`);
    }
  }
}

/** Check the recourse scope and bindings a v0.3 proposal repeats from its class. */
export function validateProposalDeclarations(actionClass, proposal) {
  const fail = (message) => new RailError("SCHEMA_INVALID", message);
  const scope = proposal.recourse_scope;
  if (
    !isPlainObject(scope) ||
    Object.keys(scope).length !== 2 ||
    scope.field !== actionClass.recourse.scope_field ||
    scope.covers_parameter !== actionClass.recourse.covers_parameter
  ) {
    throw fail("ActionProposal.recourse_scope must repeat the registered class scope exactly.");
  }
  const bindings = proposal.evidence_plan.parameter_bindings;
  checkBindings(bindings, actionClass.parameters, fail);
  for (const required of actionClass.evidence_bindings) {
    if (!bindings.some((item) => item.fact === required.fact && item.parameter === required.parameter)) {
      throw fail(`ActionProposal.evidence_plan.parameter_bindings omits ${required.fact} = ${required.parameter}.`);
    }
  }
}

/**
 * Check proposal-declared bindings offline, without a registry: every listed
 * parameter exists in the proposal and every listed fact path is well formed.
 */
export function validateDeclaredBindings(proposal, fail) {
  checkBindings(proposal.evidence_plan?.parameter_bindings, proposal.parameters ?? {}, fail);
}

/** Read a dot-separated fact path, returning undefined when absent. */
export function readFact(facts, path) {
  let current = facts;
  for (const segment of path.split(".")) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

/** The binding indexes whose fact does not strictly equal its parameter. */
export function unmetBindings(proposal, facts) {
  const bindings = proposal.evidence_plan?.parameter_bindings ?? [];
  return bindings
    .map((binding, index) => [binding, index])
    .filter(([binding]) => readFact(facts, binding.fact) !== proposal.parameters[binding.parameter])
    .map(([, index]) => index);
}

/** A rail-local registry of action classes, keyed by action_type. */
export class ActionClassRegistry {
  constructor(definitions = []) {
    this.classes = new Map();
    for (const definition of definitions) this.register(definition);
  }

  register(definition) {
    const actionClass = defineActionClass(definition);
    if (this.classes.has(actionClass.action_type)) {
      throw invalid(`Action class ${actionClass.action_type} is already registered.`);
    }
    this.classes.set(actionClass.action_type, actionClass);
    return actionClass;
  }

  get(actionType) {
    return this.classes.get(actionType) ?? null;
  }

  list() {
    return [...this.classes.values()].map((item) => deepClone(item));
  }
}

/**
 * A non-money example: post one comment on a synthetic support ticket. The
 * reserved remedy deletes only a comment this action created.
 */
export const DEMO_TICKET_COMMENT_CLASS = defineActionClass({
  action_type: "demo.ticket.comment/v1",
  description: "Post one comment on a synthetic support ticket.",
  parameters: {
    body: { type: "string", min_length: 1, max_length: 2_000 },
    visibility: { type: "string", enum: ["internal", "public"] },
  },
  recourse: {
    scope_field: "max_quantity",
    covers_parameter: null,
    kinds: ["reverse", "escalate"],
  },
  evidence_bindings: [{ fact: "visibility", parameter: "visibility" }],
});
