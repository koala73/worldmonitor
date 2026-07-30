// A2A (Agent-to-Agent) JSON-RPC endpoint — the service behind the agent card
// at public/.well-known/agent-card.json (served at /a2a via vercel.json).
//
// Scope is deliberately the two skills the card advertises, both anonymous
// and quota-free by construction:
//   - route-to-tool: keyword-routes a natural-language need to the best-fit
//     MCP tools from the live TOOL_REGISTRY (the same catalog tools/list
//     serves anonymously), plus how-to-call/auth guidance.
//   - check-data-freshness: the public seed-meta freshness envelope, the
//     same read `resources/read` serves anonymously (metadata only).
// It never touches gated data surfaces, so it cannot become a Pro-quota
// bypass (the GHSA-hcq5 class). Responses are direct Messages — no Task
// objects are ever created, so capabilities.streaming/pushNotifications
// stay false and tasks/* methods answer TaskNotFound.

import { suggestTools } from './_agent-tool-suggest';
import { PUBLIC_RESOURCE_REGISTRY } from './mcp/resources/index';
import { ENDPOINT_RATE_POLICIES, checkScopedRateLimit, getClientIp } from '../server/_shared/rate-limit';

// Re-exported so existing consumers (tests, api/ask.ts historically) keep a
// stable import surface; the implementation lives in the route-less helper.
export { suggestTools, type ToolSuggestion } from './_agent-tool-suggest';

export const config = { runtime: 'edge' };

const RATE_LIMIT_SCOPE = '/api/a2a';
const RATE_LIMIT_POLICY = ENDPOINT_RATE_POLICIES[RATE_LIMIT_SCOPE];
if (!RATE_LIMIT_POLICY) {
  // Module-load failure — better to crash the function cold-start with a
  // loud message than to silently fall back to "no rate limit" if someone
  // accidentally deletes the registry entry.
  throw new Error(
    `[a2a] missing ENDPOINT_RATE_POLICIES['${RATE_LIMIT_SCOPE}'] — see server/_shared/rate-limit.ts`,
  );
}
const RATE_LIMIT_MAX = RATE_LIMIT_POLICY.limit;
const RATE_LIMIT_WINDOW = RATE_LIMIT_POLICY.window;
const RATE_LIMIT_ERROR_CODE = -32029; // JSON-RPC code mirrored from api/mcp.ts

// A2A-spec error codes (v0.3.0 §8) used by this server.
const A2A_TASK_NOT_FOUND = -32001;
const A2A_UNSUPPORTED_OPERATION = -32004;
const A2A_EXTENDED_CARD_NOT_CONFIGURED = -32007;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const BASE_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  ...CORS_HEADERS,
};

interface JsonRpcError {
  code: number;
  message: string;
}

type JsonRpcId = string | number | null;

function rpcError(id: JsonRpcId, error: JsonRpcError, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error }), {
    status,
    headers: BASE_HEADERS,
  });
}

function rpcResult(id: JsonRpcId, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: BASE_HEADERS,
  });
}

// Deliberately narrow: "current"/"latest" appear in ordinary data queries
// ("current conflicts in Sudan") and would trigger a pointless Redis read.
const FRESHNESS_INTENT = /\b(fresh|freshness|stale|staleness|seed|health|uptime|up.to.date|outage)\b/i;

// Concierge queries are short; cap what we tokenize/echo so an adversarial
// multi-megabyte text part can't inflate CPU or the response body.
const MAX_QUERY_CHARS = 2048;
const MAX_ECHO_CHARS = 160;

const HOW_TO_CALL = {
  mcp: {
    endpoint: 'https://worldmonitor.app/mcp',
    transport: 'streamable-http',
    note: "Issue tools/list for the live inventory (anonymous). Data calls need OAuth2 (scope=mcp) or an API key header 'X-WorldMonitor-Key: wm_<40-hex>' — issue one at https://worldmonitor.app/pro.",
  },
  rest: {
    base: 'https://api.worldmonitor.app',
    openapi: 'https://worldmonitor.app/openapi.json',
  },
  docs: 'https://www.worldmonitor.app/docs/documentation',
  agentGuidance: 'https://worldmonitor.app/llms.txt',
} as const;

interface MessagePart {
  kind?: string;
  type?: string; // pre-0.3 A2A dialect
  text?: string;
}

function extractText(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return (parts as MessagePart[])
    .filter((p) => p && typeof p === 'object' && (p.kind === 'text' || p.type === 'text') && typeof p.text === 'string')
    .map((p) => p.text)
    .join(' ')
    .trim();
}

async function handleMessageSend(id: JsonRpcId, params: unknown): Promise<Response> {
  const message = (params as { message?: unknown } | undefined)?.message as
    | { parts?: unknown; contextId?: unknown }
    | undefined;
  if (!message || typeof message !== 'object') {
    return rpcError(id, { code: -32602, message: "Invalid params: 'message' object is required." });
  }
  const text = extractText(message.parts).slice(0, MAX_QUERY_CHARS);
  if (!text) {
    return rpcError(id, {
      code: -32602,
      message: "Invalid params: 'message.parts' must contain at least one text part (kind: 'text').",
    });
  }

  const suggestions = suggestTools(text);
  const wantsFreshness = FRESHNESS_INTENT.test(text);

  let freshness: unknown;
  if (wantsFreshness || suggestions.length === 0) {
    const freshnessResource = PUBLIC_RESOURCE_REGISTRY.find(
      (r) => r.uri === 'worldmonitor://seed-meta/freshness',
    );
    try {
      // Documented robust (never throws meaningfully; degrades to
      // {cached_at: null, stale: true}) — boundary-guard anyway so a
      // regression there can't 500 this endpoint.
      freshness = freshnessResource
        ? JSON.parse(await freshnessResource.read())
        : { cached_at: null, stale: true };
    } catch {
      freshness = { cached_at: null, stale: true };
    }
  }

  const echoedQuery = text.length > MAX_ECHO_CHARS ? `${text.slice(0, MAX_ECHO_CHARS)}…` : text;
  const lines: string[] = [];
  if (suggestions.length > 0) {
    lines.push(
      `Best-fit WorldMonitor tools for "${echoedQuery}": ${suggestions.map((s) => s.name).join(', ')}.`,
      `Call them on the MCP server at ${HOW_TO_CALL.mcp.endpoint} (${HOW_TO_CALL.mcp.note})`,
      `REST equivalents are documented in the OpenAPI spec at ${HOW_TO_CALL.rest.openapi}.`,
    );
  } else {
    lines.push(
      'No specific tool matched that request. WorldMonitor covers conflicts, sanctions, country risk, markets, commodities, energy, maritime/aviation activity, chokepoints, cyber threats, natural disasters, forecasts and prediction markets.',
      `Issue tools/list on ${HOW_TO_CALL.mcp.endpoint} for the full catalog, or start from ${HOW_TO_CALL.agentGuidance}.`,
    );
  }
  if (freshness !== undefined) {
    lines.push('Attached: the live seed-meta freshness envelope from the public health surface.');
  }

  const parts: Array<Record<string, unknown>> = [
    { kind: 'text', text: lines.join(' ') },
    {
      kind: 'data',
      data: {
        suggestedTools: suggestions,
        howToCall: HOW_TO_CALL,
        ...(freshness !== undefined ? { freshness } : {}),
      },
    },
  ];

  return rpcResult(id, {
    kind: 'message',
    role: 'agent',
    messageId: crypto.randomUUID(),
    ...(typeof message.contextId === 'string' && message.contextId ? { contextId: message.contextId } : {}),
    parts,
  });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'A2A requests are JSON-RPC 2.0 over HTTP POST. The agent card lives at /.well-known/agent-card.json.' },
      }),
      { status: 405, headers: { ...BASE_HEADERS, Allow: 'POST, OPTIONS' } },
    );
  }

  const ip = getClientIp(req);
  // Redis-degraded scoped limits intentionally stay availability-first here:
  // this surface is anonymous, quota-free, and cheap (pure token matching
  // over the public tool catalog; the freshness read itself degrades to a
  // null envelope when Redis is down, so there is no amplification to
  // protect). checkScopedRateLimit logs/Sentry-captures the degraded path.
  const scoped = await checkScopedRateLimit(RATE_LIMIT_SCOPE, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW, ip);
  if (!scoped.allowed) {
    const retryAfter = Math.max(1, Math.ceil((scoped.reset - Date.now()) / 1000));
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: RATE_LIMIT_ERROR_CODE,
          message: `Rate limit exceeded. Max ${RATE_LIMIT_MAX} requests per ${RATE_LIMIT_WINDOW} per IP.`,
        },
      }),
      { status: 429, headers: { ...BASE_HEADERS, 'Retry-After': String(retryAfter) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return rpcError(null, { code: -32700, message: 'Parse error: request body is not valid JSON.' });
  }

  const rpc = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id: JsonRpcId =
    typeof rpc?.id === 'string' || typeof rpc?.id === 'number' ? rpc.id : null;
  if (!rpc || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
    return rpcError(id, { code: -32600, message: "Invalid request: expected a JSON-RPC 2.0 envelope with a string 'method'." });
  }

  switch (rpc.method) {
    case 'message/send':
      return handleMessageSend(id, rpc.params);
    case 'message/stream':
    case 'tasks/resubscribe':
    case 'tasks/pushNotificationConfig/set':
    case 'tasks/pushNotificationConfig/get':
    case 'tasks/pushNotificationConfig/list':
    case 'tasks/pushNotificationConfig/delete':
      return rpcError(id, {
        code: A2A_UNSUPPORTED_OPERATION,
        message: 'This agent does not support streaming or push notifications (capabilities.streaming and capabilities.pushNotifications are false).',
      });
    case 'tasks/get':
    case 'tasks/cancel':
      return rpcError(id, {
        code: A2A_TASK_NOT_FOUND,
        message: 'Task not found: this agent replies with direct messages and never creates tasks.',
      });
    case 'agent/getAuthenticatedExtendedCard':
      return rpcError(id, {
        code: A2A_EXTENDED_CARD_NOT_CONFIGURED,
        message: 'No authenticated extended card is configured; the public card at /.well-known/agent-card.json is complete.',
      });
    default:
      // Cap the echoed method name — an arbitrarily long one would otherwise
      // be reflected into every default-branch response body (Greptile #4824).
      return rpcError(id, { code: -32601, message: `Method not found: '${rpc.method.slice(0, 100)}'.` });
  }
}
