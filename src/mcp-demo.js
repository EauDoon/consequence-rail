// The reference MCP gateway wired to the synthetic ticket connector. An agent
// sees two tools: list_ticket_comments (read-only, passes through) and
// post_ticket_comment (gated by the rail as demo.ticket.comment/v1).

import { createAuthorizationDecision } from "./authorization.js";
import { digest } from "./canonical.js";
import { addMilliseconds, ManualClock } from "./clock.js";
import { DEMO_TICKET_COMMENT_CLASS } from "./action-classes.js";
import { McpGateway } from "./mcp-gateway.js";
import { MockTicketConnector } from "./mock-ticket-connector.js";
import { ConsequenceRail } from "./rail.js";
import {
  createDemoAuthorizerSigner,
  createDemoSigner,
  demoAuthorizerTrustedKeys,
  demoRecoveryTrustedKeys,
} from "./signing.js";
import { buildTicketReservation } from "./ticket-demo.js";

const TICKET_ID = { type: "string", minLength: 1, maxLength: 64, pattern: "^tkt_[A-Za-z0-9_]+$" };

export function ticketCommentProposal(args, { clock, idempotencyKey }) {
  const requestedAt = clock.now();
  return {
    schema_version: "consequence-rail/action-proposal/v0.3",
    action_type: DEMO_TICKET_COMMENT_CLASS.action_type,
    subject: { type: "agent", id: "mcp-client" },
    target: { connector: "mock-ticket-service", resource_type: "ticket", resource_id: String(args.ticket_id ?? "") },
    parameters: { body: args.body, visibility: args.visibility },
    idempotency_key: idempotencyKey,
    requested_at: requestedAt,
    expires_at: addMilliseconds(requestedAt, 120_000),
    assurance_mode: "enforced",
    postcondition: {
      op: "all",
      clauses: [
        { path: "comment_count", op: "eq", value: 1 },
        { path: "body_matches", op: "eq", value: true },
      ],
    },
    evidence_plan: {
      source: "mock-ticket-service",
      max_age_seconds: 60,
      parameter_bindings: [{ fact: "visibility", parameter: "visibility" }],
    },
    recourse_scope: { field: "max_quantity", covers_parameter: null },
  };
}

/**
 * A demonstration authorizer standing in for a policy engine such as the
 * Constitutional Agent Testbench: it allows internal comments and denies
 * public ones, and signs with the public demo authorizer key.
 */
export function demoTicketAuthorizer({ clock }) {
  const signer = createDemoAuthorizerSigner();
  return ({ proposal, action_digest: actionDigest }) => {
    const decidedAt = clock.now();
    return createAuthorizationDecision({
      actionDigest,
      allow: proposal.parameters.visibility === "internal",
      policyId: "demo-ticket-comment-policy/v1",
      policyDigest: digest({ allow_visibility: ["internal"] }),
      evaluationInputDigest: digest({ visibility: proposal.parameters.visibility }),
      decidedAt,
      expiresAt: addMilliseconds(decidedAt, 300_000),
    }, signer);
  };
}

export function createTicketMcpGateway({
  clock = new ManualClock(),
  connector = new MockTicketConnector(clock),
  authorizer = null,
  executeOptions = {},
} = {}) {
  const rail = new ConsequenceRail({
    signer: createDemoSigner(),
    clock,
    connector,
    connectorTrustedKeys: connector.trustedKeys(),
    recoveryTrustedKeys: demoRecoveryTrustedKeys(),
    authorizerTrustedKeys: demoAuthorizerTrustedKeys(),
    requireSignedAuthorization: true,
    actionClasses: [DEMO_TICKET_COMMENT_CLASS],
    requireSimulation: true,
  });
  const gateway = new McpGateway({
    rail,
    authorizer,
    executeOptions,
    tools: [
      {
        name: "list_ticket_comments",
        description: "List the live comments on a synthetic support ticket.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["ticket_id"],
          properties: { ticket_id: TICKET_ID },
        },
        annotations: { readOnlyHint: true },
        call: (args) => ({ ticket_id: args.ticket_id, comments: connector.listComments(args.ticket_id) }),
      },
      {
        name: "post_ticket_comment",
        description: "Post one comment on a synthetic support ticket. Gated by Consequence Rail.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["ticket_id", "body", "visibility"],
          properties: {
            ticket_id: TICKET_ID,
            body: { type: "string", minLength: 1, maxLength: 2000 },
            visibility: { type: "string", enum: ["internal", "public"] },
          },
        },
        annotations: { idempotentHint: false },
        gate: {
          action_type: DEMO_TICKET_COMMENT_CLASS.action_type,
          buildProposal: ticketCommentProposal,
          buildReservation: (proposal, actionDigest) => buildTicketReservation(actionDigest, proposal),
        },
      },
    ],
  });
  return { gateway, rail, connector, clock };
}
