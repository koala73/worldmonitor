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

// Per-credential: 10 req/min — limits replays of a specific credential
// Per-IP: 30 req/min — catches brute-force with rotating guesses from one source
// Both run in parallel; either can trigger a 429.
let _rlCred = null;
let _rlIp = null;
function getRatelimitCred() {
  if (_rlCred) return _rlCred;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _rlCred = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(10, '60 s'),
    prefix: 'rl:oauth-token-cred',
    analytics: false,
  });
  return _rlCred;
}
function getRatelimitIp() {
  if (_rlIp) return _rlIp;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _rlIp = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(30, '60 s'),
    prefix: 'rl:oauth-token-ip',
    analytics: false,
  });
  return _rlIp;
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

  const rlCred = getRatelimitCred();
  const rlIp = getRatelimitIp();
  if (rlCred || rlIp) {
    try {
      // Dual-bucket strategy:
      // - Per-credential (10/min): each distinct secret gets its own bucket.
      //   Stops replaying a known credential at high rate.
      // - Per-IP (30/min): all attempts from one IP share a single bucket.
      //   Catches brute-force with rotating guesses (each guess is a different
      //   credential hash, so per-cred alone wouldn't accumulate).
      // 30/min per-IP is loose enough that multiple legit Claude users sharing
      // an egress IP (~1 token/hr each) won't collide in normal use.
      const clientIp = getClientIp(req);
      const credKey = clientSecret
        ? `cred:${(await sha256Hex(clientSecret)).slice(0, 8)}`
        : `ip:${clientIp}`;
      const ipKey = `ip:${clientIp}`;

      const [credResult, ipResult] = await Promise.all([
        rlCred ? rlCred.limit(credKey) : Promise.resolve({ success: true, reset: 0 }),
        rlIp ? rlIp.limit(ipKey) : Promise.resolve({ success: true, reset: 0 }),
      ]);

      if (!credResult.success || !ipResult.success) {
        const reset = Math.max(credResult.reset ?? 0, ipResult.reset ?? 0);
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
