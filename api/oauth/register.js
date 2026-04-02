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

// Allowlisted redirect URI prefixes — DCR is not open to arbitrary HTTPS URIs
const ALLOWED_REDIRECT_PREFIXES = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

function isAllowedRedirectUri(uri) {
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

async function storeClient(clientId, metadata) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;
  try {
    const resp = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        ['SET', `oauth:client:${clientId}`, JSON.stringify(metadata), 'EX', CLIENT_TTL_SECONDS],
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
    body = await req.json();
  } catch {
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

  const stored = await storeClient(clientId, metadata);
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
