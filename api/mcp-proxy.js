import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';

export const config = { runtime: 'edge' };

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
    const self = this;

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // Stream closed — if endpoint never arrived, reject so connect() throws
            if (!self._endpointUrl) {
              self._endpointDeferred.reject(new Error('SSE stream closed before endpoint event'));
            }
            for (const [, d] of self._pending) d.reject(new Error('SSE stream closed'));
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
                  resolved = new URL(data.startsWith('http') ? data : data, self._sseUrl);
                } catch {
                  self._endpointDeferred.reject(new Error('SSE endpoint event contains invalid URL'));
                  return;
                }
                if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') {
                  self._endpointDeferred.reject(new Error('SSE endpoint protocol not allowed'));
                  return;
                }
                if (BLOCKED_HOST_PATTERNS.some(p => p.test(resolved.hostname))) {
                  self._endpointDeferred.reject(new Error('SSE endpoint host is blocked'));
                  return;
                }
                self._endpointUrl = resolved.toString();
                self._endpointDeferred.resolve();
              } else {
                try {
                  const msg = JSON.parse(data);
                  if (msg.id !== undefined) {
                    const d = self._pending.get(msg.id);
                    if (d) { self._pending.delete(msg.id); d.resolve(msg); }
                  }
                } catch { /* skip non-JSON data lines */ }
              }
              eventType = '';
            }
          }
        }
      } catch (err) {
        self._endpointDeferred.reject(err);
        for (const [, d] of self._pending) d.reject(new Error('SSE stream closed'));
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

export default async function handler(req) {
  if (isDisallowedOrigin(req))
    return new Response('Forbidden', { status: 403 });

  const cors = getCorsHeaders(req, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: cors });

  try {
    if (req.method === 'GET') {
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
      const tools = isSseTransport(serverUrl)
        ? await mcpListToolsSse(serverUrl, customHeaders)
        : await mcpListTools(serverUrl, customHeaders);
      return jsonResponse({ tools }, 200, cors);
    }

    if (req.method === 'POST') {
      const body = await req.json();
      const { serverUrl: rawServer, toolName, toolArgs, customHeaders } = body;
      if (!rawServer) return jsonResponse({ error: 'Missing serverUrl' }, 400, cors);
      if (!toolName) return jsonResponse({ error: 'Missing toolName' }, 400, cors);
      const serverUrl = validateServerUrl(rawServer);
      if (!serverUrl) return jsonResponse({ error: 'Invalid serverUrl' }, 400, cors);
      const result = isSseTransport(serverUrl)
        ? await mcpCallToolSse(serverUrl, toolName, toolArgs || {}, customHeaders || {})
        : await mcpCallTool(serverUrl, toolName, toolArgs || {}, customHeaders || {});
      return jsonResponse({ result }, 200, { ...cors, 'Cache-Control': 'no-store' });
    }

    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes('TimeoutError') || msg.includes('timed out');
    // Return 422 (not 502) so Cloudflare proxy does not replace our JSON body with its own HTML error page
    return jsonResponse({ error: isTimeout ? 'MCP server timed out' : msg }, isTimeout ? 504 : 422, cors);
  }
}
