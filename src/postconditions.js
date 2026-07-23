import { RailError } from "./errors.js";

const OPERATORS = {
  eq: (actual, expected) => actual === expected,
  gte: (actual, expected) => actual >= expected,
  lte: (actual, expected) => actual <= expected,
};

function readPath(object, path) {
  return path.split(".").reduce((current, part) => current?.[part], object);
}

export function evaluatePostcondition(postcondition, evidence) {
  if (postcondition?.op !== "all" || !Array.isArray(postcondition.clauses)) {
    throw new RailError("POSTCONDITION_INVALID", "Only an all-clause postcondition is supported.");
  }

  const evaluations = postcondition.clauses.map((clause) => {
    const operator = OPERATORS[clause.op];
    if (!operator) {
      throw new RailError("POSTCONDITION_INVALID", `Unsupported operator: ${clause.op}.`);
    }
    const actual = readPath(evidence.facts, clause.path);
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
