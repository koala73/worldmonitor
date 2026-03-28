import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
// @ts-expect-error — JS module, no declaration file
import { getClientIp } from '../_rate-limit.js';
// @ts-expect-error — JS module, no declaration file
import { getPublicCorsHeaders } from '../_cors.js';
// @ts-expect-error — JS module, no declaration file
import { jsonResponse } from '../_json-response.js';
// @ts-expect-error — JS module, no declaration file
import { keyFingerprint, sha256Hex, timingSafeIncludes, verifyPkceS256 } from '../_crypto.js';

export const config = { runtime: 'edge' };

const TOKEN_TTL_SECONDS = 3600;
const REFRESH_TTL_SECONDS = 604800;
const CLIENT_TTL_SECONDS = 90 * 24 * 3600;

const NO_STORE = { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' };

function jsonResp(body, status = 200) {
  return jsonResponse(body, status, { ...getPublicCorsHeaders('POST, OPTIONS'), ...NO_STORE });
}

// Tight rate limiter for credential endpoint
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

async function redisPipeline(commands) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const resp = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(3_000),
    });
    if (!resp.ok) return null;
    return await resp.json().catch(() => null);
  } catch { return null; }
}

// Atomic GETDEL — read and delete in one round-trip.
// Returns null on genuine key-miss; throws on transport/HTTP failure
// so callers can distinguish "expired/used" from "storage unavailable".
async function redisGetDel(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis not configured');
  const resp = await fetch(`${url}/getdel/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3_000),
  });
  if (!resp.ok) throw new Error(`Redis HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data?.result) return null; // key did not exist
  try { return JSON.parse(data.result); } catch { return null; }
}

// Returns null on genuine key-miss; throws on transport/HTTP failure.
async function redisGet(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis not configured');
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3_000),
  });
  if (!resp.ok) throw new Error(`Redis HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data?.result) return null; // key did not exist
  try { return JSON.parse(data.result); } catch { return null; }
}

// Store legacy client_credentials token (16-char fingerprint for backward compat)
async function storeLegacyToken(uuid, apiKey) {
  const fingerprint = await keyFingerprint(apiKey);
  const results = await redisPipeline([
    ['SET', `oauth:token:${uuid}`, JSON.stringify(fingerprint), 'EX', TOKEN_TTL_SECONDS],
  ]);
  return Array.isArray(results) && results[0]?.result === 'OK';
}

// Store new OAuth tokens (full SHA-256 for access token, object for refresh)
async function storeNewTokens(accessUuid, refreshUuid, apiKeyHash, clientId, scope, familyId) {
  const results = await redisPipeline([
    ['SET', `oauth:token:${accessUuid}`, JSON.stringify(apiKeyHash), 'EX', TOKEN_TTL_SECONDS],
    ['SET', `oauth:refresh:${refreshUuid}`, JSON.stringify({ client_id: clientId, api_key_hash: apiKeyHash, scope, family_id: familyId }), 'EX', REFRESH_TTL_SECONDS],
  ]);
  return Array.isArray(results) && results.every(r => r?.result === 'OK');
}

export default async function handler(req) {
  const corsHeaders = getPublicCorsHeaders('POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return jsonResp({ error: 'method_not_allowed' }, 405);
  }

  const params = new URLSearchParams(await req.text().catch(() => ''));
  const grantType = params.get('grant_type');
  const clientSecret = params.get('client_secret');
  const clientId = params.get('client_id');

  // Rate limit key selection
  const rl = getRatelimit();
  if (rl) {
    try {
      let rlKey;
      if (grantType === 'client_credentials' && clientSecret) {
        rlKey = `cred:${(await sha256Hex(clientSecret)).slice(0, 8)}`;
      } else if (clientId) {
        rlKey = `cid:${clientId}`;
      } else {
        rlKey = `ip:${getClientIp(req)}`;
      }
      const { success, reset } = await rl.limit(rlKey);
      if (!success) {
        return jsonResp(
          { error: 'rate_limit_exceeded', error_description: 'Too many token requests. Try again later.' },
          429,
        );
      }
    } catch { /* graceful degradation */ }
  }

  // -------------------------------------------------------------------------
  // authorization_code grant
  // -------------------------------------------------------------------------
  if (grantType === 'authorization_code') {
    const code = params.get('code');
    const codeVerifier = params.get('code_verifier');
    const redirectUri = params.get('redirect_uri');

    if (!code || !codeVerifier || !clientId || !redirectUri) {
      return jsonResp({ error: 'invalid_request', error_description: 'Missing required parameters: code, code_verifier, client_id, redirect_uri' }, 400);
    }

    // Validate code_verifier format before any crypto work
    if (typeof codeVerifier !== 'string' ||
        codeVerifier.length < 43 || codeVerifier.length > 128 ||
        !/^[A-Za-z0-9\-._~]+$/.test(codeVerifier)) {
      return jsonResp({ error: 'invalid_request', error_description: 'code_verifier must be 43-128 URL-safe characters [A-Za-z0-9-._~]' }, 400);
    }

    // Atomically consume the auth code (GETDEL — prevents concurrent exchange race).
    // Throws on transport failure so we return 503, not a misleading 400.
    let codeData;
    try {
      codeData = await redisGetDel(`oauth:code:${code}`);
    } catch {
      return jsonResp({ error: 'server_error', error_description: 'Auth service temporarily unavailable. Please retry.' }, 503);
    }
    if (!codeData) {
      return jsonResp({ error: 'invalid_grant', error_description: 'Authorization code is invalid, expired, or already used' }, 400);
    }

    if (codeData.client_id !== clientId) {
      return jsonResp({ error: 'invalid_grant', error_description: 'client_id mismatch' }, 400);
    }
    if (codeData.redirect_uri !== redirectUri) {
      return jsonResp({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400);
    }

    // Verify PKCE
    const pkceVerify = await verifyPkceS256(codeVerifier, codeData.code_challenge);
    if (pkceVerify === null) {
      return jsonResp({ error: 'invalid_request', error_description: 'Malformed PKCE parameters' }, 400);
    }
    if (pkceVerify === false) {
      return jsonResp({ error: 'invalid_grant', error_description: 'code_verifier does not match code_challenge' }, 400);
    }

    // Verify client still exists (throws on unavailable, null = expired → re-register signal)
    let client;
    try {
      client = await redisGet(`oauth:client:${clientId}`);
    } catch {
      return jsonResp({ error: 'server_error', error_description: 'Auth service temporarily unavailable. Please retry.' }, 503);
    }
    if (!client) {
      return jsonResp({ error: 'invalid_client', error_description: 'Client registration not found or expired. Please re-register.' }, 401);
    }

    // Extend client TTL (sliding 90-day window)
    redisPipeline([['EXPIRE', `oauth:client:${clientId}`, CLIENT_TTL_SECONDS]]).catch(() => {});

    const scope = codeData.scope ?? 'mcp';
    const accessUuid = crypto.randomUUID();
    const refreshUuid = crypto.randomUUID();
    const familyId = crypto.randomUUID();

    const stored = await storeNewTokens(accessUuid, refreshUuid, codeData.api_key_hash, clientId, scope, familyId);
    if (!stored) {
      return jsonResp({ error: 'server_error', error_description: 'Token storage failed' }, 500);
    }

    return jsonResp({
      access_token: accessUuid,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL_SECONDS,
      refresh_token: refreshUuid,
      scope,
    });
  }

  // -------------------------------------------------------------------------
  // refresh_token grant
  // -------------------------------------------------------------------------
  if (grantType === 'refresh_token') {
    const refreshToken = params.get('refresh_token');

    if (!refreshToken || !clientId) {
      return jsonResp({ error: 'invalid_request', error_description: 'Missing required parameters: refresh_token, client_id' }, 400);
    }

    // Atomically consume the refresh token (GETDEL — prevents concurrent rotation race).
    // Throws on transport failure so we return 503, not a misleading 400.
    let refreshData;
    try {
      refreshData = await redisGetDel(`oauth:refresh:${refreshToken}`);
    } catch {
      return jsonResp({ error: 'server_error', error_description: 'Auth service temporarily unavailable. Please retry.' }, 503);
    }
    if (!refreshData) {
      return jsonResp({ error: 'invalid_grant', error_description: 'Refresh token is invalid, expired, or already used' }, 400);
    }

    if (refreshData.client_id !== clientId) {
      return jsonResp({ error: 'invalid_grant', error_description: 'client_id mismatch' }, 400);
    }

    // Verify client still exists (throws on unavailable, null = expired → re-register signal)
    let client;
    try {
      client = await redisGet(`oauth:client:${clientId}`);
    } catch {
      return jsonResp({ error: 'server_error', error_description: 'Auth service temporarily unavailable. Please retry.' }, 503);
    }
    if (!client) {
      return jsonResp({ error: 'invalid_client', error_description: 'Client registration not found or expired. Please re-register.' }, 401);
    }

    // Extend client TTL (sliding 90-day window)
    redisPipeline([['EXPIRE', `oauth:client:${clientId}`, CLIENT_TTL_SECONDS]]).catch(() => {});

    const scope = refreshData.scope ?? 'mcp';
    const accessUuid = crypto.randomUUID();
    const newRefreshUuid = crypto.randomUUID();

    const stored = await storeNewTokens(accessUuid, newRefreshUuid, refreshData.api_key_hash, clientId, scope, refreshData.family_id);
    if (!stored) {
      return jsonResp({ error: 'server_error', error_description: 'Token storage failed' }, 500);
    }

    return jsonResp({
      access_token: accessUuid,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL_SECONDS,
      refresh_token: newRefreshUuid,
      scope,
    });
  }

  // -------------------------------------------------------------------------
  // client_credentials grant (legacy, undocumented — kept for backward compat)
  // -------------------------------------------------------------------------
  if (grantType === 'client_credentials') {
    if (!await validateSecret(clientSecret)) {
      return jsonResp({ error: 'invalid_client', error_description: 'Invalid client credentials' }, 401);
    }

    const uuid = crypto.randomUUID();
    const stored = await storeLegacyToken(uuid, clientSecret);
    if (!stored) {
      return jsonResp({ error: 'server_error', error_description: 'Token storage failed' }, 500);
    }

    return jsonResp({
      access_token: uuid,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL_SECONDS,
      scope: 'mcp',
    });
  }

  return jsonResp({ error: 'unsupported_grant_type' }, 400);
}
