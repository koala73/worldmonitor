// @ts-nocheck — Migrated from .js to .ts only to unlock the
// `isCallerPremium` import from server/ (PR #3768 review). Body remains
// JS-shaped; not annotating types in this commit. Future PR can add
// types incrementally; behaviour is unchanged.
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';
import { isCallerPremium } from '../server/_shared/premium-check';
import { ENDPOINT_RATE_POLICIES, checkScopedRateLimit } from '../server/_shared/rate-limit';

export const config = { runtime: 'edge' };

// Per-IP rate limit for the MCP proxy (issue #3805 defense-in-depth).
// 30/min/IP is generous for normal MCP polling (most clients refresh every
// 30-60s) while bounding abuse to ~1800 calls/hour/IP — well below the
// global 600/min cap. Auth gate already requires a Pro caller; this limit
// closes the residual surface where a single Pro key cycles the proxy.
//
// PR #3821 r2: source the limit from ENDPOINT_RATE_POLICIES so the
// `enforce-rate-limit-policies` audit can see this endpoint. mcp-proxy is a
// top-level Vercel Edge Function (not gateway-routed), so it can't use
// `checkEndpointRateLimit`; we keep `checkScopedRateLimit` for in-handler
// enforcement but the *policy* lives in the registry. Single source of
// truth — tweak the limit there, this handler picks it up.
const RATE_LIMIT_SCOPE = '/api/mcp-proxy';
const RATE_LIMIT_POLICY = ENDPOINT_RATE_POLICIES[RATE_LIMIT_SCOPE];
if (!RATE_LIMIT_POLICY) {
  // Module-load failure — better to crash the function cold-start with a
  // loud message than to silently fall back to "no rate limit" if someone
  // accidentally deletes the registry entry.
  throw new Error(
    `[mcp-proxy] missing ENDPOINT_RATE_POLICIES['${RATE_LIMIT_SCOPE}'] — see server/_shared/rate-limit.ts`,
  );
}
const RATE_LIMIT_MAX = RATE_LIMIT_POLICY.limit;
const RATE_LIMIT_WINDOW = RATE_LIMIT_POLICY.window;
const RATE_LIMIT_ERROR_CODE = -32029; // JSON-RPC code mirrored from api/mcp.ts

function getClientIp(req: Request): string {
  // cf-connecting-ip is the only header that survives Cloudflare → Vercel
  // unforged. x-forwarded-for is client-settable and must NOT be trusted
  // for rate limiting — see api/_rate-limit.js notes (#3721).
  return (
    req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-real-ip') ||
    '0.0.0.0'
  );
}

function logProxyCall(entry: {
  ip: string;
  target_host: string;
  target_path: string;
  method: string;
  header_names: string[];
  status: number;
  duration_ms: number;
}): void {
  // Structured audit log (#3805). Mirrors the `[name] { ...fields }` shape
  // used by api/cache-purge.js so the existing log-ingest tooling parses it
  // cleanly. Never include header VALUES — they often carry user-supplied
  // Authorization / API-Key secrets that the proxy intentionally forwards.
  console.log('[mcp-proxy]', {
    event: 'mcp_proxy_call',
    ts: new Date().toISOString(),
    ...entry,
  });
}

const TIMEOUT_MS = 15_000;
const SSE_CONNECT_TIMEOUT_MS = 10_000;
const SSE_RPC_TIMEOUT_MS = 12_000;
const MCP_PROTOCOL_VERSION = '2025-03-26';

const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,   // link-local + cloud metadata (AWS/GCP/Azure)
  /^::1$/,
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,
];

function buildInitPayload() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'worldmonitor', version: '1.0' },
    },
  };
}

function validateServerUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname;
  if (BLOCKED_HOST_PATTERNS.some(p => p.test(host))) return null;
  return url;
}

function buildHeaders(customHeaders) {
  const h = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'User-Agent': 'WorldMonitor-MCP-Proxy/1.0',
  };
  if (customHeaders && typeof customHeaders === 'object') {
    for (const [k, v] of Object.entries(customHeaders)) {
      if (typeof k === 'string' && typeof v === 'string') {
        // Strip CRLF to prevent header injection
        const safeKey = k.replace(/[\r\n]/g, '');
        const safeVal = v.replace(/[\r\n]/g, '');
        if (safeKey) h[safeKey] = safeVal;
      }
    }
  }
  return h;
}

// --- Streamable HTTP transport (MCP 2025-03-26) ---

async function postJson(url, body, headers, sessionId) {
  const h = { ...headers };
  if (sessionId) h['Mcp-Session-Id'] = sessionId;
  const resp = await fetch(url.toString(), {
    method: 'POST',
    headers: h,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return resp;
}

async function parseJsonRpcResponse(resp) {
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) {
    const text = await resp.text();
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const parsed = JSON.parse(line.slice(6));
          if (parsed.result !== undefined || parsed.error !== undefined) return parsed;
        } catch { /* skip */ }
      }
    }
    throw new Error('No result found in SSE response');
  }
  return resp.json();
}

async function sendInitialized(serverUrl, headers, sessionId) {
  try {
    await postJson(serverUrl, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    }, headers, sessionId);
  } catch { /* non-fatal */ }
}

async function mcpListTools(serverUrl, customHeaders) {
  const headers = buildHeaders(customHeaders);
  const initResp = await postJson(serverUrl, buildInitPayload(), headers, null);
  if (!initResp.ok) throw new Error(`Initialize failed: HTTP ${initResp.status}`);
  const sessionId = initResp.headers.get('Mcp-Session-Id') || initResp.headers.get('mcp-session-id');
  const initData = await parseJsonRpcResponse(initResp);
  if (initData.error) throw new Error(`Initialize error: ${initData.error.message}`);
  await sendInitialized(serverUrl, headers, sessionId);
  const listResp = await postJson(serverUrl, {
    jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
  }, headers, sessionId);
  if (!listResp.ok) throw new Error(`tools/list failed: HTTP ${listResp.status}`);
  const listData = await parseJsonRpcResponse(listResp);
  if (listData.error) throw new Error(`tools/list error: ${listData.error.message}`);
  return listData.result?.tools || [];
}

async function mcpCallTool(serverUrl, toolName, toolArgs, customHeaders) {
  const headers = buildHeaders(customHeaders);
  const initResp = await postJson(serverUrl, buildInitPayload(), headers, null);
  if (!initResp.ok) throw new Error(`Initialize failed: HTTP ${initResp.status}`);
  const sessionId = initResp.headers.get('Mcp-Session-Id') || initResp.headers.get('mcp-session-id');
  const initData = await parseJsonRpcResponse(initResp);
  if (initData.error) throw new Error(`Initialize error: ${initData.error.message}`);
  await sendInitialized(serverUrl, headers, sessionId);
  const callResp = await postJson(serverUrl, {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: toolName, arguments: toolArgs || {} },
  }, headers, sessionId);
  if (!callResp.ok) throw new Error(`tools/call failed: HTTP ${callResp.status}`);
  const callData = await parseJsonRpcResponse(callResp);
  if (callData.error) throw new Error(`tools/call error: ${callData.error.message}`);
  return callData.result;
}

// --- SSE transport (HTTP+SSE, older MCP spec) ---
// Servers whose URL path ends with /sse use this protocol:
//   1. Client GETs the SSE URL — server opens a stream and emits an `endpoint` event
//      containing the URL where the client should POST JSON-RPC messages.
//   2. Client POSTs JSON-RPC to that endpoint URL.
//   3. Server sends responses on the same SSE stream as `data:` lines.

function isSseTransport(url) {
  const p = url.pathname;
  return p === '/sse' || p.endsWith('/sse');
}

function makeDeferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class SseSession {
  constructor(sseUrl, headers) {
    this._sseUrl = sseUrl;
    this._originHost = new URL(sseUrl).host;
    this._originProtocol = new URL(sseUrl).protocol;
    this._headers = headers;
    this._endpointUrl = null;
    this._endpointDeferred = makeDeferred();
    this._pending = new Map(); // rpc id -> deferred
    this._reader = null;
  }

  async connect() {
    const resp = await fetch(this._sseUrl, {
      headers: { ...this._headers, Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(SSE_CONNECT_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`SSE connect HTTP ${resp.status}`);
    this._reader = resp.body.getReader();
    this._startReadLoop();
    await this._endpointDeferred.promise;
  }

  _startReadLoop() {
    const dec = new TextDecoder();
    let buf = '';
    let eventType = '';
    const reader = this._reader;

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // Stream closed — if endpoint never arrived, reject so connect() throws
            if (!this._endpointUrl) {
              this._endpointDeferred.reject(new Error('SSE stream closed before endpoint event'));
            }
            for (const [, d] of this._pending) d.reject(new Error('SSE stream closed'));
            break;
          }
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (eventType === 'endpoint') {
                // Resolve endpoint URL (relative path or absolute) then re-validate
                // to prevent SSRF: a malicious server could emit an RFC1918 address.
                let resolved;
                try {
                  resolved = new URL(data.startsWith('http') ? data : data, this._sseUrl);
                } catch {
                  this._endpointDeferred.reject(new Error('SSE endpoint event contains invalid URL'));
                  return;
                }
                if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') {
                  this._endpointDeferred.reject(new Error('SSE endpoint protocol not allowed'));
                  return;
                }
                if (BLOCKED_HOST_PATTERNS.some(p => p.test(resolved.hostname))) {
                  this._endpointDeferred.reject(new Error('SSE endpoint host is blocked'));
                  return;
                }
                // Pin endpoint to the same host as the original SSE URL to
                // prevent a malicious server from redirecting via the endpoint
                // event to an internal host (DNS rebinding / SSRF).
                if (resolved.host !== this._originHost || resolved.protocol !== this._originProtocol) {
                  this._endpointDeferred.reject(
                    new Error('SSE endpoint host or protocol does not match origin server'),
                  );
                  return;
                }
                this._endpointUrl = resolved.toString();
                this._endpointDeferred.resolve();
              } else {
                try {
                  const msg = JSON.parse(data);
                  if (msg.id !== undefined) {
                    const d = this._pending.get(msg.id);
                    if (d) { this._pending.delete(msg.id); d.resolve(msg); }
                  }
                } catch { /* skip non-JSON data lines */ }
              }
              eventType = '';
            }
          }
        }
      } catch (err) {
        this._endpointDeferred.reject(err);
        for (const [, d] of this._pending) d.reject(new Error('SSE stream closed'));
      }
    })();
  }

  async send(id, method, params) {
    const deferred = makeDeferred();
    this._pending.set(id, deferred);
    const timer = setTimeout(() => {
      if (this._pending.has(id)) {
        this._pending.delete(id);
        deferred.reject(new Error(`RPC ${method} timed out`));
      }
    }, SSE_RPC_TIMEOUT_MS);
    try {
      const postResp = await fetch(this._endpointUrl, {
        method: 'POST',
        headers: { ...this._headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(SSE_RPC_TIMEOUT_MS),
      });
      if (!postResp.ok) {
        this._pending.delete(id);
        throw new Error(`${method} POST HTTP ${postResp.status}`);
      }
      return await deferred.promise;
    } finally {
      clearTimeout(timer);
    }
  }

  async notify(method, params) {
    await fetch(this._endpointUrl, {
      method: 'POST',
      headers: { ...this._headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
  }

  close() {
    try { this._reader?.cancel(); } catch { /* ignore */ }
  }
}

async function mcpListToolsSse(serverUrl, customHeaders) {
  const headers = buildHeaders(customHeaders);
  const session = new SseSession(serverUrl.toString(), headers);
  try {
    await session.connect();
    const initResp = await session.send(1, 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'worldmonitor', version: '1.0' },
    });
    if (initResp.error) throw new Error(`Initialize error: ${initResp.error.message}`);
    await session.notify('notifications/initialized', {});
    const listResp = await session.send(2, 'tools/list', {});
    if (listResp.error) throw new Error(`tools/list error: ${listResp.error.message}`);
    return listResp.result?.tools || [];
  } finally {
    session.close();
  }
}

async function mcpCallToolSse(serverUrl, toolName, toolArgs, customHeaders) {
  const headers = buildHeaders(customHeaders);
  const session = new SseSession(serverUrl.toString(), headers);
  try {
    await session.connect();
    const initResp = await session.send(1, 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'worldmonitor', version: '1.0' },
    });
    if (initResp.error) throw new Error(`Initialize error: ${initResp.error.message}`);
    await session.notify('notifications/initialized', {});
    const callResp = await session.send(2, 'tools/call', { name: toolName, arguments: toolArgs || {} });
    if (callResp.error) throw new Error(`tools/call error: ${callResp.error.message}`);
    return callResp.result;
  } finally {
    session.close();
  }
}

// --- Request handler ---

interface ProxyMeta {
  targetHost: string;
  targetPath: string;
  headerNames: string[];
}

function captureMeta(serverUrl: URL, customHeaders: unknown, meta: ProxyMeta): void {
  meta.targetHost = serverUrl.hostname;
  meta.targetPath = serverUrl.pathname;
  meta.headerNames = Object.keys((customHeaders as Record<string, unknown>) || {})
    .filter((k) => typeof k === 'string' && !k.includes('\r') && !k.includes('\n'))
    .sort();
}

async function handleListTools(req: Request, cors: Record<string, string>, meta: ProxyMeta): Promise<Response> {
  const url = new URL(req.url);
  const rawServer = url.searchParams.get('serverUrl');
  const rawHeaders = url.searchParams.get('headers');
  if (!rawServer) return jsonResponse({ error: 'Missing serverUrl' }, 400, cors);
  const serverUrl = validateServerUrl(rawServer);
  if (!serverUrl) return jsonResponse({ error: 'Invalid serverUrl' }, 400, cors);
  let customHeaders = {};
  if (rawHeaders) {
    try { customHeaders = JSON.parse(rawHeaders); } catch { /* ignore */ }
  }
  captureMeta(serverUrl, customHeaders, meta);
  const tools = isSseTransport(serverUrl)
    ? await mcpListToolsSse(serverUrl, customHeaders)
    : await mcpListTools(serverUrl, customHeaders);
  return jsonResponse({ tools }, 200, cors);
}

async function handleCallTool(req: Request, cors: Record<string, string>, meta: ProxyMeta): Promise<Response> {
  const body = await req.json();
  const { serverUrl: rawServer, toolName, toolArgs, customHeaders } = body;
  if (!rawServer) return jsonResponse({ error: 'Missing serverUrl' }, 400, cors);
  if (!toolName) return jsonResponse({ error: 'Missing toolName' }, 400, cors);
  const serverUrl = validateServerUrl(rawServer);
  if (!serverUrl) return jsonResponse({ error: 'Invalid serverUrl' }, 400, cors);
  captureMeta(serverUrl, customHeaders, meta);
  const result = isSseTransport(serverUrl)
    ? await mcpCallToolSse(serverUrl, toolName, toolArgs || {}, customHeaders || {})
    : await mcpCallTool(serverUrl, toolName, toolArgs || {}, customHeaders || {});
  return jsonResponse({ result }, 200, { ...cors, 'Cache-Control': 'no-store' });
}

export default async function handler(req) {
  if (isDisallowedOrigin(req))
    return new Response('Forbidden', { status: 403 });

  const cors = getCorsHeaders(req, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: cors });

  // Auth gate (issue #3723). The proxy can relay arbitrary customHeaders
  // (Authorization, API keys) to any public MCP server under WorldMonitor's
  // outbound IP, and consume our outbound-IP reputation / quota — so the
  // gate must accept ONLY paying / authorised callers.
  //
  // Pre-this-PR the endpoint was open. The first cut accepted wms_
  // anonymous session tokens which are freely mintable via /api/wm-session
  // → two-step bypass. The second cut went enterprise-key-only via
  // validateApiKey forceKey:true, which broke the Pro "Connect MCP" UI
  // for normal web Pro users (no enterprise key path).
  //
  // isCallerPremium is the project's canonical premium-caller check. It
  // accepts: enterprise key (WORLDMONITOR_VALID_KEYS), wm_ user API key
  // (Convex-validated + entitlement check), and Clerk Pro Bearer JWT
  // (role==='pro' or entitlement tier>=1). It rejects wms_ session tokens
  // by requiring keyCheck.required === true (wms_ short-circuits at
  // required:false). isDisallowedOrigin already blocked cross-origin
  // browser callers; this closes the curl + wms_ farm paths too.
  //
  // Pair: src/components/McpConnectModal.ts + McpDataPanel.ts must use
  // premiumFetch (not plain fetch) so the renderer attaches the Bearer
  // for Pro users; /api/mcp-proxy is now in PREMIUM_RPC_PATHS for that
  // path-gated injection.
  if (!(await isCallerPremium(req)))
    return jsonResponse({ error: 'Pro authentication required' }, 401, cors);

  const started = Date.now();
  const ip = getClientIp(req);
  const meta: ProxyMeta = { targetHost: '', targetPath: '', headerNames: [] };

  // Per-IP rate limit (#3805). Runs AFTER auth/CORS so unauthenticated and
  // cross-origin callers are still rejected first (cheaper to short-circuit
  // without a Redis round-trip). This endpoint is already premium-auth gated,
  // so Redis-degraded scoped limits intentionally stay availability-first;
  // checkScopedRateLimit logs/Sentry-captures the degraded path.
  const scoped = await checkScopedRateLimit(RATE_LIMIT_SCOPE, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW, ip);
  if (!scoped.allowed) {
    const retryAfter = Math.max(1, Math.ceil((scoped.reset - Date.now()) / 1000));
    logProxyCall({
      ip,
      target_host: meta.targetHost,
      target_path: meta.targetPath,
      method: req.method,
      header_names: meta.headerNames,
      status: 429,
      duration_ms: Date.now() - started,
    });
    // JSON-RPC -32029 mirrors api/mcp.ts; HTTP 429 + Retry-After follows the
    // shared rate-limit response shape.
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: RATE_LIMIT_ERROR_CODE, message: `Rate limit exceeded. Max ${RATE_LIMIT_MAX} requests per ${RATE_LIMIT_WINDOW} per IP.` },
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'X-RateLimit-Limit': String(scoped.limit),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(scoped.reset),
          'Retry-After': String(retryAfter),
          ...cors,
        },
      },
    );
  }

  let response: Response;
  try {
    if (req.method === 'GET') {
      response = await handleListTools(req, cors, meta);
    } else if (req.method === 'POST') {
      response = await handleCallTool(req, cors, meta);
    } else {
      response = jsonResponse({ error: 'Method not allowed' }, 405, cors);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes('TimeoutError') || msg.includes('timed out');
    // Return 422 (not 502) so Cloudflare proxy does not replace our JSON body with its own HTML error page
    response = jsonResponse({ error: isTimeout ? 'MCP server timed out' : msg }, isTimeout ? 504 : 422, cors);
  }

  logProxyCall({
    ip,
    target_host: meta.targetHost,
    target_path: meta.targetPath,
    method: req.method,
    header_names: meta.headerNames,
    status: response.status,
    duration_ms: Date.now() - started,
  });

  return response;
}
