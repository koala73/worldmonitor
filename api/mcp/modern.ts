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
// A request that passes continues into the existing dispatch unchanged.
import {
  allSupportedProtocolVersionsNewestFirst,
  MCP_MODERN_PROTOCOL_VERSION,
  modernProtocolEnabled,
} from './constants';
import { rpcError } from './rpc';
import type { McpUsage } from './usage';
import { safeJsonRpcId } from './utils';

const PROTOCOL_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';

// The methods whose Mcp-Name header mirrors a body field, and that field.
const MCP_NAME_SOURCE: Readonly<Record<string, 'name' | 'uri'>> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
};

const BASE64_SENTINEL_PREFIX = '=?base64?';
const BASE64_SENTINEL_SUFFIX = '?=';

export type ModernOutcome =
  | { era: 'legacy' }
  | { era: 'modern'; response?: Response };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

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

  const source = typeof body.method === 'string' ? MCP_NAME_SOURCE[body.method] : undefined;
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
  const reject = (phase: 'malformed' | 'protocol_version', code: number, message: string, data?: unknown) => {
    usage.phase = phase;
    return { era: 'modern' as const, response: rpcError(id, code, message, corsHeaders, data, 400) };
  };

  const requested = meta[PROTOCOL_VERSION_KEY];
  if (typeof requested !== 'string') {
    return reject('malformed', -32602, `Invalid params: _meta["${PROTOCOL_VERSION_KEY}"] must be a string`);
  }
  if (requested !== MCP_MODERN_PROTOCOL_VERSION) {
    // `requested` is client input: capped like the other echoed values.
    return reject('protocol_version', -32022, 'Unsupported protocol version', {
      supported: allSupportedProtocolVersionsNewestFirst(),
      requested: requested.slice(0, 64),
    });
  }
  if (!isPlainObject(meta[CLIENT_CAPABILITIES_KEY])) {
    return reject('malformed', -32602, `Invalid params: _meta["${CLIENT_CAPABILITIES_KEY}"] must be an object`);
  }

  if (!isNotification) {
    const mismatch = headerMismatch(req, request);
    if (mismatch !== null) return reject('malformed', -32020, mismatch);
  }
  return { era: 'modern' };
}
