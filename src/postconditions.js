import { RailError } from "./errors.js";

const OPERATORS = {
  eq: (actual, expected) => actual === expected,
  gte: (actual, expected) => actual >= expected,
  lte: (actual, expected) => actual <= expected,
};

const RESERVED_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const POSTCONDITION_FIELDS = new Set(["op", "clauses"]);
const CLAUSE_FIELDS = new Set(["path", "op", "value"]);

function exactOwnFields(value, expected) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    [...expected].every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => expected.has(key));
}

function readPath(object, path) {
  let current = object;
  for (const part of path.split(".")) {
    if (
      RESERVED_PATH_SEGMENTS.has(part) ||
      !current ||
      typeof current !== "object" ||
      !Object.hasOwn(current, part)
    ) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

export function evaluatePostcondition(postcondition, evidence) {
  if (
    !exactOwnFields(postcondition, POSTCONDITION_FIELDS) ||
    postcondition.op !== "all" ||
    !Array.isArray(postcondition.clauses) ||
    postcondition.clauses.length === 0
  ) {
    throw new RailError("POSTCONDITION_INVALID", "Only an all-clause postcondition is supported.");
  }

  const evaluations = postcondition.clauses.map((clause) => {
    if (
      !exactOwnFields(clause, CLAUSE_FIELDS) ||
      typeof clause.path !== "string" ||
      clause.path.length === 0 ||
      clause.path.split(".").some((part) => !part || RESERVED_PATH_SEGMENTS.has(part))
    ) {
      throw new RailError("POSTCONDITION_INVALID", "Postcondition clauses must use exact safe fields.");
    }
    const operator = OPERATORS[clause.op];
    if (!operator) {
      throw new RailError("POSTCONDITION_INVALID", `Unsupported operator: ${clause.op}.`);
    }
    const actual = readPath(evidence?.facts, clause.path);
    return {
      path: clause.path,
      operator: clause.op,
      expected: clause.value,
      actual,
      satisfied: operator(actual, clause.value),
    };
  });

  return {
    satisfied: evaluations.every((item) => item.satisfied),
    evaluations,
  };
}
