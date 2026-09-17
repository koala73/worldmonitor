// @ts-expect-error — JS module, no declaration file
import { getPublicCorsHeaders } from '../_cors.js';
// @ts-expect-error — JS module, no declaration file
import { getClientIp } from '../_rate-limit.js';
// @ts-expect-error — JS module, no declaration file
import { jsonResponse } from '../_json-response.js';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

export const config = { runtime: 'edge' };

const CLIENT_TTL_SECONDS = 90 * 24 * 3600; // 90 days sliding
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_REDIRECT_URI_BYTES = 2 * 1024;
const MAX_METADATA_BYTES = 8 * 1024;
const encoder = new TextEncoder();

async function readRegistrationBody(req) {
  if (Number(req.headers.get('content-length')) > MAX_REQUEST_BYTES) {
    throw new RangeError('Registration body too large');
  }
  if (!req.body) return '';

  const reader = req.body.getReader();
  const bytes = new Uint8Array(MAX_REQUEST_BYTES);
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_REQUEST_BYTES - total) {
        // Cancellation must not delay rejection if the stream never settles it.
        void reader.cancel().catch(() => {});
        throw new RangeError('Registration body too large');
      }
      bytes.set(value, total);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(bytes.subarray(0, total));
}

// Allowlisted redirect URI prefixes — DCR is not open to arbitrary HTTPS URIs
const ALLOWED_REDIRECT_PREFIXES = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

// Exported so `api/internal/mcp-grant-mint.ts` (U3) can re-validate the
// registered client's redirect URIs as a defense-in-depth check before
// minting a Pro-MCP grant. Re-uses the SAME allowlist that DCR enforces
// at registration time — no parallel implementation drift.
export function isAllowedRedirectUri(uri) {
  if (ALLOWED_REDIRECT_PREFIXES.includes(uri)) return true;
  // localhost / 127.0.0.1 any port (Claude Code, MCP inspector)
  try {
    const u = new URL(uri);
    return (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.protocol === 'http:';
  } catch { return false; }
}

function jsonResp(body, status = 200) {
  return jsonResponse(body, status, getPublicCorsHeaders('POST, OPTIONS'));
}

let _rl = null;
function getRatelimit() {
  if (_rl) return _rl;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _rl = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(5, '60 s'),
    prefix: 'rl:oauth-register',
    analytics: false,
  });
  return _rl;
}

async function storeClient(clientId, serializedMetadata) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;
  try {
    const resp = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        ['SET', `oauth:client:${clientId}`, serializedMetadata, 'EX', CLIENT_TTL_SECONDS],
      ]),
      signal: AbortSignal.timeout(3_000),
    });
    if (!resp.ok) return false;
    const results = await resp.json().catch(() => null);
    return Array.isArray(results) && results[0]?.result === 'OK';
  } catch { return false; }
}

export default async function handler(req) {
  const corsHeaders = getPublicCorsHeaders('POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return jsonResp({ error: 'method_not_allowed' }, 405);
  }

  const rl = getRatelimit();
  if (rl) {
    try {
      const { success } = await rl.limit(`ip:${getClientIp(req)}`);
      if (!success) {
        return jsonResp({ error: 'rate_limit_exceeded', error_description: 'Too many registration requests.' }, 429);
      }
    } catch { /* graceful degradation */ }
  }

  let body;
  try {
    body = JSON.parse(await readRegistrationBody(req));
  } catch (error) {
    if (error instanceof RangeError) {
      return jsonResp({ error: 'invalid_request', error_description: 'Registration body exceeds 16384 bytes' }, 413);
    }
    return jsonResp({ error: 'invalid_request', error_description: 'Invalid JSON body' }, 400);
  }

  const { client_name, redirect_uris } = body ?? {};

  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    return jsonResp({ error: 'invalid_request', error_description: 'redirect_uris is required' }, 400);
  }
  if (redirect_uris.length > 3) {
    return jsonResp({ error: 'invalid_request', error_description: 'Maximum 3 redirect_uris allowed' }, 400);
  }
  for (const uri of redirect_uris) {
    if (typeof uri === 'string' && encoder.encode(uri).byteLength > MAX_REDIRECT_URI_BYTES) {
      return jsonResp({ error: 'invalid_redirect_uri', error_description: 'Redirect URI exceeds 2048 bytes' }, 400);
    }
    if (typeof uri !== 'string' || !isAllowedRedirectUri(uri)) {
      return jsonResp({
        error: 'invalid_redirect_uri',
        error_description: `Redirect URI not allowed: ${uri}. Allowed: claude.ai/claude.com callbacks and localhost.`,
      }, 400);
    }
  }

  const clientId = crypto.randomUUID();
  const metadata = {
    client_name: typeof client_name === 'string' ? client_name.slice(0, 100) : 'Unknown Client',
    redirect_uris,
    created_at: Date.now(),
  };

  const serializedMetadata = JSON.stringify(metadata);
  if (encoder.encode(serializedMetadata).byteLength > MAX_METADATA_BYTES) {
    return jsonResp({ error: 'invalid_request', error_description: 'Client metadata exceeds 8192 bytes' }, 400);
  }
  const stored = await storeClient(clientId, serializedMetadata);
  if (!stored) {
    return jsonResp({ error: 'server_error', error_description: 'Client registration storage failed' }, 500);
  }

  return jsonResp({
    client_id: clientId,
    client_name: metadata.client_name,
    redirect_uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }, 201);
}
