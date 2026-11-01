// `report_issue` (#8721): the first MCP tool that stores caller-written text,
// and the first free-tier tool that writes anything. An agent
// reports a bug, a missing capability, bad data, or a security concern, and
// the report is stored for maintainers to triage. Every decision here is
// settled in docs/architecture/agent-feedback-threat-model.md; read it before
// changing limits, identity, or annotations.
//
// The write path is shared with REST (`POST /api/feedback/v1/submit-report`):
// parse, sanitize, redact, hash, absorb a retry, admit through five
// fail-closed buckets, then one Convex mutation. This file only adapts it to
// MCP. Caller identity comes from `execution.feedbackCaller`, which dispatch
// derives from the request and the auth context, never from `params`.
import {
  FEEDBACK_ADVISORY_URL,
  FEEDBACK_KINDS,
  FEEDBACK_MAX_BODY_BYTES,
  submitAgentFeedback,
} from '../../../server/_shared/agent-feedback';
import { RpcValidationError } from '../billing-denial';
import type { McpToolExecutionContext, ToolDef } from '../types';
import { utf8ByteLength } from '../utils';

export const REPORT_ISSUE_TOOL = 'report_issue';

/**
 * A report the shared write path refused (429, 503, or 403 for a deleted
 * account). Dispatch maps it to a JSON-RPC error. The message is one of the
 * write path's fixed strings and never echoes report text, so logging it is
 * safe. A security report's message and data carry the advisory URL.
 */
export class FeedbackRejectedError extends Error {
  readonly status: 403 | 429 | 503;
  readonly publicMessage: string;
  readonly advisoryUrl?: string;
  readonly notice?: string;

  constructor(status: 403 | 429 | 503, publicMessage: string, advisoryUrl?: string, notice?: string) {
    // `<tool> HTTP <status>` keeps dispatch's 4xx log downgrade and
    // mcpErrorFingerprint grouping working.
    super(`${REPORT_ISSUE_TOOL} HTTP ${status}`);
    this.name = 'FeedbackRejectedError';
    this.status = status;
    this.publicMessage = publicMessage;
    this.advisoryUrl = advisoryUrl;
    this.notice = notice;
  }
}

async function executeReportIssue(
  params: Record<string, unknown>,
  execution: McpToolExecutionContext | undefined,
): Promise<Record<string, unknown>> {
  const caller = execution?.feedbackCaller;
  // Dispatch sets this for report_issue on every path. Without it there is no
  // server-derived identity to admit against, so refuse rather than guess.
  if (!caller) throw new Error('report_issue reached execution without a feedback caller');

  const outcome = await submitAgentFeedback(
    {
      kind: params.kind,
      surface: params.surface,
      summary: params.summary,
      expected: params.expected,
      actual: params.actual,
      requestId: params.requestId,
      clientName: params.clientName,
    },
    caller.principalId ? { authKind: 'keyed', principalId: caller.principalId } : { authKind: 'anonymous' },
    { clientIp: caller.clientIp, userAgent: caller.userAgent },
    { isKnownTool: caller.isKnownTool },
  );
  if (outcome.ok) {
    return {
      reportId: outcome.reportId,
      status: outcome.status,
      ...(outcome.advisoryUrl ? { advisoryUrl: outcome.advisoryUrl } : {}),
      ...(outcome.notice ? { notice: outcome.notice } : {}),
    };
  }
  if (outcome.status === 400) {
    throw new RpcValidationError(REPORT_ISSUE_TOOL, [{ field: outcome.field ?? 'arguments', description: outcome.message }]);
  }
  throw new FeedbackRejectedError(outcome.status, outcome.message, outcome.advisoryUrl, outcome.notice);
}

export const FEEDBACK_TOOLS: ToolDef[] = [
  {
    name: REPORT_ISSUE_TOOL,
    title: 'Report an issue',
    // The response is four short fields.
    _outputBudgetBytes: 2048,
    // Free tier (Decision 1 of the threat model): the agents we most want to
    // hear from have no key. This is the one free-tier tool that reaches a
    // credentialed downstream, a shared-secret Convex write. The exception is
    // stated in api/mcp/types.ts and pinned by tests/mcp-free-tier-subset.
    _freeTier: true,
    description:
      'Stores one report for the WorldMonitor maintainers about a bug, a missing capability, wrong or stale data, or a security concern, and returns its reportId and status. ' +
      'requestId links the report to a failing call. Nothing is published and no reply is sent. ' +
      'Credentials and email addresses are redacted before storage; secrets and personal data do not belong in a report. ' +
      `Vulnerability details belong in the private advisory form at ${FEEDBACK_ADVISORY_URL}; kind security only flags that one exists. ` +
      'Credential-free: anonymous callers get 5 reports per hour per IP, and accounts with API access get 30 per day.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: [...FEEDBACK_KINDS],
          description: 'bug: something failed or behaved wrongly. missing_capability: a tool, filter, or dataset you needed does not exist. data_quality: values look wrong, stale, or inconsistent. security: flags a vulnerability; put the details in the private advisory form, not here.',
        },
        surface: {
          type: 'string',
          maxLength: 200,
          description: 'What the report is about: a tool name such as get_market_data, a REST path such as /api/market/v1/list-market-quotes, or a short label for something that does not exist yet.',
        },
        summary: { type: 'string', minLength: 1, maxLength: 300, description: 'One sentence describing the problem.' },
        expected: { type: 'string', maxLength: 2000, description: 'What you expected to happen or to receive.' },
        actual: { type: 'string', maxLength: 2000, description: 'What happened instead, such as the error message or the wrong value.' },
        requestId: {
          type: 'string',
          maxLength: 128,
          pattern: '^[A-Za-z0-9:_-]+$',
          description: "The failing call's request id: data.requestId from an MCP error, or the x-vercel-id header of a REST response.",
        },
        clientName: { type: 'string', maxLength: 80, description: 'Your client or agent name, such as claude-code.' },
      },
      required: ['kind', 'summary'],
    },
    outputSchema: {
      type: 'object',
      required: ['reportId', 'status'],
      properties: {
        reportId: { type: 'string', description: 'The stored report id. Quote it when following up.' },
        status: { type: 'string', description: 'received, or private for a security report. A retry of the same report within 10 minutes returns the first report unchanged.' },
        advisoryUrl: { type: 'string', description: 'Security reports only: the private advisory form where vulnerability details belong.' },
        notice: { type: 'string', description: 'Security reports only: a reminder not to send exploit details through this tool.' },
      },
    },
    // Threat model, "MCP tool contract": it writes a row (not read-only),
    // only ever inserts (not destructive), an identical report outside the
    // 10-minute retry window inserts again (not idempotent), and it makes no
    // synchronous external call (closed world).
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    // Decision 4: MCP arguments are parsed before the tool runs, so the 24 KB
    // byte cap REST enforces while reading is enforced here instead, before
    // any feedback bucket or Convex call. The handler's request-level limits
    // (body size, free-tier and burst limiters) have already run by then.
    _validateArgs: (params) => {
      if (utf8ByteLength(JSON.stringify(params)) > FEEDBACK_MAX_BODY_BYTES) {
        throw new RpcValidationError(REPORT_ISSUE_TOOL, [{
          field: 'arguments',
          description: `Arguments exceed ${FEEDBACK_MAX_BODY_BYTES} bytes.`,
        }]);
      }
    },
    _execute: async (params, _base, _context, execution) => executeReportIssue(params, execution),
    // It proxies no OpenAPI operation: the write goes to Convex directly. The
    // REST twin is listed in the MCP parity exclusions.
    _apiPaths: [],
  },
];
