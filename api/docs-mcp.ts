// First-party facade for the documentation MCP server at /docs/mcp
// (vercel.json rewrite → /api/docs-mcp, ahead of the /docs/:match* Mintlify
// rewrite). The upstream Mintlify server answers protocol-level failures —
// unknown tool, invalid arguments — as tool *results* (`result.isError: true`
// with the code buried in `structuredContent`) instead of top-level JSON-RPC
// error objects, which agents (and the orank "MCP error handling" check)
// cannot distinguish from successful calls without envelope-specific parsing.
// This facade forwards everything verbatim EXCEPT:
//   1. malformed / non-JSON-RPC POST bodies get a proper -32700/-32600 error
//      locally instead of whatever the upstream framework emits;
//   2. tools/call responses carrying a protocol-level code (-32601/-32602)
//      inside an isError result are lifted into a real JSON-RPC `error`
//      object, preserving the upstream SSE/JSON framing.
// Genuine tool-execution failures deliberately stay `isError` results — the
// MCP spec reserves top-level errors for protocol-level failures only.
import { ENDPOINT_RATE_POLICIES, checkScopedRateLimit, getClientIp } from '../server/_shared/rate-limit';

export const config = { runtime: 'edge' };

const UPSTREAM_URL = 'https://worldmonitor.mintlify.dev/docs/mcp';
const UPSTREAM_TIMEOUT_MS = 30_000;
const MAX_REQUEST_BODY_BYTES = 262_144; // mirrors the MCP JMESPath output cap
const RATE_LIMIT_ERROR_CODE = -32029; // JSON-RPC code mirrored from api/mcp.ts

const RATE_LIMIT_SCOPE = '/api/docs-mcp';
const RATE_LIMIT_POLICY = ENDPOINT_RATE_POLICIES[RATE_LIMIT_SCOPE];
if (!RATE_LIMIT_POLICY) {
  // Module-load failure — better to crash the function cold-start with a loud
  // message than to silently fall back to "no rate limit" if someone
  // accidentally deletes the registry entry (same guard as api/mcp-proxy.ts).
  throw new Error(
    `[docs-mcp] missing ENDPOINT_RATE_POLICIES['${RATE_LIMIT_SCOPE}'] — see server/_shared/rate-limit.ts`,
  );
}
const RATE_LIMIT_MAX = RATE_LIMIT_POLICY.limit;
const RATE_LIMIT_WINDOW = RATE_LIMIT_POLICY.window;

// Request headers worth forwarding to the upstream MCP transport. Everything
// else (cookies, CF headers, x-forwarded-*) stays on our side.
const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'authorization',
  'content-type',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id',
  'user-agent',
];

// Hop-by-hop / recomputed response headers that must not be forwarded after
// fetch has already decoded the body.
const STRIPPED_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-Id',
};

type JsonRpcId = string | number | null;

export function buildJsonRpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Classify a POST body before forwarding. Batches and notifications forward
 * untouched — only clearly-broken envelopes are answered locally.
 */
export function classifyJsonRpcRequest(
  bodyText: string,
):
  | { kind: 'invalid-json' }
  | { kind: 'invalid-request'; id: JsonRpcId }
  | { kind: 'single'; method: string; id: JsonRpcId }
  | { kind: 'forward' } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { kind: 'invalid-json' };
  }
  if (Array.isArray(parsed)) return { kind: 'forward' };
  if (parsed === null || typeof parsed !== 'object') return { kind: 'invalid-request', id: null };
  const rpc = parsed as Record<string, unknown>;
  const id: JsonRpcId =
    typeof rpc.id === 'string' || typeof rpc.id === 'number' ? (rpc.id as string | number) : null;
  if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string' || rpc.method.length === 0) {
    return { kind: 'invalid-request', id };
  }
  return { kind: 'single', method: rpc.method, id };
}

/**
 * If a JSON-RPC response object is an isError tool result wrapping a
 * protocol-level code, return the equivalent top-level JSON-RPC error object;
 * otherwise null.
 */
export function liftProtocolErrorFromToolResult(rpc: unknown): Record<string, unknown> | null {
  if (rpc === null || typeof rpc !== 'object' || Array.isArray(rpc)) return null;
  const envelope = rpc as Record<string, unknown>;
  if (envelope.error !== undefined) return null;
  const result = envelope.result as Record<string, unknown> | undefined;
  if (!result || typeof result !== 'object' || result.isError !== true) return null;

  const structured = result.structuredContent as Record<string, unknown> | undefined;
  let code = typeof structured?.code === 'number' ? structured.code : null;
  let message = typeof structured?.message === 'string' ? structured.message : null;
  if (code === null || message === null) {
    const content = Array.isArray(result.content) ? result.content : [];
    const textBlock = content.find(
      (block): block is { type: string; text: string } =>
        typeof (block as { text?: unknown })?.text === 'string',
    );
    const match = textBlock?.text.match(/^MCP error (-\d+): ([\s\S]+)$/);
    if (match) {
      code = Number(match[1]);
      message = match[2] ?? null;
    }
  }
  // Only protocol-level failures are lifted: -32601 method/tool not found,
  // -32602 invalid params (unknown tool, bad arguments). Anything else is a
  // legitimate tool-execution failure and must remain an isError result.
  if (code !== -32601 && code !== -32602 || message === null) return null;
  const id: JsonRpcId =
    typeof envelope.id === 'string' || typeof envelope.id === 'number'
      ? (envelope.id as string | number)
      : null;
  return buildJsonRpcError(id, code, message);
}

/**
 * Normalize an upstream tools/call response body (SSE or plain JSON). Returns
 * the rewritten body when a protocol-level error was lifted, or null to pass
 * the original bytes through untouched.
 */
export function normalizeToolCallResponseBody(bodyText: string, contentType: string): string | null {
  if (contentType.includes('text/event-stream')) {
    const lines = bodyText.split('\n');
    const dataIndexes = lines
      .map((line, index) => (line.startsWith('data: ') ? index : -1))
      .filter((index) => index !== -1);
    // Only the simple single-event shape is rewritten; multi-event streams
    // (progress notifications etc.) pass through untouched.
    const dataIndex = dataIndexes.length === 1 ? dataIndexes[0] : undefined;
    const dataLine = dataIndex === undefined ? undefined : lines[dataIndex];
    if (dataIndex === undefined || dataLine === undefined) return null;
    let rpc: unknown;
    try {
      rpc = JSON.parse(dataLine.slice('data: '.length));
    } catch {
      return null;
    }
    const lifted = liftProtocolErrorFromToolResult(rpc);
    if (!lifted) return null;
    lines[dataIndex] = `data: ${JSON.stringify(lifted)}`;
    return lines.join('\n');
  }
  if (contentType.includes('application/json')) {
    let rpc: unknown;
    try {
      rpc = JSON.parse(bodyText);
    } catch {
      return null;
    }
    const lifted = liftProtocolErrorFromToolResult(rpc);
    return lifted ? JSON.stringify(lifted) : null;
  }
  return null;
}

function withCors(headers: Headers | Record<string, string>): Headers {
  const merged = new Headers(headers instanceof Headers ? headers : undefined);
  if (!(headers instanceof Headers)) {
    for (const [key, value] of Object.entries(headers)) merged.set(key, value);
  }
  for (const [key, value] of Object.entries(CORS_HEADERS)) merged.set(key, value);
  return merged;
}

function jsonRpcErrorResponse(status: number, id: JsonRpcId, code: number, message: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(buildJsonRpcError(id, code, message)), {
    status,
    headers: withCors({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders }),
  });
}

function upstreamRequestHeaders(req: Request): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function upstreamResponseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  return withCors(headers);
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: withCors({}) });
  }
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    return jsonRpcErrorResponse(405, null, -32600, `Method ${req.method} not allowed`, { Allow: 'GET, POST, DELETE, OPTIONS' });
  }

  const ip = getClientIp(req);
  // Redis-degraded scoped limits intentionally stay availability-first — the
  // upstream docs MCP is fully public and cheap, so degradation (logged by
  // checkScopedRateLimit) must not take the docs surface down.
  const scoped = await checkScopedRateLimit(RATE_LIMIT_SCOPE, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW, ip);
  if (!scoped.allowed) {
    const retryAfter = Math.max(1, Math.ceil((scoped.reset - Date.now()) / 1000));
    return jsonRpcErrorResponse(
      429,
      null,
      RATE_LIMIT_ERROR_CODE,
      `Rate limit exceeded. Max ${RATE_LIMIT_MAX} requests per ${RATE_LIMIT_WINDOW} per IP.`,
      { 'Retry-After': String(retryAfter) },
    );
  }

  if (req.method !== 'POST') {
    // GET opens the SSE listening stream, DELETE terminates a session — both
    // stream through untouched.
    const upstream = await fetch(UPSTREAM_URL, {
      method: req.method,
      headers: upstreamRequestHeaders(req),
    });
    return new Response(upstream.body, { status: upstream.status, headers: upstreamResponseHeaders(upstream) });
  }

  const bodyText = await req.text();
  if (bodyText.length > MAX_REQUEST_BODY_BYTES) {
    return jsonRpcErrorResponse(413, null, -32600, `Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`);
  }
  const classified = classifyJsonRpcRequest(bodyText);
  if (classified.kind === 'invalid-json') {
    return jsonRpcErrorResponse(400, null, -32700, 'Parse error: request body is not valid JSON');
  }
  if (classified.kind === 'invalid-request') {
    return jsonRpcErrorResponse(400, classified.id, -32600, 'Invalid Request: expected a JSON-RPC 2.0 object with a string `method`');
  }

  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM_URL, {
      method: 'POST',
      headers: upstreamRequestHeaders(req),
      body: bodyText,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return jsonRpcErrorResponse(502, classified.kind === 'single' ? classified.id : null, -32603, 'Upstream docs MCP server is unreachable');
  }

  const shouldNormalize =
    upstream.ok && classified.kind === 'single' && classified.method === 'tools/call';
  if (!shouldNormalize) {
    return new Response(upstream.body, { status: upstream.status, headers: upstreamResponseHeaders(upstream) });
  }

  const contentType = upstream.headers.get('content-type') ?? '';
  const upstreamBody = await upstream.text();
  const normalized = normalizeToolCallResponseBody(upstreamBody, contentType);
  return new Response(normalized ?? upstreamBody, {
    status: upstream.status,
    headers: upstreamResponseHeaders(upstream),
  });
}
