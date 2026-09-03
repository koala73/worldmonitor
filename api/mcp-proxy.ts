// @ts-nocheck — Migrated from .js to .ts only to unlock the
// `isCallerPremium` import from server/ (PR #3768 review). Body remains
// JS-shaped; not annotating types in this commit. Future PR can add
// types incrementally; behaviour is unchanged.
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';
import { captureSilentError } from './_sentry-node.js';
import { isCallerPremium } from '../server/_shared/premium-check';
import { isBlockedResolvedAddress } from '../server/_shared/ip-address-classification';
import {
  readBoundedRequestBody,
  readBoundedResponseBody,
  RequestBodyTooLargeError,
  ResponseBodyTooLargeError,
} from './mcp/bounded-body';
import { MAX_JSON_RPC_BODY_BYTES, MAX_MCP_PROXY_RESPONSE_BYTES } from './mcp/body-limits';
import { McpProxyJsonDepthError, parseMcpProxyJson } from './mcp/bounded-json';
import { ENDPOINT_RATE_POLICIES, checkScopedRateLimit, getClientIp } from '../server/_shared/rate-limit';

// Node runtime, not Edge (GHSA-887j): the upstream socket is pinned to the
// DoH-vetted address via node:https's `lookup` hook, which the Edge fetch()
// cannot do. On this runtime Vercel invokes the default export as
// `handler(req, res)` with a raw IncomingMessage / ServerResponse — see the
// adapter at the bottom of this file and tests/mcp-proxy-node-entry.test.mjs.
export const config = { runtime: 'nodejs' };

// Per-IP rate limit for the MCP proxy (issue #3805 defense-in-depth).
// 30/min/IP is generous for normal MCP polling (most clients refresh every
// 30-60s) while bounding abuse to ~1800 calls/hour/IP — well below the
// global 600/min cap. Auth gate already requires a Pro caller; this limit
// closes the residual surface where a single Pro key cycles the proxy.
//
// PR #3821 r2: source the limit from ENDPOINT_RATE_POLICIES so the
// `enforce-rate-limit-policies` audit can see this endpoint. mcp-proxy is a
// top-level Vercel Function (not gateway-routed), so it can't use
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

// --- Pinned upstream transport (GHSA-887j) ---
//
// Every request to a caller-supplied MCP server goes through `pinnedFetch`,
// which connects the socket to the exact address `assertServerUrlSafe` vetted
// for THIS proxy call. The Edge fetch() re-resolved the hostname at connect
// time, so an attacker-controlled authoritative resolver (split-horizon or
// rebinding) could show DoH a public address while the platform resolver
// handed the socket loopback / link-local / RFC1918. node:https accepts a
// `lookup` hook; the hostname still drives SNI and certificate validation, so
// TLS is unchanged — only the socket address is pinned. Redirects are never
// followed (node:https has no redirect handling): a 3xx comes back as a non-ok
// response, exactly like the previous `redirect: 'manual'`.

// Test seam replacing `https.request` so the suite can observe the pinned
// lookup and serve fake upstream responses without a network. Honoured only
// under the node test runner, like the DNS resolver seam above.
const TEST_NODE_REQUEST_KEY = Symbol.for('worldmonitor.mcpProxy.nodeRequestForTest');

function getNodeRequestForTest() {
  if (!process.env.NODE_TEST_CONTEXT) return null;
  const requestForTest = globalThis[TEST_NODE_REQUEST_KEY];
  return typeof requestForTest === 'function' ? requestForTest : null;
}

// Fresh socket per request. A keep-alive pool is keyed by host/port, not by
// the address a socket was pinned to, so reuse could hand a later call a
// socket that never went through its own `lookup`.
const PINNED_UPSTREAM_AGENT = new https.Agent({ keepAlive: false });

// AbortSignal.timeout surfaces from node:https as a generic AbortError whose
// message says nothing about time; the handler's 504 mapping keys on
// 'timed out', so translate before it escapes.
class McpProxyTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
  }
}

function mapAbortError(error, signal) {
  if (signal?.aborted && signal.reason?.name === 'TimeoutError') {
    return new McpProxyTimeoutError('MCP upstream request timed out');
  }
  return error;
}

// handleProxyRequest echoes `err.message` to the caller in its 422 body. Edge's
// fetch() threw a flat `TypeError: fetch failed` and kept the detail on
// `cause`; raw node:https throws 'connect ECONNREFUSED 93.184.216.34:443',
// 'Client network socket disconnected before secure TLS connection was
// established', hostname mismatches and so on — connection-level detail the
// proxy never used to expose. Collapse everything that is not a timeout or an
// SSRF rejection to one fixed string and log the specifics server-side, the
// same split throwBlockedAddress already uses for blocked addresses.
const UPSTREAM_TRANSPORT_FAILURE_MESSAGE = 'MCP server connection failed';

function opaqueUpstreamError(error) {
  if (error instanceof McpProxySsrfError) return error;
  const raw = error instanceof Error ? error.message : String(error);
  // handleProxyRequest classifies a 504 by matching 'timed out' / 'TimeoutError'
  // in the message, so a timeout that arrives as a plain Error (an upstream
  // socket timeout rather than our own AbortSignal) must keep that
  // classification — normalised to the canonical text, not passed through raw.
  const isTimeout = error instanceof McpProxyTimeoutError
    || raw.includes('timed out')
    || raw.includes('TimeoutError')
    || error?.code === 'ETIMEDOUT';
  if (isTimeout) return new McpProxyTimeoutError('MCP upstream request timed out');
  console.error('[mcp-proxy]', {
    event: 'mcp_proxy_upstream_transport_error',
    ts: new Date().toISOString(),
    code: error?.code,
    message: raw,
  });
  return new Error(UPSTREAM_TRANSPORT_FAILURE_MESSAGE);
}

function choosePinnedAddress(resolvedAddresses) {
  // Prefer an A answer (Vercel Node functions egress over IPv4), else the first
  // AAAA. Every candidate was classified by assertServerUrlSafe; re-checking
  // the one we actually connect to keeps the pin self-contained.
  const pinnedAddress = resolvedAddresses.find((address) => !address.includes(':')) ?? resolvedAddresses[0];
  if (!pinnedAddress) {
    throw new McpProxySsrfError('serverUrl DNS resolution returned no addresses');
  }
  if (isBlockedResolvedAddress(pinnedAddress)) {
    throwBlockedAddress(pinnedAddress);
  }
  return pinnedAddress;
}

// `lookup` hook handed to node:https for one request. net.connect uses the
// single-address callback when `family` is forced (we force it) and the
// `{ all: true }` address-list shape when autoSelectFamily is in play; answer
// both so a Node default change cannot silently unpin the socket.
function pinnedLookup(pinnedAddress, family) {
  return (_hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    if (options && typeof options === 'object' && options.all) {
      done(null, [{ address: pinnedAddress, family }]);
    } else {
      done(null, pinnedAddress, family);
    }
  };
}

function headersFromIncoming(incoming) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers ?? {})) {
    if (value === undefined) continue;
    try {
      headers.append(name, Array.isArray(value) ? value.join(', ') : String(value));
    } catch {
      /* not representable as a fetch header — drop it */
    }
  }
  return headers;
}

// Bridge an upstream IncomingMessage into a Web ReadableStream so the existing
// parsers (`resp.text()`, `resp.json()`, `resp.body.getReader()`) keep working
// on a Response. Only 'data' / 'end' / 'error' are consulted; an abort
// mid-body is reported through the stream as the same timeout error the
// connect phase raises.
function incomingBodyStream(incoming, signal) {
  let finished = false;
  return new ReadableStream({
    start(controller) {
      incoming.on('data', (chunk) => {
        if (finished) return;
        controller.enqueue(chunk); // Buffer is a Uint8Array
        if (controller.desiredSize !== null && controller.desiredSize <= 0) incoming.pause();
      });
      incoming.on('end', () => {
        if (finished) return;
        finished = true;
        controller.close();
      });
      incoming.on('error', (error) => {
        if (finished) return;
        finished = true;
        controller.error(opaqueUpstreamError(mapAbortError(error, signal)));
      });
    },
    pull() {
      incoming.resume();
    },
    cancel() {
      finished = true;
      incoming.destroy();
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 }));
}

function webResponseFromIncoming(incoming, signal) {
  const rawStatus = incoming.statusCode;
  // Response() only accepts 200-599; anything else from an upstream is a bad gateway.
  const status = Number.isInteger(rawStatus) && rawStatus >= 200 && rawStatus <= 599 ? rawStatus : 502;
  const headers = headersFromIncoming(incoming);
  if (status === 204 || status === 205 || status === 304) {
    // Drain — null-body statuses cannot carry a Response body. The listener is
    // not optional: a Node stream that emits 'error' with none attached throws
    // an uncaught exception, and on this runtime that kills the process (on
    // Edge it was only logged). The caller gets the same null-body Response
    // either way, so a socket that dies mid-drain is nothing to report.
    incoming.on('error', () => {});
    incoming.resume();
    return new Response(null, { status, headers });
  }
  return new Response(incomingBodyStream(incoming, signal), { status, headers });
}

// `target` is the `{ url, resolvedAddresses }` pair assertServerUrlSafe
// produced for this proxy call. Every dispatch pins to that same vetted
// answer; nothing re-resolves at connect time.
async function pinnedFetch(target, init = {}) {
  const { url, resolvedAddresses } = target;
  const pinnedAddress = choosePinnedAddress(resolvedAddresses);
  const family = pinnedAddress.includes(':') ? 6 : 4;
  const body = init.body === undefined || init.body === null ? null : Buffer.from(String(init.body), 'utf8');
  const headers = { ...(init.headers ?? {}) };
  if (body) headers['content-length'] = String(body.byteLength);
  // Ask for an identity body: raw node:https does not transparently decode a
  // compressed response the way fetch() did, and the proxy parses the JSON.
  headers['accept-encoding'] = 'identity';
  const signal = init.signal;
  const request = getNodeRequestForTest() ?? https.request;

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(opaqueUpstreamError(mapAbortError(error, signal)));
    };
    let req;
    try {
      req = request({
        protocol: 'https:',
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        headers,
        family,
        lookup: pinnedLookup(pinnedAddress, family),
        agent: PINNED_UPSTREAM_AGENT,
        signal,
      }, (incoming) => {
        if (settled) {
          incoming.destroy();
          return;
        }
        settled = true;
        resolve(webResponseFromIncoming(incoming, signal));
      });
    } catch (error) {
      // https.request validates header names/values synchronously and throws
      // ERR_INVALID_HTTP_TOKEN / ERR_INVALID_CHAR outside the 'error' event.
      fail(error);
      return;
    }
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
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

// Returns the vetted `{ url, resolvedAddresses }` target every upstream
// dispatch of this proxy call pins to, or null when the URL is unusable.
async function validateServerUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  try {
    return await assertServerUrlSafe(url);
  } catch {
    return null;
  }
}

// Cloud-metadata gate headers (GHSA-887j defence-in-depth on top of the socket
// pin): GCP `Metadata-Flavor: Google`, Azure `Metadata: true`, AWS IMDSv2
// `X-aws-ec2-metadata-token[-ttl-seconds]`. The pin already stops a rebind
// from reaching 169.254.169.254; never forwarding these means a credentialed
// metadata request cannot be assembled even if the pin were ever bypassed.
// Matched case-insensitively.
const DENIED_FORWARD_HEADERS = new Set([
  'metadata-flavor',
  'metadata',
  'x-aws-ec2-metadata-token',
  'x-aws-ec2-metadata-token-ttl-seconds',
]);

// Hop-by-hop, authority and transport-negotiation headers a caller must never
// set on the upstream request. The Edge runtime's spec-compliant fetch()
// dropped these silently as forbidden header names; raw node:https writes
// whatever it is given, so without this list a caller-supplied Host would
// override the authority the socket was pinned for, and Content-Length /
// Transfer-Encoding / Connection / TE / Trailer / Upgrade would open request
// smuggling. `Proxy-*` is matched as a prefix. Accept-Encoding and Expect
// belong to the transport (identity bodies; no 100-continue stalls). See #5061.
const HOP_BY_HOP_FORWARD_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
  'expect',
  'accept-encoding',
]);

function isForbiddenForwardHeader(lowerName) {
  return DENIED_FORWARD_HEADERS.has(lowerName)
    || HOP_BY_HOP_FORWARD_HEADERS.has(lowerName)
    || lowerName.startsWith('proxy-');
}

// Building blocks of the pinned transport, exposed so
// tests/mcp-proxy-pinned-socket.test.mjs can prove on a real TLS socket that
// Node honours exactly the lookup hook / agent this module hands node:https.
export const __testing__ = {
  pinnedLookup,
  PINNED_UPSTREAM_AGENT,
  HOP_BY_HOP_FORWARD_HEADERS,
  isForbiddenForwardHeader,
  // Exposed so a test can prove the null-body drain path attaches its 'error'
  // listener: an unlistened Node stream error is an uncaught exception, and on
  // this runtime that kills the process.
  webResponseFromIncoming,
};

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
        if (safeKey && !isForbiddenForwardHeader(safeKey.trim().toLowerCase())) {
          h[safeKey] = safeVal;
        }
      }
    }
  }
  return h;
}

// --- Streamable HTTP transport (MCP 2025-03-26) ---

async function postJson(target, body, headers, sessionId) {
  const h = { ...headers };
  if (sessionId) h['Mcp-Session-Id'] = sessionId;
  return pinnedFetch(target, {
    method: 'POST',
    headers: h,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function cancelResponseBody(response) {
  await response.body?.cancel().catch(() => {});
}

async function parseJsonRpcResponse(resp) {
  const body = await readBoundedResponseBody(resp, MAX_MCP_PROXY_RESPONSE_BYTES);
  const text = new TextDecoder().decode(body);
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) {
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const parsed = parseMcpProxyJson(line.slice(6));
          if (parsed.result !== undefined || parsed.error !== undefined) return parsed;
        } catch (error) {
          if (error instanceof McpProxyJsonDepthError) throw error;
        }
      }
    }
    throw new Error('No result found in SSE response');
  }
  return parseMcpProxyJson(text);
}

async function sendInitialized(target, headers, sessionId) {
  try {
    const response = await postJson(target, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    }, headers, sessionId);
    await cancelResponseBody(response);
  } catch (error) {
    if (error instanceof McpProxySsrfError) throw error;
    /* non-fatal */
  }
}

async function mcpListTools(target, customHeaders) {
  const headers = buildHeaders(customHeaders);
  const initResp = await postJson(target, buildInitPayload(), headers, null);
  if (!initResp.ok) { await cancelResponseBody(initResp); throw new Error(`Initialize failed: HTTP ${initResp.status}`); }
  const sessionId = initResp.headers.get('Mcp-Session-Id') || initResp.headers.get('mcp-session-id');
  const initData = await parseJsonRpcResponse(initResp);
  if (initData.error) throw new Error(`Initialize error: ${initData.error.message}`);
  await sendInitialized(target, headers, sessionId);
  const listResp = await postJson(target, {
    jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
  }, headers, sessionId);
  if (!listResp.ok) { await cancelResponseBody(listResp); throw new Error(`tools/list failed: HTTP ${listResp.status}`); }
  const listData = await parseJsonRpcResponse(listResp);
  if (listData.error) throw new Error(`tools/list error: ${listData.error.message}`);
  return listData.result?.tools || [];
}

async function mcpCallTool(target, toolName, toolArgs, customHeaders) {
  const headers = buildHeaders(customHeaders);
  const initResp = await postJson(target, buildInitPayload(), headers, null);
  if (!initResp.ok) { await cancelResponseBody(initResp); throw new Error(`Initialize failed: HTTP ${initResp.status}`); }
  const sessionId = initResp.headers.get('Mcp-Session-Id') || initResp.headers.get('mcp-session-id');
  const initData = await parseJsonRpcResponse(initResp);
  if (initData.error) throw new Error(`Initialize error: ${initData.error.message}`);
  await sendInitialized(target, headers, sessionId);
  const callResp = await postJson(target, {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: toolName, arguments: toolArgs || {} },
  }, headers, sessionId);
  if (!callResp.ok) { await cancelResponseBody(callResp); throw new Error(`tools/call failed: HTTP ${callResp.status}`); }
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
  constructor(target, headers) {
    this._target = target;
    this._sseUrl = target.url.toString();
    this._originHost = target.url.host;
    this._originProtocol = target.url.protocol;
    this._headers = headers;
    this._endpointUrl = null;
    this._endpointDeferred = makeDeferred();
    this._pending = new Map(); // rpc id -> deferred
    this._reader = null;
    this._terminalError = null;
  }

  async connect() {
    const resp = await pinnedFetch(this._target, {
      headers: { ...this._headers, Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(SSE_CONNECT_TIMEOUT_MS),
    });
    if (!resp.ok) { await cancelResponseBody(resp); throw new Error(`SSE connect HTTP ${resp.status}`); }
    this._reader = resp.body.getReader();
    this._startReadLoop();
    await this._endpointDeferred.promise;
  }

  // The endpoint event is only accepted when its host and protocol match the
  // SSE origin (checked in the read loop), so the addresses vetted for the
  // origin are the addresses the endpoint POSTs pin to.
  _endpointTarget() {
    return { url: new URL(this._endpointUrl), resolvedAddresses: this._target.resolvedAddresses };
  }

  _startReadLoop() {
    const dec = new TextDecoder();
    let buf = '';
    let eventType = '';
    let bytesRead = 0;
    const reader = this._reader;

    const rejectSession = async (error) => {
      this._terminalError = error;
      this._endpointDeferred.reject(error);
      for (const [, deferred] of this._pending) deferred.reject(error);
      this._pending.clear();
      await reader.cancel().catch(() => {});
    };

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            const error = new Error(
              this._endpointUrl ? 'SSE stream closed' : 'SSE stream closed before endpoint event',
            );
            this._terminalError = error;
            this._endpointDeferred.reject(error);
            for (const [, d] of this._pending) d.reject(error);
            this._pending.clear();
            break;
          }
          bytesRead += value?.byteLength ?? 0;
          if (bytesRead > MAX_MCP_PROXY_RESPONSE_BYTES) {
            throw new ResponseBodyTooLargeError(MAX_MCP_PROXY_RESPONSE_BYTES);
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
                  const msg = parseMcpProxyJson(data);
                  if (msg.id !== undefined) {
                    const d = this._pending.get(msg.id);
                    if (d) { this._pending.delete(msg.id); d.resolve(msg); }
                  }
                } catch (error) {
                  if (error instanceof McpProxyJsonDepthError) throw error;
                }
              }
              eventType = '';
            }
          }
        }
      } catch (err) {
        await rejectSession(err);
      }
    })();
  }

  async send(id, method, params) {
    if (this._terminalError) throw this._terminalError;
    const deferred = makeDeferred();
    // The timer below can reject this before the POST has even returned (the
    // POST carries its own timeout of the same length). Keep the rejection
    // observed so a slow POST cannot turn it into an unhandled rejection —
    // fatal on the Node runtime, where it was merely logged on Edge. The
    // `await deferred.promise` below still receives it.
    deferred.promise.catch(() => {});
    this._pending.set(id, deferred);
    const timer = setTimeout(() => {
      if (this._pending.has(id)) {
        this._pending.delete(id);
        deferred.reject(new Error(`RPC ${method} timed out`));
      }
    }, SSE_RPC_TIMEOUT_MS);
    try {
      const postResp = await pinnedFetch(this._endpointTarget(), {
        method: 'POST',
        headers: { ...this._headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(SSE_RPC_TIMEOUT_MS),
      });
      await cancelResponseBody(postResp);
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
    const response = await pinnedFetch(this._endpointTarget(), {
      method: 'POST',
      headers: { ...this._headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
    if (response) await cancelResponseBody(response);
  }

  close() {
    this._reader?.cancel().catch(() => {});
  }
}

async function mcpListToolsSse(target, customHeaders) {
  const headers = buildHeaders(customHeaders);
  const session = new SseSession(target, headers);
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

async function mcpCallToolSse(target, toolName, toolArgs, customHeaders) {
  const headers = buildHeaders(customHeaders);
  const session = new SseSession(target, headers);
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
  const target = await validateServerUrl(rawServer);
  if (!target) return jsonResponse({ error: 'Invalid serverUrl' }, 400, cors);
  let customHeaders = {};
  if (rawHeaders) {
    try { customHeaders = JSON.parse(rawHeaders); } catch { /* ignore */ }
  }
  captureMeta(target.url, customHeaders, meta);
  const tools = isSseTransport(target.url)
    ? await mcpListToolsSse(target, customHeaders)
    : await mcpListTools(target, customHeaders);
  return jsonResponse({ tools }, 200, cors);
}

async function handleCallTool(req: Request, cors: Record<string, string>, meta: ProxyMeta): Promise<Response> {
  let body;
  try {
    const bodyBytes = await readBoundedRequestBody(req, MAX_JSON_RPC_BODY_BYTES);
    body = parseMcpProxyJson(new TextDecoder().decode(bodyBytes));
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      return jsonResponse({ error: err.message }, 413, cors);
    }
    if (err instanceof McpProxyJsonDepthError) {
      return jsonResponse({ error: err.message }, 400, cors);
    }
    return jsonResponse({ error: 'Invalid JSON' }, 400, cors);
  }
  const { serverUrl: rawServer, toolName, toolArgs, customHeaders } = body;
  if (!rawServer) return jsonResponse({ error: 'Missing serverUrl' }, 400, cors);
  if (!toolName) return jsonResponse({ error: 'Missing toolName' }, 400, cors);
  const target = await validateServerUrl(rawServer);
  if (!target) return jsonResponse({ error: 'Invalid serverUrl' }, 400, cors);
  captureMeta(target.url, customHeaders, meta);
  const result = isSseTransport(target.url)
    ? await mcpCallToolSse(target, toolName, toolArgs || {}, customHeaders || {})
    : await mcpCallTool(target, toolName, toolArgs || {}, customHeaders || {});
  return jsonResponse({ result }, 200, cors);
}

// Web-shaped proxy handler. Every helper it calls (isDisallowedOrigin,
// getCorsHeaders, isCallerPremium, readBoundedRequestBody, getClientIp) reads
// a fetch `Request`; the Node adapter below is the only place that shape is
// produced from the runtime's IncomingMessage. Exported for tests that want
// to drive the proxy logic with a `Request` directly.
export async function handleProxyRequest(req: Request): Promise<Response> {
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

// --- Vercel Node runtime entry point ---
//
// On the Node runtime Vercel calls a default-exported function as
// `handler(req, res)` with a raw http.IncomingMessage / http.ServerResponse
// (@vercel/node serverless-handler: `return listener(req, res)`); the Web
// `Request => Response` signature is only dispatched for named GET/POST/...
// exports. #4749 shipped the Web signature under runtime:'nodejs' and 500'd
// every call at `req.headers.get` — reverted in #4754. This adapter is the
// only place the two shapes meet: build a `Request` from the IncomingMessage,
// run the Web handler above, write the `Response` back.

function firstHeaderValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

// Bridge the request body on 'data' / 'end' / 'error' only — NOT
// Readable.toWeb(req). With Vercel's Node helpers enabled (the default),
// @vercel/node buffers the body before the handler runs and re-exposes it
// through a PassThrough that intercepts exactly `req.on('data' | 'end')`;
// Readable.toWeb() also consults stream.finished() / pause() / resume() on the
// original, already-consumed IncomingMessage and yields an EMPTY stream, so
// every POST would 400 with "Invalid JSON". The body is still streamed, never
// buffered here, so readBoundedRequestBody keeps its Content-Length early
// reject and its streaming byte cap. tests/mcp-proxy-node-entry.test.mjs pins
// this against a port of that helper shim.
function requestBodyStream(req) {
  let finished = false;
  return new ReadableStream({
    start(controller) {
      req.on('data', (chunk) => {
        if (finished) return;
        controller.enqueue(chunk); // Buffer is a Uint8Array
        // Same backpressure as incomingBodyStream. readBoundedRequestBody's cap
        // bounds what it COPIES, not what this queue holds: without the pause
        // the whole body accumulates here regardless of the cap, and the reject
        // only fires once the consumer has read past it.
        if (controller.desiredSize !== null && controller.desiredSize <= 0) req.pause();
      });
      req.on('end', () => {
        if (finished) return;
        finished = true;
        controller.close();
      });
      req.on('error', (error) => {
        if (finished) return;
        finished = true;
        controller.error(error);
      });
    },
    pull() {
      req.resume();
    },
    cancel() {
      finished = true;
      req.destroy();
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 }));
}

function toWebRequest(req: IncomingMessage): Request {
  const host = firstHeaderValue(req.headers.host) || 'localhost';
  const proto = String(firstHeaderValue(req.headers['x-forwarded-proto']) || 'https').split(',')[0].trim() || 'https';
  const url = new URL(req.url || '/', `${proto}://${host}`);
  // Copy EVERY header: getClientIp reads x-forwarded-for / cf-connecting-ip /
  // x-wm-edge-proof, isDisallowedOrigin reads origin, isCallerPremium reads
  // Authorization / X-WorldMonitor-Key, readBoundedRequestBody reads
  // content-length. Node joins repeated headers itself; the array case is
  // set-cookie, joined the same way.
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    try {
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    } catch {
      /* not representable as a fetch header — drop it */
    }
  }
  const method = (req.method || 'GET').toUpperCase();
  const init: RequestInit & { duplex?: 'half' } = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = requestBodyStream(req);
    init.duplex = 'half';
  }
  return new Request(url, init);
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  // A null-body status (the OPTIONS 204) is finished with end() and nothing
  // else — writing even an empty string to a 204 is a protocol error.
  const nullBody = response.status === 204 || response.status === 205 || response.status === 304 || response.body === null;
  if (nullBody) {
    res.writeHead(response.status, headers);
    res.end();
    return;
  }
  const body = Buffer.from(await response.arrayBuffer());
  headers['content-length'] = String(body.byteLength);
  res.writeHead(response.status, headers);
  res.end(body);
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let response: Response;
  try {
    response = await handleProxyRequest(toWebRequest(req));
  } catch (err) {
    // The one signal that a repeat of #4754 reached production: anything that
    // escapes handleProxyRequest is a runtime-contract failure, not a bad
    // request. A console line alone does not page anyone, and the whole point
    // of this route's runtime move is that its last regression 500'd silently
    // for 31 minutes.
    console.error('[mcp-proxy]', {
      event: 'mcp_proxy_unhandled',
      ts: new Date().toISOString(),
      message: err instanceof Error ? err.message : String(err),
    });
    captureSilentError(err, { tags: { route: 'mcp-proxy', event: 'mcp_proxy_unhandled' } });
    response = jsonResponse({ error: 'Internal error' }, 500, withProxyNoStore());
  }
  await writeWebResponse(res, response);
}
