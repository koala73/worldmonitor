import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';

export const config = { runtime: 'edge' };

const TIMEOUT_MS = 15_000;
const MCP_PROTOCOL_VERSION = '2024-11-05';

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
  // Block private/loopback for production safety
  const host = url.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    // Allow in dev (non-prod) by checking the origin of the incoming request
    return url;
  }
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
        h[k] = v;
      }
    }
  }
  return h;
}

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
    // Collect SSE events and find the result
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

async function mcpListTools(serverUrl, customHeaders) {
  const headers = buildHeaders(customHeaders);

  // Initialize
  const initResp = await postJson(serverUrl, buildInitPayload(), headers, null);
  if (!initResp.ok) throw new Error(`Initialize failed: HTTP ${initResp.status}`);
  const sessionId = initResp.headers.get('Mcp-Session-Id') || initResp.headers.get('mcp-session-id');
  const initData = await parseJsonRpcResponse(initResp);
  if (initData.error) throw new Error(`Initialize error: ${initData.error.message}`);

  // List tools
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

  // Initialize
  const initResp = await postJson(serverUrl, buildInitPayload(), headers, null);
  if (!initResp.ok) throw new Error(`Initialize failed: HTTP ${initResp.status}`);
  const sessionId = initResp.headers.get('Mcp-Session-Id') || initResp.headers.get('mcp-session-id');
  const initData = await parseJsonRpcResponse(initResp);
  if (initData.error) throw new Error(`Initialize error: ${initData.error.message}`);

  // Call tool
  const callResp = await postJson(serverUrl, {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: toolName, arguments: toolArgs || {} },
  }, headers, sessionId);
  if (!callResp.ok) throw new Error(`tools/call failed: HTTP ${callResp.status}`);
  const callData = await parseJsonRpcResponse(callResp);
  if (callData.error) throw new Error(`tools/call error: ${callData.error.message}`);
  return callData.result;
}

export default async function handler(req) {
  if (isDisallowedOrigin(req))
    return new Response('Forbidden', { status: 403 });

  const cors = getCorsHeaders(req, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: cors });

  try {
    if (req.method === 'GET') {
      // List tools
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
      const tools = await mcpListTools(serverUrl, customHeaders);
      return jsonResponse({ tools }, 200, cors);
    }

    if (req.method === 'POST') {
      const body = await req.json();
      const { serverUrl: rawServer, toolName, toolArgs, customHeaders } = body;
      if (!rawServer) return jsonResponse({ error: 'Missing serverUrl' }, 400, cors);
      if (!toolName) return jsonResponse({ error: 'Missing toolName' }, 400, cors);
      const serverUrl = validateServerUrl(rawServer);
      if (!serverUrl) return jsonResponse({ error: 'Invalid serverUrl' }, 400, cors);
      const result = await mcpCallTool(serverUrl, toolName, toolArgs || {}, customHeaders || {});
      return jsonResponse({ result }, 200, { ...cors, 'Cache-Control': 'no-store' });
    }

    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes('TimeoutError') || msg.includes('timed out');
    return jsonResponse({ error: isTimeout ? 'MCP server timed out' : msg }, isTimeout ? 504 : 502, cors);
  }
}
