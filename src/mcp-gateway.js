// MCP front door. An agent connects to this gateway as an ordinary MCP
// server. The gateway owns the rail, and the rail's connector holds the only
// credential for the downstream system, so the agent cannot reach the
// downstream except through these tools.
//
// A tool marked read-only passes through to its handler. Every other tool is
// gated: the call becomes an ActionProposal v0.3 for a registered action
// class, and runs only after a signed authorization, reserved recourse and a
// single-use permit. The outcome is verified, a breached postcondition runs
// the reserved remedy, and the call returns the settlement outcome and the
// receipt digest. MCP tool annotations are hints in the MCP specification;
// here a missing read-only hint means the tool is gated.

import { digest } from "./canonical.js";
import { isSignedAuthorizationDecision } from "./authorization.js";
import { RailError } from "./errors.js";
import { VERSION } from "./version.js";

export const MCP_PROTOCOL_VERSIONS = Object.freeze(["2026-07-28", "2025-11-25", "2025-06-18"]);
export const MCP_META_AUTHORIZATION = "consequence-rail/authorization";
export const MCP_META_IDEMPOTENCY_KEY = "consequence-rail/idempotency_key";

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const TOOL_FIELDS = new Set(["name", "title", "description", "inputSchema", "annotations", "call", "gate"]);
const GATE_FIELDS = new Set(["action_type", "buildProposal", "buildReservation"]);
const MAX_PENDING = 1_000;

const JSON_RPC = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function configError(message) {
  return new RailError("CONFIG_INVALID", message);
}

function checkTool(tool, rail) {
  if (!isPlainObject(tool)) throw configError("Each MCP tool must be an object.");
  for (const key of Object.keys(tool)) {
    if (!TOOL_FIELDS.has(key)) throw configError(`MCP tool field ${key} is not supported.`);
  }
  if (typeof tool.name !== "string" || !TOOL_NAME.test(tool.name)) {
    throw configError("MCP tool name must be 1 to 64 letters, digits, dot, dash or underscore.");
  }
  if (!isPlainObject(tool.inputSchema) || tool.inputSchema.type !== "object") {
    throw configError(`MCP tool ${tool.name} needs an object inputSchema.`);
  }
  const readOnly = tool.annotations?.readOnlyHint === true;
  if (readOnly) {
    if (typeof tool.call !== "function" || tool.gate !== undefined) {
      throw configError(`Read-only MCP tool ${tool.name} needs call and no gate.`);
    }
    return { ...tool, readOnly };
  }
  // Without readOnlyHint the MCP default is a destructive tool, so the
  // gateway requires a gate and refuses a direct handler.
  if (tool.call !== undefined || !isPlainObject(tool.gate)) {
    throw configError(`MCP tool ${tool.name} is not read-only, so it needs a gate and no call.`);
  }
  for (const key of Object.keys(tool.gate)) {
    if (!GATE_FIELDS.has(key)) throw configError(`MCP gate field ${key} is not supported.`);
  }
  if (
    typeof tool.gate.buildProposal !== "function" ||
    typeof tool.gate.buildReservation !== "function" ||
    rail.actionClasses.get(tool.gate.action_type) === null
  ) {
    throw configError(`MCP tool ${tool.name} must gate a registered action class with proposal and reservation builders.`);
  }
  return { ...tool, readOnly };
}

function textResult(text, structuredContent, isError) {
  return { content: [{ type: "text", text }], structuredContent, isError };
}

function railFailure(error, extra = {}) {
  const code = error instanceof RailError ? error.code : "GATEWAY_FAILED";
  const message = error instanceof RailError ? error.message : "The gated call failed.";
  return textResult(`Refused: ${code}. ${message}`, { status: "refused", code, ...extra }, true);
}

export class McpGateway {
  /**
   * @param {object} options
   * @param {import("./rail-class.js").ConsequenceRail} options.rail The rail.
   *   Its connector is the only holder of the downstream credential.
   * @param {object[]} options.tools Read-only tools with call(args), and gated
   *   tools with gate { action_type, buildProposal, buildReservation }.
   * @param {Function} [options.authorizer] Operator policy hook: receives
   *   { tool, proposal, action_digest } and returns an authorization decision
   *   or null. Without it, the caller must attach a signed decision.
   * @param {object} [options.executeOptions] Passed to rail.execute (tests).
   */
  constructor({ rail, tools, authorizer = null, executeOptions = {} } = {}) {
    if (!rail || typeof rail.propose !== "function" || !rail.actionClasses) {
      throw configError("McpGateway needs a ConsequenceRail.");
    }
    if (!Array.isArray(tools) || tools.length === 0) throw configError("McpGateway needs at least one tool.");
    if (authorizer !== null && typeof authorizer !== "function") {
      throw configError("McpGateway authorizer must be a function.");
    }
    this.rail = rail;
    this.authorizer = authorizer;
    this.executeOptions = { ...executeOptions };
    this.tools = new Map();
    for (const tool of tools) {
      const checked = checkTool(tool, rail);
      if (this.tools.has(checked.name)) throw configError(`MCP tool ${checked.name} is listed twice.`);
      this.tools.set(checked.name, checked);
    }
    this.pending = new Map();
    this.initialized = false;
  }

  /** The tools a client is allowed to see, with gated ones marked. */
  listTools() {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      ...(tool.title ? { title: tool.title } : {}),
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      annotations: tool.readOnly
        ? { ...tool.annotations, readOnlyHint: true, destructiveHint: false }
        : { ...tool.annotations, readOnlyHint: false, destructiveHint: true },
      ...(tool.readOnly ? {} : { _meta: { "consequence-rail/action_type": tool.gate.action_type } }),
    }));
  }

  /** True when the named tool goes through the rail. */
  isGated(name) {
    const tool = this.tools.get(name);
    return tool !== undefined && !tool.readOnly;
  }

  /**
   * Handle one JSON-RPC message. Returns the response object, or null for a
   * notification.
   */
  async handleMessage(message) {
    if (!isPlainObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return this.error(message?.id ?? null, JSON_RPC.INVALID_REQUEST, "Invalid JSON-RPC request.");
    }
    const isNotification = !Object.hasOwn(message, "id");
    if (!isNotification && typeof message.id !== "string" && !Number.isSafeInteger(message.id)) {
      return this.error(null, JSON_RPC.INVALID_REQUEST, "JSON-RPC id must be a string or integer.");
    }
    if (isNotification) {
      if (message.method === "notifications/initialized") this.initialized = true;
      return null;
    }
    const params = message.params ?? {};
    if (!isPlainObject(params)) return this.error(message.id, JSON_RPC.INVALID_PARAMS, "params must be an object.");
    try {
      switch (message.method) {
        case "initialize":
          return this.result(message.id, this.initialize(params));
        case "ping":
          return this.result(message.id, {});
        case "tools/list":
          return this.result(message.id, { tools: this.listTools() });
        case "tools/call":
          return this.result(message.id, await this.callTool(params));
        default:
          return this.error(message.id, JSON_RPC.METHOD_NOT_FOUND, `Method ${message.method} is not supported.`);
      }
    } catch (error) {
      if (error?.jsonRpcCode) return this.error(message.id, error.jsonRpcCode, error.message);
      return this.error(message.id, JSON_RPC.INTERNAL_ERROR, "Internal gateway error.");
    }
  }

  initialize(params) {
    const requested = params.protocolVersion;
    return {
      protocolVersion: MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "consequence-rail-mcp-gateway", version: VERSION },
      instructions:
        "Read-only tools run directly. Every other tool is gated by Consequence Rail: the first call returns " +
        "authorization_required with an action_digest unless the operator's policy decides it. Attach a " +
        `decision signed by a trusted authorizer under _meta["${MCP_META_AUTHORIZATION}"] and call again with ` +
        "the same arguments. A gated call returns the settlement outcome and receipt digest.",
    };
  }

  async callTool(params) {
    const tool = typeof params.name === "string" ? this.tools.get(params.name) : undefined;
    if (!tool) throw Object.assign(new Error(`Unknown tool: ${params.name}`), { jsonRpcCode: JSON_RPC.INVALID_PARAMS });
    const args = params.arguments ?? {};
    if (!isPlainObject(args)) {
      throw Object.assign(new Error("Tool arguments must be an object."), { jsonRpcCode: JSON_RPC.INVALID_PARAMS });
    }
    const meta = isPlainObject(params._meta) ? params._meta : {};
    if (tool.readOnly) {
      try {
        const output = await tool.call(structuredClone(args));
        return textResult(JSON.stringify(output), output, false);
      } catch (error) {
        return railFailure(error);
      }
    }
    return this.callGated(tool, args, meta);
  }

  async callGated(tool, args, meta) {
    const rail = this.rail;
    const supplied = meta[MCP_META_IDEMPOTENCY_KEY];
    if (supplied !== undefined && (typeof supplied !== "string" || supplied.length === 0 || supplied.length > 200)) {
      return railFailure(new RailError("SCHEMA_INVALID", "The idempotency key must be a string of 1 to 200 characters."));
    }
    // The same tool, arguments and key resume one pending action, so the
    // agent can come back with a signed decision for the digest it was shown.
    const callKey = digest({ tool: tool.name, arguments: args, idempotency_key: supplied ?? null });
    let pending = this.pending.get(callKey);
    if (!pending) {
      if (this.pending.size >= MAX_PENDING) {
        return railFailure(new RailError("ACTION_CAPACITY_REACHED", "Too many gated calls await authorization."));
      }
      let proposal;
      let proposed;
      try {
        proposal = tool.gate.buildProposal(structuredClone(args), {
          clock: rail.clock,
          idempotencyKey: supplied ?? `mcp:${tool.name}:${callKey.slice(0, 22)}`,
        });
        if (proposal?.action_type !== tool.gate.action_type) {
          throw new RailError("CONFIG_INVALID", "The gate built a proposal for a different action type.");
        }
        proposed = rail.propose(proposal);
      } catch (error) {
        return railFailure(error);
      }
      pending = { action_id: proposed.action_id, action_digest: proposed.action_digest, proposal };
      this.pending.set(callKey, pending);
    }
    const reference = { action_id: pending.action_id, action_digest: pending.action_digest };

    const attached = meta[MCP_META_AUTHORIZATION];
    let decision = null;
    if (attached !== undefined) {
      // The caller is the agent. An unsigned claim from it would be
      // self-approval, so the front door takes only a signed decision.
      if (!isSignedAuthorizationDecision(attached)) {
        return railFailure(
          new RailError("AUTHORIZATION_SIGNATURE_REQUIRED", "The gateway accepts only a signed AuthorizationDecision from the caller."),
          reference,
        );
      }
      decision = attached;
    } else if (this.authorizer) {
      try {
        decision = await this.authorizer({
          tool: tool.name,
          proposal: structuredClone(pending.proposal),
          action_digest: pending.action_digest,
        });
      } catch (error) {
        return railFailure(error, reference);
      }
    }
    if (decision === null || decision === undefined) {
      return textResult(
        `Authorization required for ${tool.gate.action_type}. Have a trusted authorizer sign action_digest ` +
          `${pending.action_digest}, then call ${tool.name} again with the same arguments and the decision.`,
        { status: "authorization_required", ...reference, action_type: tool.gate.action_type, expires_at: pending.proposal.expires_at },
        true,
      );
    }

    try {
      const authorized = rail.authorize(pending.action_id, decision);
      this.pending.delete(callKey);
      if (authorized.state === "DENIED") {
        return textResult("The authorizer denied this action. Nothing was executed.", { status: "denied", ...reference }, true);
      }
    } catch (error) {
      // A refused decision leaves the action PROPOSED, so a correct decision
      // can still be attached on the next call.
      return railFailure(error, reference);
    }
    return this.runPermitted(tool, pending, reference);
  }

  async runPermitted(tool, pending, reference) {
    const rail = this.rail;
    const id = pending.action_id;
    try {
      rail.reserveRecourse(id, tool.gate.buildReservation(structuredClone(pending.proposal), pending.action_digest));
      rail.issuePermit(id);
      await rail.execute(id, this.executeOptions);
      let view = rail.inspect(id);
      if (view.state === "UNKNOWN") {
        await rail.reconcile(id);
        view = rail.inspect(id);
      }
      if (view.state === "EXECUTED") {
        await rail.verifyOutcome(id);
        view = rail.inspect(id);
      }
      if (view.state === "REMEDY_DUE") {
        await rail.remediate(id);
        view = rail.inspect(id);
      }
      if (view.state === "REMEDY_UNKNOWN") {
        await rail.reconcileRemedy(id);
        view = rail.inspect(id);
      }
      const receiptDigest = view.outcome
        ? digest(rail.exportBundle(id, { profile: "receipt" }).settlement_receipt)
        : null;
      const structured = {
        status: view.outcome ? "closed" : "open",
        ...reference,
        state: view.state,
        outcome: view.outcome,
        receipt_digest: receiptDigest,
        event_chain_head: view.event_chain_head,
      };
      const text = view.outcome === "settled"
        ? `Done: the postcondition held. Outcome settled, receipt ${receiptDigest}.`
        : view.outcome
          ? `The action closed as ${view.outcome}. Receipt ${receiptDigest}.`
          : `The action ended in state ${view.state} with no settlement.`;
      return textResult(text, structured, view.outcome !== "settled");
    } catch (error) {
      return railFailure(error, { ...reference, state: rail.inspect(id).state });
    }
  }

  result(id, result) {
    return { jsonrpc: "2.0", id, result };
  }

  error(id, code, message) {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }
}

export { JSON_RPC };
