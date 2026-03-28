import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

export const config = { runtime: 'edge' };

const TOKEN_TTL_SECONDS = 3600;
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResp(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extra },
  });
}

// Tight rate limiter for credential endpoint: 10 token requests per minute per IP
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

function getClientIp(req) {
  return (
    req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-real-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    '0.0.0.0'
  );
}

function validateSecret(secret) {
  if (!secret) return false;
  const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
  return validKeys.includes(secret);
}

async function storeToken(uuid, apiKey) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;

  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['SET', `oauth:token:${uuid}`, JSON.stringify(apiKey), 'EX', TOKEN_TTL_SECONDS]]),
    signal: AbortSignal.timeout(3_000),
  });
  if (!resp.ok) return false;

  const results = await resp.json().catch(() => null);
  return Array.isArray(results) && results[0]?.result === 'OK';
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return jsonResp({ error: 'method_not_allowed' }, 405);
  }

  // Rate limit by IP before any credential work
  const rl = getRatelimit();
  if (rl) {
    try {
      const ip = getClientIp(req);
      const { success, reset } = await rl.limit(ip);
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

  const params = new URLSearchParams(await req.text().catch(() => ''));
  const grantType = params.get('grant_type');
  const clientSecret = params.get('client_secret');

  if (grantType !== 'client_credentials') {
    return jsonResp({ error: 'unsupported_grant_type' }, 400);
  }

  if (!validateSecret(clientSecret)) {
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
