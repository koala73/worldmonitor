// @ts-nocheck — Migrated from .js to .ts only to unlock the
// `isCallerPremium` import from server/ (PR #3768 review). Body remains
// JS-shaped; not annotating types in this commit. Future PR can add
// types incrementally; behaviour is unchanged.
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';
import { isCallerPremium } from '../server/_shared/premium-check';
import { isBlockedResolvedAddress } from '../server/_shared/ip-address-classification';
import { ENDPOINT_RATE_POLICIES, checkScopedRateLimit, getClientIp } from '../server/_shared/rate-limit';

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
const DNS_RESOLUTION_TIMEOUT_MS = 3_000;
const DNS_JSON_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
// Production waits up to 12s for an SSE RPC response. The node test runner sets
// NODE_TEST_CONTEXT; an SSE mock that closes its stream before the proxy
// registers its RPC deferred would otherwise stall the suite for that full
// window. Shorten it under the test runner only — the routing/SSRF tests still
// exercise the timeout→reject (504) path, just without the wall-clock stall.
const SSE_RPC_TIMEOUT_MS = process.env.NODE_TEST_CONTEXT ? 200 : 12_000;
const MCP_PROTOCOL_VERSION = '2025-03-26';

function withProxyNoStore(headers: Record<string, string> = {}): Record<string, string> {
  return { ...headers, 'Cache-Control': 'no-store' };
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.internal',
  'metadata.google.internal',
  'instance-data',
  'computemetadata',
  'link-local.s3.amazonaws.com',
  '169.254.169.254',
]);

const TEST_RESOLVER_KEY = Symbol.for('worldmonitor.mcpProxy.resolveHostnameForTest');

function getResolveHostnameForTest() {
  if (!process.env.NODE_TEST_CONTEXT) return null;
  const resolver = globalThis[TEST_RESOLVER_KEY];
  return typeof resolver === 'function' ? resolver : null;
}

class McpProxySsrfError extends Error {
  constructor(message) {
    super(message);
    this.name = 'McpProxySsrfError';
  }
}

// Generic message surfaced to the caller when a serverUrl resolves to a
// private/reserved address. The specific blocked IP is deliberately NOT echoed
// back: returning it turns the proxy into an address oracle (the caller could
// enumerate internal IPs by observing which hostnames get blocked). SSRF review
// finding — log the concrete IP server-side for debugging, tell the caller only
// that the host is disallowed.
const SSRF_BLOCKED_PUBLIC_MESSAGE = 'serverUrl host is not allowed';

function throwBlockedAddress(blockedAddress) {
  // Server-side audit/debug log with the concrete blocked address. This is the
  // only place the resolved internal IP appears; it never reaches the response.
  console.error('[mcp-proxy]', {
    event: 'mcp_proxy_ssrf_blocked',
    ts: new Date().toISOString(),
    blocked_address: blockedAddress,
  });
  throw new McpProxySsrfError(SSRF_BLOCKED_PUBLIC_MESSAGE);
}

async function resolveDnsJson(hostname, recordType) {
  const url = new URL(DNS_JSON_ENDPOINT);
  url.searchParams.set('name', hostname);
  url.searchParams.set('type', recordType);
  const response = await fetch(url.toString(), {
    headers: {
      Accept: 'application/dns-json',
      'User-Agent': 'WorldMonitor-MCP-Proxy/1.0',
    },
    signal: AbortSignal.timeout(DNS_RESOLUTION_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`DNS ${recordType} lookup failed: HTTP ${response.status}`);
  }
  const data = await response.json();
  if (data?.Status !== 0) {
    throw new Error(`DNS ${recordType} lookup failed: status ${data?.Status}`);
  }
  const expectedType = recordType === 'A' ? 1 : 28;
  return (Array.isArray(data?.Answer) ? data.Answer : [])
    .filter(answer => answer?.type === expectedType && typeof answer?.data === 'string')
    .map(answer => answer.data);
}

async function defaultResolveHostname(hostname) {
  const resolveHostnameForTest = getResolveHostnameForTest();
  if (resolveHostnameForTest) return resolveHostnameForTest(hostname);
  const records = await Promise.all([
    resolveDnsJson(hostname, 'A'),
    resolveDnsJson(hostname, 'AAAA'),
  ]);
  return records.flat();
}

async function assertServerUrlSafe(url) {
  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new McpProxySsrfError(`serverUrl hostname is blocked: ${hostname}`);
  }
  if (isBlockedResolvedAddress(hostname)) {
    throwBlockedAddress(hostname);
  }

  let resolvedAddresses;
  try {
    resolvedAddresses = await defaultResolveHostname(hostname);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new McpProxySsrfError(`serverUrl DNS resolution failed: ${message}`);
  }

  if (!resolvedAddresses.length) {
    throw new McpProxySsrfError('serverUrl DNS resolution returned no addresses');
  }

  const blocked = resolvedAddresses.find(isBlockedResolvedAddress);
  if (blocked) {
    throwBlockedAddress(blocked);
  }

  return { url, resolvedAddresses };
}

// Vercel Edge fetch does not expose a Node-style lookup/socket hook, so this
// proxy CANNOT pin the TLS connection to a previously vetted address. There is
// no way to guarantee that the IP we validated is the IP fetch() ultimately
// connects to; a DNS answer can change between our resolve and fetch's own
// resolve. This re-resolve-and-recheck immediately before every outbound
// dispatch NARROWS that DNS-rebinding window but does not close it. The
// residual rebind window is an ACCEPTED limitation of the Edge runtime (no
// socket-level pin available) — documented, not fixed here (P2, issue #5061).
async function revalidateBeforeFetch(url) {
  await assertServerUrlSafe(url);
}

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

async function validateServerUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  try {
    return (await assertServerUrlSafe(url)).url;
  } catch {
    return null;
  }
}

// Cloud-metadata gate headers (GHSA-887j, Edge-safe defence-in-depth): GCP
// `Metadata-Flavor: Google`, Azure `Metadata: true`, AWS IMDSv2
// `X-aws-ec2-metadata-token[-ttl-seconds]`. The proxy never forwards them, so
// even if a DNS rebind slipped a fetch onto 169.254.169.254 the credential-less
// request is refused by the metadata service. Matched case-insensitively. (The
// full socket-pin fix that closes resolve!=connect is a Node-runtime follow-up;
// this Edge mitigation kills the demonstrated PoC without a runtime switch;
// the accepted residual and migration trade-off are tracked in issue #5061.)
const DENIED_FORWARD_HEADERS = new Set([
  'metadata-flavor',
  'metadata',
  'x-aws-ec2-metadata-token',
  'x-aws-ec2-metadata-token-ttl-seconds',
]);

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
        // Hop-by-hop / authority headers (Host, Content-Length, Connection, TE,
        // Trailer, Upgrade, Keep-Alive, Transfer-Encoding, Proxy-*) are NOT
        // filtered here: on the Edge runtime the spec-compliant `fetch()` treats
        // them as forbidden header names and silently drops them, so they never
        // reach the upstream. (The Node-runtime socket-pin follow-up uses raw
        // `http.request`, which does NOT auto-drop them, so that PR must add an
        // explicit hop-by-hop filter — see #5061.)
        if (safeKey && !DENIED_FORWARD_HEADERS.has(safeKey.toLowerCase())) {
          h[safeKey] = safeVal;
        }
      }
    }
  }
  return h;
}

// --- Streamable HTTP transport (MCP 2025-03-26) ---

async function postJson(url, body, headers, sessionId) {
  const h = { ...headers };
  if (sessionId) h['Mcp-Session-Id'] = sessionId;
  await revalidateBeforeFetch(url);
  const resp = await fetch(url.toString(), {
    method: 'POST',
    headers: h,
    body: JSON.stringify(body),
    redirect: 'manual',
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
  } catch (error) {
    if (error instanceof McpProxySsrfError) throw error;
    /* non-fatal */
  }
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
    await revalidateBeforeFetch(new URL(this._sseUrl));
    const resp = await fetch(this._sseUrl, {
      headers: { ...this._headers, Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
      redirect: 'manual',
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
                if (BLOCKED_HOSTNAMES.has(resolved.hostname.toLowerCase()) || isBlockedResolvedAddress(resolved.hostname)) {
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
      await revalidateBeforeFetch(new URL(this._endpointUrl));
      const postResp = await fetch(this._endpointUrl, {
        method: 'POST',
        headers: { ...this._headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        redirect: 'manual',
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
    await revalidateBeforeFetch(new URL(this._endpointUrl));
    await fetch(this._endpointUrl, {
      method: 'POST',
      headers: { ...this._headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      redirect: 'manual',
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
  const serverUrl = await validateServerUrl(rawServer);
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
  const serverUrl = await validateServerUrl(rawServer);
  if (!serverUrl) return jsonResponse({ error: 'Invalid serverUrl' }, 400, cors);
  captureMeta(serverUrl, customHeaders, meta);
  const result = isSseTransport(serverUrl)
    ? await mcpCallToolSse(serverUrl, toolName, toolArgs || {}, customHeaders || {})
    : await mcpCallTool(serverUrl, toolName, toolArgs || {}, customHeaders || {});
  return jsonResponse({ result }, 200, cors);
}

export default async function handler(req) {
  if (isDisallowedOrigin(req))
    return new Response('Forbidden', { status: 403, headers: withProxyNoStore() });

  const cors = withProxyNoStore(getCorsHeaders(req, 'GET, POST, OPTIONS'));
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
        headers: withProxyNoStore({
          'Content-Type': 'application/json',
          'X-RateLimit-Limit': String(scoped.limit),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(scoped.reset),
          'Retry-After': String(retryAfter),
          ...cors,
        }),
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
