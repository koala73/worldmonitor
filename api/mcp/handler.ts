// @ts-expect-error — JS module, no declaration file
import { getPublicCorsHeaders } from '../_cors.js';
import {
  applyAnonDiscoveryLimit,
  applyPerMinuteLimit,
  PRODUCTION_DEPS,
  resolveAuthContext,
  runContextPreChecks,
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
import {
  buildPublicResourceResponse,
  buildResourceResponse,
  isPublicResourceUri,
  RESOURCE_LIST_RESPONSE,
  RESOURCE_TEMPLATE_LIST_RESPONSE,
} from './resources/index';
import { rpcError, rpcOk, withMcpNoStore } from './rpc';
import { buildUiResourceRead, isUiResourceUri, UI_RESOURCE_LIST_RESPONSE } from './ui/registry';
import { emitTelemetry, principalIdForLog } from './telemetry';
import { createMcpUsage, emitMcpRequestEvent, setUsageContext, type McpUsage } from './usage';
import type { McpAuthContext, McpHandlerDeps } from './types';

// MCP methods servable WITHOUT authentication. These are the zero-data
// discovery surface an agent (or an agent-readiness scanner) needs to learn
// what this server is and what it exposes BEFORE authenticating — exactly the
// metadata already published in the static server-card.json and the public
// docs. `tools/list`, `resources/list`, `resources/templates/list`,
// `prompts/list`, and `prompts/get` are all catalog/template-enumeration
// methods that return only public metadata (names, descriptions, URIs / URI
// templates, static workflow-template prose — no data, no quota), so all are
// anonymously servable: a scanner that reads the `resources` capability from
// `initialize` MUST be able to enumerate it, or the capability reads as
// advertised-but-empty. The gating invariant (#4937): every capability the
// ANONYMOUS `initialize` advertises must be anonymously exercisable. A gated
// method answers HTTP 401 with JSON-RPC id:null, which an MCP SDK transport
// cannot correlate to the pending request — the client hangs to its 30s
// timeout and marks the server unstable (customer-hit via Claude Desktop +
// mcp-remote, which never OAuths because the public `initialize` never
// challenges it). That is why `prompts/*` (static templates), `ping` (spec
// liveness check — SDK keepalives hang identically), and `logging/setLevel`
// (no-op ack for the advertised `logging` capability) are public. All
// anonymous traffic stays behind applyAnonDiscoveryLimit. `resources/read` of
// a PUBLIC resource (a concrete, metadata-only freshness/health probe — see
// PUBLIC_RESOURCE_REGISTRY) is ALSO anonymously servable + quota-exempt; it
// is promoted to the public path per-request via `isPublicResourceUri` below
// because it carries no billable data. Everything that returns DATA or spends
// quota (`tools/call`, and `resources/read` of a data-bearing TEMPLATE
// instantiation) still requires credentials. `notifications/initialized`
// is the client's post-`initialize` handshake notification (carries no data);
// leaving it public lets a strict MCP client complete the handshake before
// calling `tools/list`.
const PUBLIC_MCP_METHODS: ReadonlySet<string> = new Set([
  'initialize',
  'notifications/initialized',
  'ping',
  'tools/list',
  'prompts/list',
  'prompts/get',
  'resources/list',
  'resources/templates/list',
  'logging/setLevel',
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
// unreachable today (tools/call always runs the gated path, and a data-bearing
// resources/read reaches its `!context` guard only AFTER the public-read branch
// has already returned — so `context` is always resolved when the guard runs),
// but if that invariant is ever broken this fails closed with the SAME 401 +
// WWW-Authenticate shape resolveAuthContext emits — not a soft 200 JSON-RPC
// error.
function authRequiredResponse(id: unknown, resourceMetadataUrl: string, corsHeaders: Record<string, string>): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: -32001, message: 'Authentication required.' } }),
    { status: 401, headers: withMcpNoStore({ 'Content-Type': 'application/json', 'WWW-Authenticate': wwwAuthHeader(resourceMetadataUrl), ...corsHeaders }) },
  );
}

type StoredSseEvent = {
  id: string;
  data: string;
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
  // A single `message` event carrying the fully-computed JSON-RPC response. The
  // body is already resolved (`await response.text()` above) before the stream
  // is constructed, so there is no slow-result window a separate priming event
  // could usefully cover. A leading empty-`data:` priming event here BREAKS
  // strict agent-readiness scanners: per the WHATWG SSE spec an empty `data:`
  // field still dispatches a `message` event (with `data === ''`), so a scanner
  // that reads the first event and `JSON.parse()`s its data hits
  // `JSON.parse('')` → "handshake failed" (this was orank Access `mcp-server`
  // 3/6). The MCP SDK tolerates the empty event, but the reference Streamable
  // HTTP server transport also emits a single `message` event — so one event
  // matches the spec's own client. The event still carries an id, so the
  // GET-with-Last-Event-ID replay channel (handleSseReplay) resumes correctly:
  // a reconnect after this event yields an empty stream (nothing follows the
  // already-delivered response).
  const events: StoredSseEvent[] = [{ id: `${streamId}:0`, data: responseBody }];
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
  // Defensive + type-narrowing guard. The sole caller (the GET branch) now
  // answers a bare GET without `Last-Event-ID` with 405 BEFORE reaching here, so
  // this 400 is unreachable in practice — but the check is retained because it
  // narrows `lastEventId` from `string | null` to `string` for
  // `replayEventsAfter` below (whose `parseEventCursor` would TypeError on null),
  // and keeps `handleSseReplay` independently safe if a future caller is added.
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
// /.well-known/mcp dual-role support
// ---------------------------------------------------------------------------
// vercel.json rewrites /.well-known/mcp into this handler so ONE URL is both
// the discovery manifest (plain GET → static server card) and a live
// Streamable HTTP endpoint (POST initialize etc.). Agent-readiness scanners
// (orank `mcp-server`) POST `initialize` AT the well-known URL; when a static
// file answered that with a bodyless 405 the check scored "MCP manifest found
// at /.well-known/mcp but protocol handshake failed" (3/6) even though /mcp
// itself handshakes cleanly.
// Two manifest aliases: bare `/.well-known/mcp` (SEP-1649 server-card style)
// and `/.well-known/mcp.json` (the ora.ai/registry convention whose schema
// keys the endpoint as top-level `url`). Both rewrite here via vercel.json.
const WELL_KNOWN_MCP_PATHS = new Set(['/.well-known/mcp', '/.well-known/mcp.json']);
// Module-scope cache: the card is a static asset, immutable per deployment.
let serverCardCache: string | null = null;
async function serveServerCard(req: Request, corsHeaders: Record<string, string>): Promise<Response> {
  if (serverCardCache === null) {
    try {
      const res = await fetch(new URL('/.well-known/mcp/server-card.json', req.url));
      if (!res.ok) throw new Error(`server-card fetch ${res.status}`);
      serverCardCache = await res.text();
    } catch {
      // Self-fetch failed (deploy skew / transient) — point the fetcher at the
      // canonical static path instead of caching a failure.
      return new Response(null, {
        status: 302,
        headers: { Location: '/.well-known/mcp/server-card.json', ...corsHeaders },
      });
    }
  }
  return new Response(serverCardCache, {
    status: 200,
    // Cache-Control comes AFTER the ...corsHeaders spread: getMcpCorsHeaders()
    // carries MCP_CACHE_CONTROL (`no-store`) for the live JSON-RPC/SSE endpoint,
    // but the manifest is a static, immutable-per-deploy asset that must stay
    // cacheable (it was `public, max-age=3600` as a static file). Spreading last
    // would clobber that back to no-store and re-hit the function on every
    // discovery fetch.
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders,
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
// Thin emission wrapper (#4866): one wm_api_usage RequestEvent per servable
// request, registered on ctx.waitUntil AFTER the response is computed. An
// uncaught throw from the inner handler (the raw-500 class hardened in #4860)
// still emits — with status 500 — before re-throwing, so platform 500s are
// visible in Axiom even though they bypass every structured error path.
export async function mcpHandler(
  req: Request,
  deps: McpHandlerDeps,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  const t0 = Date.now();
  const usage = createMcpUsage();
  let res: Response;
  try {
    res = await mcpHandlerInner(req, deps, usage, ctx);
  } catch (err) {
    emitMcpRequestEvent(req, new Response(null, { status: 500 }), usage, Date.now() - t0, ctx);
    throw err;
  }
  emitMcpRequestEvent(req, res, usage, Date.now() - t0, ctx);
  return res;
}

async function mcpHandlerInner(
  req: Request,
  deps: McpHandlerDeps,
  usage: McpUsage,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  // MCP is a public API endpoint secured by API key — allow all origins (claude.ai, Claude Desktop, custom agents)
  const corsHeaders = getMcpCorsHeaders();

  if (req.method === 'OPTIONS') {
    usage.skip = true;
    return new Response(null, { status: 204, headers: withMcpNoStore(corsHeaders) });
  }
  if (req.method === 'HEAD') {
    usage.skip = true;
    return new Response(null, { status: 200, headers: withMcpNoStore({ 'Content-Type': 'application/json', ...corsHeaders }) });
  }

  // /.well-known/mcp manifest GET: the card is public static data. A GET that
  // asks for `text/event-stream` (an SDK opening the optional standalone
  // stream) or carries `Last-Event-ID` (SSE replay) falls through to the
  // normal endpoint GET handling so transport semantics stay identical to /mcp.
  if (
    req.method === 'GET' &&
    WELL_KNOWN_MCP_PATHS.has(new URL(req.url).pathname) &&
    !req.headers.get('last-event-id') &&
    !(req.headers.get('accept') ?? '').includes('text/event-stream')
  ) {
    usage.skip = true;
    return serveServerCard(req, corsHeaders);
  }

  // No Origin gate (issue #4802): the endpoint advertises CORS `*`, auth is
  // API-key/Bearer (no cookies → no CSRF surface), and MCP-spec Origin
  // validation targets DNS rebinding against localhost servers — not a public
  // HTTPS endpoint. A claude.ai-only allowlist here 403'd ChatGPT web
  // connectors, MCP Inspector (localhost origin), and every other
  // browser-context client AFTER their preflight had already succeeded.

  if (req.method !== 'POST' && req.method !== 'GET') {
    usage.phase = 'transport';
    return new Response(null, { status: 405, headers: withMcpNoStore({ Allow: 'POST, GET, HEAD, OPTIONS', ...corsHeaders }) });
  }

  // Host-derived resource_metadata pointer matches api/oauth-protected-resource.ts.
  const requestHost = req.headers.get('host') ?? new URL(req.url).host;
  const resourceMetadataUrl = `https://${requestHost}/.well-known/oauth-protected-resource`;

  // GET has two roles on the MCP endpoint:
  //   1. A bare GET (no `Last-Event-ID`) is a client opening the OPTIONAL
  //      server->client SSE stream of the Streamable HTTP transport. This
  //      stateless edge route offers no server-initiated stream, so the MCP
  //      spec requires HTTP 405 Method Not Allowed here — and MCP SDK clients
  //      treat 405 as the graceful "no standalone stream" signal, completing
  //      the handshake cleanly. Answering 401/400 instead makes a strict
  //      client's `connect()` raise `Failed to open SSE stream` and an
  //      agent-readiness scanner (orank) report "protocol handshake failed".
  //      This 405 precedes auth so an UNauthenticated discovery client sees the
  //      same spec-correct signal (405 leaks nothing). RFC 9110 §15.5.6 requires
  //      the 405 to advertise `Allow`.
  //   2. A GET WITH `Last-Event-ID` is our authenticated SSE-replay channel —
  //      it re-serves previously-streamed (Pro) tool-result data, so it stays
  //      fully authenticated (never a discovery surface).
  if (req.method === 'GET') {
    if (!req.headers.get('last-event-id')) {
      usage.phase = 'transport';
      return new Response(null, {
        status: 405,
        headers: withMcpNoStore({ Allow: 'POST, GET, HEAD, OPTIONS', ...corsHeaders }),
      });
    }
    const auth = await resolveAuthContext(req, deps, resourceMetadataUrl, corsHeaders);
    if (!auth.ok) {
      usage.phase = 'auth';
      return auth.response;
    }
    setUsageContext(usage, auth.context);
    const getPreCheck = await runContextPreChecks(auth.context, deps, resourceMetadataUrl, corsHeaders, ctx);
    if (getPreCheck) {
      usage.phase = 'precheck';
      return getPreCheck;
    }
    const getLimited = await applyPerMinuteLimit(auth.context, corsHeaders);
    if (getLimited) {
      usage.phase = 'limit';
      return getLimited;
    }
    const replay = handleSseReplay(req, corsHeaders);
    if (replay.status !== 200) usage.phase = 'transport';
    return replay;
  }

  // Parse body BEFORE auth: the method decides whether credentials are required
  // (public discovery methods are servable anonymously). Malformed/missing-method
  // POSTs are a client error regardless of auth, so returning -32600 here (rather
  // than 401-then-32600) leaks nothing.
  let body: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
  try {
    body = await req.json();
  } catch {
    usage.phase = 'malformed';
    return rpcError(null, -32600, 'Invalid request: malformed JSON', corsHeaders);
  }

  if (!body || typeof body.method !== 'string') {
    usage.phase = 'malformed';
    return rpcError(body?.id ?? null, -32600, 'Invalid request: missing method', corsHeaders);
  }

  const { id, method } = body;

  // Anonymous-servable resources/read promotions. Two kinds of resource carry
  // NO data and spend NO quota, so they are served on the anonymous discovery
  // path (like tools/list / resources/list) — an unauthenticated MCP-Apps host
  // or agent-readiness scanner can read them cleanly:
  //   1. MCP Apps (`io.modelcontextprotocol/ui`): a `ui://` read returns a
  //      STATIC, data-free HTML app shell (live data arrives later via host
  //      postMessage after a normal gated tools/call).
  //   2. PUBLIC data resources: a concrete, metadata-only freshness/health
  //      probe (see PUBLIC_RESOURCE_REGISTRY) — exact-matched, so a data-
  //      bearing template instantiation never qualifies.
  // DATA reads (a `worldmonitor://…` template instantiation) stay fully gated +
  // Pro-quota-symmetric via the protected branch below.
  const resourceReadUri = method === 'resources/read'
    ? ((body.params as { uri?: unknown } | null)?.uri)
    : undefined;
  const uiResourceReadUri = typeof resourceReadUri === 'string' && isUiResourceUri(resourceReadUri)
    ? resourceReadUri
    : null;
  const isPublicResourceRead = typeof resourceReadUri === 'string' && isPublicResourceUri(resourceReadUri);
  const isAnonResourceRead = uiResourceReadUri !== null || isPublicResourceRead;

  // Auth gate. `context` is null only on the anonymous discovery path; every
  // data/quota method below runs the full protected path and always sets it.
  let context: McpAuthContext | null = null;
  if (PUBLIC_MCP_METHODS.has(method) || isAnonResourceRead) {
    if (hasCredentials(req)) {
      // Credentials presented on a public method are still validated so a
      // present-but-invalid key surfaces a 401 instead of a silent anon
      // downgrade; a valid principal is attributed for telemetry + limits.
      const auth = await resolveAuthContext(req, deps, resourceMetadataUrl, corsHeaders);
      if (!auth.ok) {
        usage.phase = 'auth';
        return auth.response;
      }
      context = auth.context;
      setUsageContext(usage, context);
      const limited = await applyPerMinuteLimit(context, corsHeaders);
      if (limited) {
        usage.phase = 'limit';
        return limited;
      }
    } else {
      const anonLimited = await applyAnonDiscoveryLimit(req, corsHeaders);
      if (anonLimited) {
        usage.phase = 'limit';
        return anonLimited;
      }
    }
  } else {
    const auth = await resolveAuthContext(req, deps, resourceMetadataUrl, corsHeaders);
    if (!auth.ok) {
      usage.phase = 'auth';
      return auth.response;
    }
    context = auth.context;
    setUsageContext(usage, context);
    const preCheck = await runContextPreChecks(context, deps, resourceMetadataUrl, corsHeaders, ctx);
    if (preCheck) {
      usage.phase = 'precheck';
      return preCheck;
    }
    const limited = await applyPerMinuteLimit(context, corsHeaders);
    if (limited) {
      usage.phase = 'limit';
      return limited;
    }
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
        //
        // `extensions['io.modelcontextprotocol/ui']` declares MCP Apps support
        // (spec 2026-01-26). This is the extension's negotiation signal: a host
        // (or agent-readiness scanner) reads it off `initialize.capabilities`
        // to classify the server as an MCP-App surface — the ui:// app-shell
        // resource + the tool `_meta.ui.resourceUri` are the content, this key
        // is the handshake. Declared unconditionally: our ui:// shells
        // and tool `_meta` are static and always present, so there is nothing
        // to gate on the client advertising the extension. Value is an empty
        // object per spec (extension carries no negotiation parameters here).
        capabilities: {
          tools: {},
          logging: {},
          prompts: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          extensions: { 'io.modelcontextprotocol/ui': {} },
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
    case 'tools/call': {
      // context is always set here — tools/call is never a PUBLIC_MCP_METHOD.
      // The guard narrows the type and hard-fails closed if that ever changes.
      if (!context) {
        usage.phase = 'auth';
        return authRequiredResponse(id, resourceMetadataUrl, corsHeaders);
      }
      const dispatched = await dispatchToolsCall(req, context, deps, body, corsHeaders, ctx);
      if (dispatched.status === 429 || dispatched.status === 503) usage.phase = 'dispatch';
      return maybeStreamJsonRpcResponse(req, dispatched);
    }
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
    // Resources split by data sensitivity. resources/list + the new
    // resources/templates/list are metadata-class — public catalog-enumeration
    // methods (in PUBLIC_MCP_METHODS, quota-exempt, anon-rate-limited) that
    // return only URIs / URI templates + names + descriptions, never data.
    // They use no `context`. resources/list surfaces the concrete PUBLIC
    // resources (metadata-only, anon-readable); resources/templates/list
    // surfaces the data-bearing URI templates.
    case 'resources/list':
      // Concrete DATA resources (worldmonitor://…, the metadata-only PUBLIC
      // freshness probe) lead; the MCP Apps `ui://` app-shell resources follow.
      // Both are metadata-class (URIs/names/descriptions, no data) and read
      // cleanly for an anonymous scanner reading the `resources` capability —
      // including the ui:// surface that signals MCP Apps support. The
      // data-bearing URI templates are surfaced separately via
      // resources/templates/list (a literal `{iso2}` URI can't resolve, so it
      // must not appear in a list an anonymous validator reads back).
      return maybeStreamJsonRpcResponse(req, rpcOk(id, { resources: [...RESOURCE_LIST_RESPONSE, ...UI_RESOURCE_LIST_RESPONSE] }, corsHeaders));
    case 'resources/templates/list':
      return maybeStreamJsonRpcResponse(req, rpcOk(id, { resourceTemplates: RESOURCE_TEMPLATE_LIST_RESPONSE }, corsHeaders));
    case 'resources/read':
      // MCP Apps `ui://` read: a static, data-free HTML app shell served on the
      // public path (no context, no quota, no dispatch). Resolved above into
      // `uiResourceReadUri`.
      if (uiResourceReadUri) {
        return maybeStreamJsonRpcResponse(req, buildUiResourceRead(id, uiResourceReadUri, corsHeaders));
      }
      // A PUBLIC data resource read (concrete, metadata-only freshness/health
      // probe) is likewise served anonymously + quota-exempt via its direct
      // reader — no data, no dispatchToolsCall, no Pro reservation.
      if (isPublicResourceRead) {
        return maybeStreamJsonRpcResponse(req, await buildPublicResourceResponse(body, corsHeaders));
      }
      // A data-bearing TEMPLATE instantiation MUST consume the Pro daily quota
      // IDENTICALLY to a tools/call to the equivalent tool. Asymmetric auth
      // here is a known MCP data-leak vector (a Pro user at the daily cap could
      // otherwise keep reading data via resources for free). The symmetry is
      // structural: buildResourceResponse synthesizes a tools/call body and
      // routes through dispatchToolsCall, inheriting the reservation +
      // telemetry path. `context` is always set here — a non-public
      // resources/read runs the gated path above; the guard fails closed.
      if (!context) {
        usage.phase = 'auth';
        return authRequiredResponse(id, resourceMetadataUrl, corsHeaders);
      }
      {
        const resourceRes = await buildResourceResponse(req, context, deps, body, corsHeaders, ctx);
        if (resourceRes.status === 429 || resourceRes.status === 503) usage.phase = 'dispatch';
        return maybeStreamJsonRpcResponse(req, resourceRes);
      }
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
