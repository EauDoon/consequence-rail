// State machine constants for the consequence-rail orchestrator.
// The transition table, receipt outcome mapping, and version constants
// live here so they can be consumed independently of the rail class.

export const ASSURANCE_MODES = ["enforced", "cooperative", "observed"];

const ACTION_PROPOSAL_VERSIONS = new Set([
  "consequence-rail/action-proposal/v0.1",
  "consequence-rail/action-proposal/v0.2",
]);

const BUNDLE_VERSION_BY_PROPOSAL = new Map([
  ["consequence-rail/action-proposal/v0.1", "consequence-rail/settlement-bundle/v0.1"],
  ["consequence-rail/action-proposal/v0.2", "consequence-rail/settlement-bundle/v0.2"],
]);

const RECEIPT_VERSION_BY_PROPOSAL = new Map([
  ["consequence-rail/action-proposal/v0.1", "consequence-rail/settlement-receipt/v0.1"],
  ["consequence-rail/action-proposal/v0.2", "consequence-rail/settlement-receipt/v0.2"],
]);

export const ALLOWED_TRANSITIONS = {
  PROPOSED: ["AUTHORIZED", "DENIED"],
  AUTHORIZED: ["EXPIRED", "REVOKED", "RECOURSE_RESERVED"],
  RECOURSE_RESERVED: ["EXPIRED", "REVOKED", "PERMITTED"],
  PERMITTED: ["EXPIRED", "REVOKED", "EXECUTING"],
  EXECUTING: ["EXECUTED", "FAILED", "UNKNOWN"],
  UNKNOWN: ["EXECUTED", "FAILED", "REVIEW_REQUIRED"],
  EXECUTED: ["VERIFYING"],
  VERIFYING: ["SATISFIED", "BREACHED", "INCONCLUSIVE"],
  BREACHED: ["REMEDY_DUE"],
  REMEDY_DUE: ["REMEDIATING", "REVIEW_REQUIRED"],
  REMEDIATING: ["REMEDY_VERIFYING", "REMEDY_FAILED", "REMEDY_UNKNOWN"],
  REMEDY_UNKNOWN: ["REMEDY_VERIFYING", "REMEDY_FAILED", "REVIEW_REQUIRED"],
  REMEDY_VERIFYING: ["REMEDIATED", "REMEDY_FAILED", "REMEDY_INCONCLUSIVE"],
  SATISFIED: ["CLOSED"],
  REMEDIATED: ["CLOSED"],
  INCONCLUSIVE: ["CLOSED"],
  REMEDY_INCONCLUSIVE: ["CLOSED"],
  REVIEW_REQUIRED: ["CLOSED"],
  REMEDY_FAILED: ["CLOSED"],
};

const RECEIPT_OUTCOME_BY_STATE = {
  SATISFIED: "settled",
  REMEDIATED: "compensated",
  INCONCLUSIVE: "disputed",
  REMEDY_INCONCLUSIVE: "disputed",
  REVIEW_REQUIRED: "disputed",
  REMEDY_FAILED: "disputed",
};

const MAX_ACTIONS = 1_000;

export {
  ACTION_PROPOSAL_VERSIONS,
  BUNDLE_VERSION_BY_PROPOSAL,
  RECEIPT_VERSION_BY_PROPOSAL,
  RECEIPT_OUTCOME_BY_STATE,
  MAX_ACTIONS,
};
