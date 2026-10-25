// MCP 2026-07-28 — the handshake-free "modern" era, served per request.
//
// A request is modern only when params._meta carries the
// `io.modelcontextprotocol/protocolVersion` claim, the rule the TS SDK's
// dual-era handler applies (`isLegacyRequest`). Headers alone never select an
// era: a modern header without the envelope stays on the legacy path, which
// answers it with the legacy 400 dual-era clients fall back on.
//
// While `MCP_PROTOCOL_2026_07_28=on`, an enveloped body is validated here
// right after it parses, ahead of the #9563 MCP-Protocol-Version pre-check, so
// the modern errors are reachable whatever the header says:
//   - protocolVersion not a string, or clientCapabilities not an object
//     → 400 -32602 (spec: basic/index, per-request protocol fields)
//   - protocolVersion other than 2026-07-28
//     → 400 -32022, data.supported = every served version newest first
//   - MCP-Protocol-Version / Mcp-Method missing or unequal to the body, or
//     Mcp-Name missing or unequal on tools/call, resources/read, prompts/get
//     → 400 -32020 HeaderMismatch (spec: transports/streamable-http)
// Notification POSTs skip the header rules: the spec defines none for them.
// A request that passes continues into the existing dispatch, where
// `modernMethodNotFound` answers removed and unknown methods with 404 -32601
// before authentication (spec: transports/streamable-http, Protocol Version
// Header).
//
// On the way out, `shapeModernResponse` applies the modern result and error
// contract once, to every response a modern request gets, early-return
// denials included:
//   - every result carries resultType "complete" and
//     _meta["io.modelcontextprotocol/serverInfo"] (spec: basic/index)
//   - list/read/discover results carry ttlMs + cacheScope (spec:
//     server/utilities/caching)
//   - -32029 → -31029 and -32002 → -31002, whatever the reason: the spec
//     reserves -32020..-32099 and bans -32002. Status, headers, message and
//     error.data are unchanged.
// A modern tools/call whose Accept allows SSE is then framed by the
// session-free encoder `modernSseResponse`.
import {
  allSupportedProtocolVersionsNewestFirst,
  MCP_MODERN_PROTOCOL_VERSION,
  modernProtocolEnabled,
  SERVER_NAME,
  SERVER_VERSION,
} from './constants';
import { rpcError } from './rpc';
import type { McpUsage } from './usage';
import { clientAcceptsSse, isPlainObject, safeJsonRpcId } from './utils';

const PROTOCOL_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';

// The methods whose Mcp-Name header mirrors a body field, and that field.
const MCP_NAME_SOURCE: Readonly<Record<string, 'name' | 'uri'>> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
};

// The methods a modern request may name: every method the handler serves,
// minus the ones 2026-07-28 removed (`initialize`, `notifications/initialized`,
// `ping`, `logging/setLevel`), plus the modern-only `server/discover` and
// `subscriptions/listen`. `skills/*` is our served extension, not a removal.
export const MODERN_ONLY_METHODS: ReadonlySet<string> = new Set([
  'server/discover',
  'subscriptions/listen',
]);
const MODERN_METHODS: ReadonlySet<string> = new Set([
  ...MODERN_ONLY_METHODS,
  'tools/list',
  'tools/call',
  'prompts/list',
  'prompts/get',
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'skills/list',
  'skills/get',
]);

const BASE64_SENTINEL_PREFIX = '=?base64?';
const BASE64_SENTINEL_SUFFIX = '?=';

export type ModernOutcome =
  | { era: 'legacy' }
  | { era: 'modern'; response?: Response };

function requestMeta(body: unknown): Record<string, unknown> | null {
  if (!isPlainObject(body) || !isPlainObject(body.params)) return null;
  const meta = body.params._meta;
  return isPlainObject(meta) ? meta : null;
}

/** True when the body carries the modern-era protocolVersion envelope claim. */
export function isModernEnvelope(body: unknown): boolean {
  const meta = requestMeta(body);
  return meta !== null && Object.prototype.hasOwnProperty.call(meta, PROTOCOL_VERSION_KEY);
}

// Decode the `=?base64?…?=` sentinel (UTF-8 inside). A plain value is returned
// as is; a sentinel that is not valid Base64 or UTF-8 decodes to null, which
// can never equal a body value.
function decodeHeaderValue(value: string): string | null {
  if (!value.startsWith(BASE64_SENTINEL_PREFIX) || !value.endsWith(BASE64_SENTINEL_SUFFIX)
    || value.length < BASE64_SENTINEL_PREFIX.length + BASE64_SENTINEL_SUFFIX.length) {
    return value;
  }
  const encoded = value.slice(BASE64_SENTINEL_PREFIX.length, -BASE64_SENTINEL_SUFFIX.length);
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// The header rules for a modern request. Returns the failure message, or null.
// Messages name the header but never echo client-supplied values.
function headerMismatch(req: Request, body: Record<string, unknown>): string | null {
  const version = req.headers.get('MCP-Protocol-Version');
  if (version === null) return 'Header mismatch: MCP-Protocol-Version header is required';
  if (version !== MCP_MODERN_PROTOCOL_VERSION) {
    return 'Header mismatch: MCP-Protocol-Version header does not match the body protocol version';
  }
  const method = req.headers.get('Mcp-Method');
  if (method === null) return 'Header mismatch: Mcp-Method header is required';
  if (method !== body.method) return 'Header mismatch: Mcp-Method header does not match the body method';

  // Own keys only: an Object.prototype name such as `constructor` is not one.
  const source = typeof body.method === 'string' && Object.prototype.hasOwnProperty.call(MCP_NAME_SOURCE, body.method)
    ? MCP_NAME_SOURCE[body.method]
    : undefined;
  if (source === undefined) return null;
  const name = req.headers.get('Mcp-Name');
  if (name === null) return `Header mismatch: Mcp-Name header is required for ${body.method}`;
  const expected = (body.params as Record<string, unknown>)[source];
  if (typeof expected !== 'string' || decodeHeaderValue(name) !== expected) {
    return `Header mismatch: Mcp-Name header does not match params.${source}`;
  }
  return null;
}

/**
 * Classify a parsed body's era and validate a modern request. `legacy` means
 * the caller continues exactly as before this module existed (flag off, or no
 * envelope). `modern` with a `response` is a rejection to return as is;
 * `modern` without one continues into the existing dispatch.
 */
export function validateModernRequest(
  req: Request,
  body: unknown,
  usage: McpUsage,
  corsHeaders: Record<string, string>,
): ModernOutcome {
  if (!modernProtocolEnabled() || !isModernEnvelope(body)) return { era: 'legacy' };
  usage.era = 'modern';

  const request = body as Record<string, unknown>;
  const meta = requestMeta(body)!;
  const isNotification = request.id === undefined;
  const id = isNotification ? null : safeJsonRpcId(request.id);
  const reject = (phase: 'invalid_meta' | 'protocol_version' | 'header_mismatch', code: number, message: string, data?: unknown) => {
    usage.phase = phase;
    return { era: 'modern' as const, response: rpcError(id, code, message, corsHeaders, data, 400) };
  };

  const requested = meta[PROTOCOL_VERSION_KEY];
  if (typeof requested !== 'string') {
    return reject('invalid_meta', -32602, `Invalid params: _meta["${PROTOCOL_VERSION_KEY}"] must be a string`);
  }
  if (requested !== MCP_MODERN_PROTOCOL_VERSION) {
    // `requested` is client input: capped like the other echoed values.
    return reject('protocol_version', -32022, 'Unsupported protocol version', {
      supported: allSupportedProtocolVersionsNewestFirst(),
      requested: requested.slice(0, 64),
    });
  }
  if (!isPlainObject(meta[CLIENT_CAPABILITIES_KEY])) {
    return reject('invalid_meta', -32602, `Invalid params: _meta["${CLIENT_CAPABILITIES_KEY}"] must be an object`);
  }

  if (!isNotification) {
    const mismatch = headerMismatch(req, request);
    if (mismatch !== null) return reject('header_mismatch', -32020, mismatch);
  }
  return { era: 'modern' };
}

/**
 * The 404 -32601 a modern request gets for a removed or unknown method, or null
 * for a method the modern era serves. Decided ahead of the auth gate, so an
 * anonymous caller learns "not found" rather than "sign in". Client
 * notifications (`notifications/cancelled`, `notifications/progress`) fall
 * through to the 202 like legacy ones; only the removed
 * `notifications/initialized` gets this body, with a null id. The echoed name
 * is capped like the legacy default case's.
 */
export function modernMethodNotFound(
  method: string,
  id: unknown,
  corsHeaders: Record<string, string>,
): Response | null {
  if (MODERN_METHODS.has(method)) return null;
  if (id === undefined && method !== 'notifications/initialized') return null;
  return rpcError(id, -32601, `Method not found: ${method.slice(0, 100)}`, corsHeaders, undefined, 404);
}

const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';
const SUBSCRIPTION_ID_META_KEY = 'io.modelcontextprotocol/subscriptionId';
const ONE_HOUR_MS = 3_600_000;

function serverInfoMeta(): Record<string, unknown> {
  return { [SERVER_INFO_META_KEY]: { name: SERVER_NAME, version: SERVER_VERSION } };
}

// The modern form of each legacy-range denial code.
const MODERN_ERROR_CODES: ReadonlyMap<number, number> = new Map([
  [-32029, -31029],
  [-32002, -31002],
]);

type CacheHint = { ttlMs: number; cacheScope: 'public' | 'private' };

// tools/list, prompts/list and resources/templates/list are identical
// for every caller. resources/list adds account resources for user-bound
// callers, and a shared cache cannot key on the caller, so it is private for
// everyone. server/discover is private on /mcp, so a shared cache cannot let
// an anonymous caller skip the sign-in challenge, and public on the anonymous
// aliases. Every other method carries no hint.
function cacheHint(method: string | null, onAlias: boolean): CacheHint | null {
  switch (method) {
    case 'tools/list':
    case 'prompts/list':
    case 'resources/templates/list':
      return { ttlMs: ONE_HOUR_MS, cacheScope: 'public' };
    case 'resources/list':
    case 'resources/read':
      return { ttlMs: 0, cacheScope: 'private' };
    case 'server/discover':
      return { ttlMs: ONE_HOUR_MS, cacheScope: onAlias ? 'public' : 'private' };
    default:
      return null;
  }
}

/** What the shaping step needs to know about the modern request it answers. */
export interface ModernShapeOptions {
  /** The JSON-RPC method, or null when the request failed before it was read. */
  method: string | null;
  /** True on the anonymous machine-discovery aliases (/.well-known/mcp*). */
  onAlias: boolean;
  /** True when the request's Accept allows text/event-stream. */
  acceptsSse: boolean;
}

function shapeMessage(message: Record<string, unknown>, options: ModernShapeOptions): Record<string, unknown> {
  if (isPlainObject(message.error) && typeof message.error.code === 'number') {
    const code = MODERN_ERROR_CODES.get(message.error.code);
    return code === undefined ? message : { ...message, error: { ...message.error, code } };
  }
  if (!isPlainObject(message.result)) return message;
  const { result } = message;
  return {
    ...message,
    result: {
      ...result,
      resultType: 'complete',
      ...cacheHint(options.method, options.onAlias),
      _meta: {
        ...(isPlainObject(result._meta) ? result._meta : {}),
        ...serverInfoMeta(),
      },
    },
  };
}

/**
 * Apply the modern result and error contract to a response for a modern
 * request. Bodiless responses (202, the notification 429) and non-JSON bodies
 * pass through untouched. A JSON body is re-serialized with a recomputed
 * Content-Length (jsonResponse stamped the original byte count, which would
 * truncate the larger body on the wire); every other header is kept.
 */
export async function shapeModernResponse(response: Response, options: ModernShapeOptions): Promise<Response> {
  if (response.body === null) return response;
  if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) return response;

  const text = await response.text();
  const init = { status: response.status, statusText: response.statusText, headers: new Headers(response.headers) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Response(text, init);
  }
  if (!isPlainObject(parsed)) return new Response(text, init);

  const shaped = shapeMessage(parsed, options);
  if (options.method === 'tools/call' && options.acceptsSse && response.status === 200) {
    return modernSseResponse([shaped], init.headers);
  }
  if (shaped === parsed) return new Response(text, init);
  const bytes = new TextEncoder().encode(JSON.stringify(shaped));
  // Only a response that advertised a length gets the recomputed one, so the
  // header set stays exactly the source's.
  if (init.headers.has('Content-Length')) init.headers.set('Content-Length', String(bytes.byteLength));
  return new Response(bytes, init);
}

// subscriptions/listen. /mcp emits no change notifications and advertises
// no listChanged, so it honors none of the requested types: it acknowledges an
// empty filter, sends the graceful completion result and closes the stream at
// once. The stream is already shaped here: shapeModernResponse passes SSE
// bodies through untouched.
export function modernListenResponse(
  req: Request,
  id: string | number,
  params: unknown,
  corsHeaders: Record<string, string>,
): Response {
  if (!clientAcceptsSse(req)) {
    return rpcError(id, -32600, 'subscriptions/listen requires Accept: text/event-stream', corsHeaders, undefined, 406);
  }
  const notifications = isPlainObject(params) ? params.notifications : undefined;
  if (notifications !== undefined && !isPlainObject(notifications)) {
    return rpcError(id, -32602, 'Invalid params: notifications must be an object', corsHeaders, undefined, 400);
  }
  const acknowledged = {
    jsonrpc: '2.0',
    method: 'notifications/subscriptions/acknowledged',
    params: { _meta: { [SUBSCRIPTION_ID_META_KEY]: id }, notifications: {} },
  };
  const completed = {
    jsonrpc: '2.0',
    id,
    result: {
      resultType: 'complete',
      _meta: { [SUBSCRIPTION_ID_META_KEY]: id, ...serverInfoMeta() },
    },
  };
  return modernSseResponse([acknowledged, completed], corsHeaders);
}

/**
 * A session-free SSE response: each message is one `data:` event, in order,
 * and the stream closes after the last, which is the final JSON-RPC response.
 * No `id:` lines (2026-07-28 streams are not resumable), no Mcp-Session-Id,
 * nothing stored for replay. `headers` supplies the CORS and rate-limit
 * headers to keep; the framing headers are set here.
 */
export function modernSseResponse(messages: readonly unknown[], headers: HeadersInit): Response {
  const out = new Headers(headers);
  out.set('Content-Type', 'text/event-stream; charset=utf-8');
  // no-transform keeps proxies from compressing or buffering the framing.
  out.set('Cache-Control', 'no-store, no-transform');
  out.set('X-Accel-Buffering', 'no');
  // The SSE framing is longer than any JSON byte count the source carried.
  out.delete('Content-Length');
  out.delete('Transfer-Encoding');
  out.delete('Mcp-Session-Id');
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // JSON.stringify never emits a raw newline, so each message is one line.
      for (const message of messages) controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: out });
}
