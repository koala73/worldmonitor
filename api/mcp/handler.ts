// @ts-expect-error — JS module, no declaration file
import { getPublicCorsHeaders } from '../_cors.js';
import {
  applyAnonDiscoveryLimit,
  applyPerMinuteLimit,
  PRODUCTION_DEPS,
  resolveAuthContext,
  runProPreChecks,
  wwwAuthHeader,
} from './auth';
import {
  MCP_LOG_LEVELS,
  negotiateProtocolVersion,
  SERVER_INSTRUCTIONS,
  SERVER_NAME,
  SERVER_VERSION,
} from './constants';
import { dispatchToolsCall } from './dispatch';
import { buildPromptResponse, PROMPT_LIST_RESPONSE } from './prompts/index';
import { TOOL_LIST_BYTES, TOOL_LIST_RESPONSE } from './registry/index';
import { buildResourceResponse, RESOURCE_LIST_RESPONSE } from './resources/index';
import { rpcError, rpcOk, withMcpNoStore } from './rpc';
import { emitTelemetry, principalIdForLog } from './telemetry';
import type { McpAuthContext, McpHandlerDeps } from './types';

// MCP methods servable WITHOUT authentication. These are the zero-data
// discovery surface an agent (or an agent-readiness scanner) needs to learn
// what this server is and what tools it exposes BEFORE authenticating —
// exactly the metadata already published in the static server-card.json and
// the public docs. Everything that returns DATA or spends quota
// (`tools/call`, `resources/read`) — and the metadata methods the product
// deliberately keeps gated (`prompts/list`, `resources/list`,
// `logging/setLevel`) — still requires credentials. `notifications/initialized`
// is the client's post-`initialize` handshake notification (carries no data);
// leaving it public lets a strict MCP client complete the handshake before
// calling `tools/list`.
const PUBLIC_MCP_METHODS: ReadonlySet<string> = new Set([
  'initialize',
  'notifications/initialized',
  'tools/list',
]);

// Mirror of resolveAuthContext's credential-header contract: does the request
// PRESENT any credential? A public method with NO credentials is served
// anonymously; a public method carrying a credential still has it validated
// (a present-but-invalid key is rejected, never silently downgraded to anon).
function hasCredentials(req: Request): boolean {
  if ((req.headers.get('Authorization') ?? '').startsWith('Bearer ')) return true;
  return (req.headers.get('X-WorldMonitor-Key') ?? '') !== '';
}

// Spec-correct 401 for the fail-closed guards on data methods. These guards are
// unreachable today (tools/call / resources/read are never PUBLIC_MCP_METHODS,
// so `context` is always resolved), but if that invariant is ever broken this
// fails closed with the SAME 401 + WWW-Authenticate shape resolveAuthContext
// emits — not a soft 200 JSON-RPC error.
function authRequiredResponse(id: unknown, resourceMetadataUrl: string, corsHeaders: Record<string, string>): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: -32001, message: 'Authentication required.' } }),
    { status: 401, headers: withMcpNoStore({ 'Content-Type': 'application/json', 'WWW-Authenticate': wwwAuthHeader(resourceMetadataUrl), ...corsHeaders }) },
  );
}

type StoredSseEvent = {
  id: string;
  data: string;
  retry?: number;
};

const SSE_CONTENT_TYPE = 'text/event-stream; charset=utf-8';
// no-store forbids storage outright; no-cache is vacuous alongside it (RFC 9111
// §5.2) so it is omitted. no-transform is load-bearing for SSE framing. This also
// matches the sibling no-store work in api/mcp/rpc.ts (#4502).
const MCP_CACHE_CONTROL = 'no-store, no-transform';
const MAX_SSE_SESSIONS = 500;
const MAX_SSE_STREAMS_PER_SESSION = 25;
const mcpSseStreamsBySession = new Map<string, Map<string, StoredSseEvent[]>>();

function getMcpCorsHeaders(methods = 'POST, GET, OPTIONS'): Record<string, string> {
  return {
    ...getPublicCorsHeaders(methods),
    'Cache-Control': MCP_CACHE_CONTROL,
  };
}

function clientAcceptsSse(req: Request): boolean {
  const accept = req.headers.get('accept') ?? '';
  return accept.split(',').some((entry) => {
    const [type, ...params] = entry.split(';').map((part) => part.trim().toLowerCase());
    if (type !== 'text/event-stream') return false;
    const qParam = params.find((part) => part.startsWith('q='));
    if (!qParam) return true;
    const q = Number(qParam.slice(2));
    return Number.isFinite(q) && q > 0;
  });
}

function formatSseEvent(event: StoredSseEvent): string {
  const lines = [`id: ${event.id}`];
  if (event.retry !== undefined) lines.push(`retry: ${event.retry}`);
  if (event.data === '') {
    lines.push('data:');
  } else {
    for (const line of event.data.split(/\r?\n/)) lines.push(`data: ${line}`);
  }
  return `${lines.join('\n')}\n\n`;
}

function encodeSseEvent(event: StoredSseEvent): Uint8Array {
  return new TextEncoder().encode(formatSseEvent(event));
}

function createSseStream(events: StoredSseEvent[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const [first, ...rest] = events;
      if (!first) {
        controller.close();
        return;
      }
      controller.enqueue(encodeSseEvent(first));
      setTimeout(() => {
        try {
          for (const event of rest) controller.enqueue(encodeSseEvent(event));
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      }, 0);
    },
  });
}

function sessionStreamsForWrite(sessionId: string): Map<string, StoredSseEvent[]> {
  let streams = mcpSseStreamsBySession.get(sessionId);
  if (!streams) {
    streams = new Map();
    mcpSseStreamsBySession.set(sessionId, streams);
    if (mcpSseStreamsBySession.size > MAX_SSE_SESSIONS) {
      const oldestSessionId = mcpSseStreamsBySession.keys().next().value;
      if (oldestSessionId) mcpSseStreamsBySession.delete(oldestSessionId);
    }
  }
  return streams;
}

function storeSseStream(sessionId: string, streamId: string, events: StoredSseEvent[]) {
  const streams = sessionStreamsForWrite(sessionId);
  streams.set(streamId, events);
  while (streams.size > MAX_SSE_STREAMS_PER_SESSION) {
    const oldestStreamId = streams.keys().next().value;
    if (!oldestStreamId) break;
    streams.delete(oldestStreamId);
  }
}

function parseEventCursor(eventId: string): { streamId: string; sequence: number } | null {
  const separator = eventId.lastIndexOf(':');
  if (separator <= 0) return null;
  const sequence = Number(eventId.slice(separator + 1));
  if (!Number.isInteger(sequence) || sequence < 0) return null;
  return { streamId: eventId.slice(0, separator), sequence };
}

function replayEventsAfter(sessionId: string, lastEventId: string): StoredSseEvent[] | null {
  const cursor = parseEventCursor(lastEventId);
  if (!cursor) return null;
  const events = mcpSseStreamsBySession.get(sessionId)?.get(cursor.streamId);
  if (!events) return null;
  return events.slice(cursor.sequence + 1);
}

function sseHeadersFrom(headers: Headers): Headers {
  const out = new Headers(headers);
  out.set('Content-Type', SSE_CONTENT_TYPE);
  // no-store forbids storing the (sensitive Pro tool-result) payload, matching the
  // no-store the JSON branches carry; no-transform stays load-bearing for SSE (it
  // blocks proxy gzip/buffering that would corrupt the event-stream framing).
  out.set('Cache-Control', MCP_CACHE_CONTROL);
  return out;
}

async function maybeStreamJsonRpcResponse(req: Request, response: Response): Promise<Response> {
  if (req.method !== 'POST' || response.status !== 200 || !clientAcceptsSse(req)) return response;
  if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) return response;

  const sessionId = response.headers.get('mcp-session-id') ?? req.headers.get('mcp-session-id');
  if (!sessionId) return response;

  const streamId = crypto.randomUUID();
  const responseBody = await response.text();
  const events: StoredSseEvent[] = [
    // MCP Streamable HTTP recommends this empty data event to prime Last-Event-ID reconnect.
    { id: `${streamId}:0`, data: '', retry: 1000 },
    { id: `${streamId}:1`, data: responseBody },
  ];
  storeSseStream(sessionId, streamId, events);
  return new Response(createSseStream(events), {
    status: 200,
    headers: sseHeadersFrom(response.headers),
  });
}

function handleSseReplay(req: Request, corsHeaders: Record<string, string>): Response {
  const lastEventId = req.headers.get('last-event-id');
  if (!clientAcceptsSse(req)) {
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'SSE replay requires Accept: text/event-stream' } }),
      { status: 406, headers: withMcpNoStore({ 'Content-Type': 'application/json', ...corsHeaders }) },
    );
  }
  if (!lastEventId) {
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Missing Last-Event-ID for SSE replay' } }),
      { status: 400, headers: withMcpNoStore({ 'Content-Type': 'application/json', ...corsHeaders }) },
    );
  }

  const sessionId = req.headers.get('mcp-session-id');
  if (!sessionId) {
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Missing Mcp-Session-Id for SSE replay' } }),
      { status: 400, headers: withMcpNoStore({ 'Content-Type': 'application/json', ...corsHeaders }) },
    );
  }

  const events = replayEventsAfter(sessionId, lastEventId);
  if (!events) {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32004,
          message: 'SSE replay cursor not found for this session; the stream may have expired or the reconnect may have reached a different server instance',
        },
      }),
      { status: 404, headers: withMcpNoStore({ 'Content-Type': 'application/json', ...corsHeaders }) },
    );
  }

  return new Response(createSseStream(events), {
    status: 200,
    // corsHeaders is getMcpCorsHeaders() (MCP_CACHE_CONTROL = no-store, no-transform):
    // the replay carries previously-streamed tool-result data, so no-store forbids
    // caching it and no-transform preserves SSE framing.
    headers: { 'Content-Type': SSE_CONTENT_TYPE, ...corsHeaders },
  });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export async function mcpHandler(
  req: Request,
  deps: McpHandlerDeps,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  // MCP is a public API endpoint secured by API key — allow all origins (claude.ai, Claude Desktop, custom agents)
  const corsHeaders = getMcpCorsHeaders();

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: withMcpNoStore(corsHeaders) });
  }
  if (req.method === 'HEAD') {
    return new Response(null, { status: 200, headers: withMcpNoStore({ 'Content-Type': 'application/json', ...corsHeaders }) });
  }

  // Origin validation: allow claude.ai/claude.com web clients; allow absent origin (desktop/CLI)
  const origin = req.headers.get('Origin');
  if (origin && origin !== 'https://claude.ai' && origin !== 'https://claude.com') {
    return new Response('Forbidden', { status: 403, headers: withMcpNoStore(corsHeaders) });
  }

  if (req.method !== 'POST' && req.method !== 'GET') {
    return new Response(null, { status: 405, headers: withMcpNoStore({ Allow: 'POST, GET, HEAD, OPTIONS', ...corsHeaders }) });
  }

  // Host-derived resource_metadata pointer matches api/oauth-protected-resource.ts.
  const requestHost = req.headers.get('host') ?? new URL(req.url).host;
  const resourceMetadataUrl = `https://${requestHost}/.well-known/oauth-protected-resource`;

  // GET is the SSE-replay path — it re-serves previously-streamed (Pro) tool
  // result data, so it stays fully authenticated (never a discovery surface).
  if (req.method === 'GET') {
    const auth = await resolveAuthContext(req, deps, resourceMetadataUrl, corsHeaders);
    if (!auth.ok) return auth.response;
    if (auth.context.kind === 'pro') {
      const proCheck = await runProPreChecks(auth.context, deps, resourceMetadataUrl, corsHeaders, ctx);
      if (proCheck) return proCheck;
    }
    const getLimited = await applyPerMinuteLimit(auth.context, corsHeaders);
    if (getLimited) return getLimited;
    return handleSseReplay(req, corsHeaders);
  }

  // Parse body BEFORE auth: the method decides whether credentials are required
  // (public discovery methods are servable anonymously). Malformed/missing-method
  // POSTs are a client error regardless of auth, so returning -32600 here (rather
  // than 401-then-32600) leaks nothing.
  let body: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
  try {
    body = await req.json();
  } catch {
    return rpcError(null, -32600, 'Invalid request: malformed JSON', corsHeaders);
  }

  if (!body || typeof body.method !== 'string') {
    return rpcError(body?.id ?? null, -32600, 'Invalid request: missing method', corsHeaders);
  }

  const { id, method } = body;

  // Auth gate. `context` is null only on the anonymous discovery path; every
  // data/quota method below runs the full protected path and always sets it.
  let context: McpAuthContext | null = null;
  if (PUBLIC_MCP_METHODS.has(method)) {
    if (hasCredentials(req)) {
      // Credentials presented on a public method are still validated so a
      // present-but-invalid key surfaces a 401 instead of a silent anon
      // downgrade; a valid principal is attributed for telemetry + limits.
      const auth = await resolveAuthContext(req, deps, resourceMetadataUrl, corsHeaders);
      if (!auth.ok) return auth.response;
      context = auth.context;
      const limited = await applyPerMinuteLimit(context, corsHeaders);
      if (limited) return limited;
    } else {
      const anonLimited = await applyAnonDiscoveryLimit(req, corsHeaders);
      if (anonLimited) return anonLimited;
    }
  } else {
    const auth = await resolveAuthContext(req, deps, resourceMetadataUrl, corsHeaders);
    if (!auth.ok) return auth.response;
    context = auth.context;
    if (context.kind === 'pro') {
      const proCheck = await runProPreChecks(context, deps, resourceMetadataUrl, corsHeaders, ctx);
      if (proCheck) return proCheck;
    }
    const limited = await applyPerMinuteLimit(context, corsHeaders);
    if (limited) return limited;
  }

  // Dispatch
  switch (method) {
    case 'initialize': {
      const sessionId = crypto.randomUUID();
      const clientRequestedVersion = (body.params as { protocolVersion?: unknown } | null | undefined)?.protocolVersion;
      const negotiatedVersion = negotiateProtocolVersion(clientRequestedVersion);
      // `tools_array_bytes` is the bare TOOL_LIST_RESPONSE stringify, not the
      // full JSON-RPC envelope (jsonrpc/id/protocolVersion/capabilities add
      // fixed overhead). UA is sliced to 256 chars: a pathological 32 KB
      // custom UA would otherwise inflate every emitted line for that session.
      emitTelemetry('mcp.tools_list_emitted', {
        auth_kind: context?.kind ?? 'anon',
        user_id: context ? principalIdForLog(context) : 'anon',
        tools_array_bytes: TOOL_LIST_BYTES,
        tool_count: TOOL_LIST_RESPONSE.length,
        client_user_agent: (req.headers.get('User-Agent') ?? '').slice(0, 256),
      });
      return maybeStreamJsonRpcResponse(req, rpcOk(id, {
        protocolVersion: negotiatedVersion,
        // `prompts.listChanged: false` and `resources.listChanged: false`
        // are the spec-correct values for our transport — the stateless
        // edge route cannot push `notifications/prompts/list_changed` or
        // `notifications/resources/list_changed`, so advertising `true`
        // would be a wire lie. `resources.subscribe: false` because
        // resources/subscribe is not implemented.
        capabilities: {
          tools: {},
          logging: {},
          prompts: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: SERVER_INSTRUCTIONS,
      }, { 'Mcp-Session-Id': sessionId, ...corsHeaders }));
    }
    case 'notifications/initialized':
      return new Response(null, { status: 202, headers: withMcpNoStore(corsHeaders) });
    case 'ping':
      return maybeStreamJsonRpcResponse(req, rpcOk(id, {}, corsHeaders));
    case 'tools/list':
      return maybeStreamJsonRpcResponse(req, rpcOk(id, { tools: TOOL_LIST_RESPONSE }, corsHeaders));
    case 'tools/call':
      // context is always set here — tools/call is never a PUBLIC_MCP_METHOD.
      // The guard narrows the type and hard-fails closed if that ever changes.
      if (!context) return authRequiredResponse(id, resourceMetadataUrl, corsHeaders);
      return maybeStreamJsonRpcResponse(req, await dispatchToolsCall(req, context, deps, body, corsHeaders, ctx));
    // Prompts are metadata-class — they ship a workflow template, not data.
    // Symmetric posture with `describe_tool`: quota-exempt (counting template
    // fetches against the 50/day cap would discourage exploration, which
    // defeats the prompt-discovery point), but the per-minute rate limit
    // applied above still gates abusive loops.
    case 'prompts/list':
      return maybeStreamJsonRpcResponse(req, rpcOk(id, { prompts: PROMPT_LIST_RESPONSE }, corsHeaders));
    case 'prompts/get': {
      const params = body.params as { name?: unknown; arguments?: Record<string, unknown> } | null;
      if (!params || typeof params.name !== 'string') {
        return maybeStreamJsonRpcResponse(req, rpcError(id, -32602, 'Invalid params: missing prompt name', corsHeaders));
      }
      const built = buildPromptResponse(params.name, params.arguments);
      if (!built.ok) return maybeStreamJsonRpcResponse(req, rpcError(id, built.code, built.message, corsHeaders));
      return maybeStreamJsonRpcResponse(req, rpcOk(id, { description: built.description, messages: built.messages }, corsHeaders));
    }
    // Resources surface DATA — unlike prompts (metadata-class, quota-exempt)
    // and describe_tool (metadata-class, quota-exempt), resources/read MUST
    // consume the Pro daily quota IDENTICALLY to a tools/call to the
    // equivalent tool. Asymmetric auth here is a known MCP data-leak
    // vector (a Pro user at the daily cap could otherwise keep reading
    // data via resources for free). The symmetry is structural:
    // buildResourceResponse synthesizes a tools/call body and routes
    // through dispatchToolsCall, inheriting the reservation + telemetry
    // path. resources/list is metadata-class — quota-exempt like
    // prompts/list, gated only by the per-minute rate limiter above.
    case 'resources/list':
      return maybeStreamJsonRpcResponse(req, rpcOk(id, { resources: RESOURCE_LIST_RESPONSE }, corsHeaders));
    case 'resources/read':
      // context is always set here — resources/read is never a PUBLIC_MCP_METHOD.
      if (!context) return authRequiredResponse(id, resourceMetadataUrl, corsHeaders);
      return maybeStreamJsonRpcResponse(req, await buildResourceResponse(req, context, deps, body, corsHeaders, ctx));
    case 'logging/setLevel': {
      const level = (body.params as { level?: string } | null)?.level;
      if (typeof level !== 'string' || !MCP_LOG_LEVELS.has(level)) {
        return maybeStreamJsonRpcResponse(req, rpcError(id, -32602,
          `Invalid params: level must be one of ${[...MCP_LOG_LEVELS].join(', ')}`,
          corsHeaders,
        ));
      }
      return maybeStreamJsonRpcResponse(req, rpcOk(id, {}, corsHeaders));
    }
    default:
      return maybeStreamJsonRpcResponse(req, rpcError(id, -32601, `Method not found: ${method}`, corsHeaders));
  }
}

// ---------------------------------------------------------------------------
// Default Vercel-edge entry — wires production deps. Tests call mcpHandler
// directly with mock deps.
// ---------------------------------------------------------------------------
export default async function handler(
  req: Request,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  return mcpHandler(req, PRODUCTION_DEPS, ctx);
}
