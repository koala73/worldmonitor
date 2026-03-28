import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
// @ts-expect-error — JS module, no declaration file
import { getClientIp } from '../_rate-limit.js';
// @ts-expect-error — JS module, no declaration file
import { getPublicCorsHeaders } from '../_cors.js';
// @ts-expect-error — JS module, no declaration file
import { jsonResponse } from '../_json-response.js';
// @ts-expect-error — JS module, no declaration file
import { keyFingerprint, sha256Hex, timingSafeIncludes } from '../_crypto.js';

export const config = { runtime: 'edge' };

const TOKEN_TTL_SECONDS = 3600;

function jsonResp(body, status = 200, extra = {}) {
  return jsonResponse(body, status, { ...getPublicCorsHeaders('POST, OPTIONS'), ...extra });
}

// Tight rate limiter for credential endpoint: 10 token requests per minute per credential
let _rl = null;
function getRatelimit() {
  if (_rl) return _rl;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _rl = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(10, '60 s'),
    prefix: 'rl:oauth-token',
    analytics: false,
  });
  return _rl;
}

async function validateSecret(secret) {
  if (!secret) return false;
  const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
  return timingSafeIncludes(secret, validKeys);
}

async function storeToken(uuid, apiKey) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;

  try {
    const fingerprint = await keyFingerprint(apiKey);
    const resp = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', `oauth:token:${uuid}`, JSON.stringify(fingerprint), 'EX', TOKEN_TTL_SECONDS]]),
      signal: AbortSignal.timeout(3_000),
    });
    if (!resp.ok) return false;
    const results = await resp.json().catch(() => null);
    return Array.isArray(results) && results[0]?.result === 'OK';
  } catch {
    return false;
  }
}

export default async function handler(req) {
  const corsHeaders = getPublicCorsHeaders('POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return jsonResp({ error: 'method_not_allowed' }, 405);
  }

  // Parse body first so we can key the rate limit on the credential fingerprint
  // rather than IP — Claude's shared outbound IPs would otherwise cause cross-user 429s
  const params = new URLSearchParams(await req.text().catch(() => ''));
  const grantType = params.get('grant_type');
  const clientSecret = params.get('client_secret');

  const rl = getRatelimit();
  if (rl) {
    try {
      // Key by sha256(clientSecret).slice(0,8) when a secret is present so each
      // credential gets its own 10/min bucket regardless of shared outbound IP.
      // Fall back to IP for requests without a secret (will fail validation anyway).
      const rlKey = clientSecret
        ? `cred:${(await sha256Hex(clientSecret)).slice(0, 8)}`
        : `ip:${getClientIp(req)}`;
      const { success, reset } = await rl.limit(rlKey);
      if (!success) {
        return jsonResp(
          { error: 'rate_limit_exceeded', error_description: 'Too many token requests. Try again later.' },
          429,
          { 'Retry-After': String(Math.ceil((reset - Date.now()) / 1000)) }
        );
      }
    } catch {
      // Upstash unavailable — allow through (graceful degradation)
    }
  }

  if (grantType !== 'client_credentials') {
    return jsonResp({ error: 'unsupported_grant_type' }, 400);
  }

  if (!await validateSecret(clientSecret)) {
    return jsonResp({ error: 'invalid_client', error_description: 'Invalid client credentials' }, 401);
  }

  const uuid = crypto.randomUUID();
  const stored = await storeToken(uuid, clientSecret);
  if (!stored) {
    return jsonResp({ error: 'server_error', error_description: 'Token storage failed' }, 500);
  }

  return jsonResp({
    access_token: uuid,
    token_type: 'Bearer',
    expires_in: TOKEN_TTL_SECONDS,
    scope: 'mcp',
  }, 200, { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' });
}
