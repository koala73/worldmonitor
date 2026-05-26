/**
 * POST /oauth/token
 *
 * U6 of plan 2026-05-10-001 (`feat-pro-mcp-clerk-auth-quota-plan`):
 *
 *   - `authorization_code` and `refresh_token` grants now branch on the
 *     consumed Redis record's `kind` discriminator. Two shapes coexist
 *     forever in `oauth:token:<uuid>` and `oauth:refresh:<uuid>`; the
 *     resolver in `api/_oauth-token.js::resolveBearerToContext` mirrors
 *     this branching at read time.
 *
 *       Legacy (env-key path, written by `storeNewTokens`):
 *         oauth:token:<uuid>   = JSON.stringify("<sha256-hex-64>")
 *         oauth:refresh:<uuid> = JSON.stringify({client_id, api_key_hash, scope, family_id})
 *
 *       Pro (Clerk-grant path, written by `storeProTokens`):
 *         oauth:token:<uuid>   = JSON.stringify({kind:'pro', userId, mcpTokenId})
 *         oauth:refresh:<uuid> = JSON.stringify({kind:'pro', client_id, userId, mcpTokenId, scope, family_id})
 *
 *   - Pro refresh-grant additionally calls `validateProMcpToken(mcpTokenId)`
 *     against Convex (no positive cache; revoke must be authoritative on
 *     the next request — see U2). Null result → `invalid_grant` 400 (do
 *     NOT leak that the row was specifically revoked).
 *
 *   - Legacy `client_credentials` grant is intentionally untouched (see
 *     `storeLegacyToken`).
 *
 * Inner handler is exported as `tokenHandler(req, deps)` for unit tests
 * (mirrors `authorize-pro.ts`'s pattern). The default export wires the
 * production deps (Redis HTTP + Convex `validateProMcpToken`).
 */

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
import { validateProMcpToken } from '../../server/_shared/pro-mcp-token';
import type { ProMcpValidateUnion } from '../../server/_shared/pro-mcp-token';

export const config = { runtime: 'edge' };

const TOKEN_TTL_SECONDS = 3600;
const REFRESH_TTL_SECONDS = 604800;
const CLIENT_TTL_SECONDS = 90 * 24 * 3600;

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

function jsonResp(body: unknown, status = 200): Response {
  return jsonResponse(body, status, { ...getPublicCorsHeaders('POST, OPTIONS'), ...NO_STORE });
}

// Tight rate limiter for credential endpoint
let _rl: Ratelimit | null = null;
function getRatelimit(): Ratelimit | null {
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

async function validateSecret(secret: string | null | undefined): Promise<boolean> {
  if (!secret) return false;
  const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
  return timingSafeIncludes(secret, validKeys);
}

// ---------------------------------------------------------------------------
// Production Redis helpers (raw `oauth:*` keys, no env-prefix). Mirror the
// shape used by `api/oauth/authorize.js` so both sides agree on key bytes.
// ---------------------------------------------------------------------------

type PipelineCommand = (string | number | unknown)[];
interface PipelineResult { result?: string; error?: string }

async function rawRedisPipeline(commands: PipelineCommand[]): Promise<PipelineResult[] | null> {
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
    return (await resp.json().catch(() => null)) as PipelineResult[] | null;
  } catch {
    return null;
  }
}

/**
 * Atomic GETDEL — read and delete in one round-trip. Returns null on genuine
 * key-miss; throws on transport/HTTP failure so callers can distinguish
 * "expired/used" from "storage unavailable".
 */
async function rawRedisGetDel(key: string): Promise<unknown | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis not configured');
  const resp = await fetch(`${url}/getdel/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3_000),
  });
  if (!resp.ok) throw new Error(`Redis HTTP ${resp.status}`);
  const data = (await resp.json()) as { result?: string | null };
  if (!data?.result) return null;
  try {
    return JSON.parse(data.result);
  } catch {
    return null;
  }
}

/** Returns null on genuine key-miss; throws on transport/HTTP failure. */
async function rawRedisGet(key: string): Promise<unknown | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis not configured');
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3_000),
  });
  if (!resp.ok) throw new Error(`Redis HTTP ${resp.status}`);
  const data = (await resp.json()) as { result?: string | null };
  if (!data?.result) return null;
  try {
    return JSON.parse(data.result);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token-record writers — split by shape so the pipeline values are obvious
// at the call site and tests can assert one writer was used (not the other).
// ---------------------------------------------------------------------------

/**
 * Legacy `client_credentials` writer — 16-char fingerprint, NOT the full
 * SHA-256. Backward compat with `oauth:token:<uuid>` records that pre-date
 * the authorization-code flow. Untouched by U6.
 */
async function storeLegacyToken(
  pipeline: (commands: PipelineCommand[]) => Promise<PipelineResult[] | null>,
  uuid: string,
  apiKey: string,
): Promise<boolean> {
  const fingerprint = await keyFingerprint(apiKey);
  const results = await pipeline([
    ['SET', `oauth:token:${uuid}`, JSON.stringify(fingerprint), 'EX', TOKEN_TTL_SECONDS],
  ]);
  return Array.isArray(results) && results[0]?.result === 'OK';
}

/**
 * Legacy `authorization_code` / `refresh_token` writer.
 *
 * Pipeline values (UNCHANGED — backward compat is load-bearing for any
 * already-issued bearers and refresh tokens still in flight):
 *   oauth:token:<uuid>   = JSON.stringify("<sha256-hex-64>")
 *   oauth:refresh:<uuid> = JSON.stringify({client_id, api_key_hash, scope, family_id})
 */
async function storeNewTokens(
  pipeline: (commands: PipelineCommand[]) => Promise<PipelineResult[] | null>,
  accessUuid: string,
  refreshUuid: string,
  apiKeyHash: string,
  clientId: string,
  scope: string,
  familyId: string,
): Promise<boolean> {
  const results = await pipeline([
    ['SET', `oauth:token:${accessUuid}`, JSON.stringify(apiKeyHash), 'EX', TOKEN_TTL_SECONDS],
    [
      'SET',
      `oauth:refresh:${refreshUuid}`,
      JSON.stringify({ client_id: clientId, api_key_hash: apiKeyHash, scope, family_id: familyId }),
      'EX',
      REFRESH_TTL_SECONDS,
    ],
  ]);
  return Array.isArray(results) && results.every((r) => r?.result === 'OK');
}

/**
 * NEW Pro writer — for tokens issued via the Clerk-grant `/oauth/authorize-pro`
 * flow. Produces the discriminated `kind:'pro'` shape consumed by
 * `resolveBearerToContext` (see `api/_oauth-token.js`).
 *
 * Pipeline values:
 *   oauth:token:<uuid>   = JSON.stringify({kind:'pro', userId, mcpTokenId})
 *   oauth:refresh:<uuid> = JSON.stringify({kind:'pro', client_id, userId, mcpTokenId, scope, family_id})
 *
 * `family_id` is preserved across refresh rotation (same semantic as the
 * legacy writer — protects against refresh-token theft via family-revoke).
 */
async function storeProTokens(
  pipeline: (commands: PipelineCommand[]) => Promise<PipelineResult[] | null>,
  accessUuid: string,
  refreshUuid: string,
  userId: string,
  mcpTokenId: string,
  clientId: string,
  scope: string,
  familyId: string,
): Promise<boolean> {
  const results = await pipeline([
    [
      'SET',
      `oauth:token:${accessUuid}`,
      JSON.stringify({ kind: 'pro', userId, mcpTokenId }),
      'EX',
      TOKEN_TTL_SECONDS,
    ],
    [
      'SET',
      `oauth:refresh:${refreshUuid}`,
      JSON.stringify({ kind: 'pro', client_id: clientId, userId, mcpTokenId, scope, family_id: familyId }),
      'EX',
      REFRESH_TTL_SECONDS,
    ],
  ]);
  return Array.isArray(results) && results.every((r) => r?.result === 'OK');
}

// ---------------------------------------------------------------------------
// Inner handler — exported for unit tests with injected deps.
// ---------------------------------------------------------------------------

export interface TokenHandlerDeps {
  /** Atomic GETDEL on `oauth:code:<code>` / `oauth:refresh:<token>`. Throws on transport failure. */
  redisGetDel: (key: string) => Promise<unknown | null>;
  /** Non-consuming read of `oauth:client:<id>`. Throws on transport failure. */
  redisGet: (key: string) => Promise<unknown | null>;
  /** Pipeline writer used by the three storeXxx writers + the sliding TTL EXPIRE. */
  redisPipeline: (commands: PipelineCommand[]) => Promise<PipelineResult[] | null>;
  /**
   * Convex round-trip — discriminated union. Refresh-grant branches on the
   * `ok` discriminator: `valid` rotates, `revoked` returns invalid_grant
   * (consumes the token), `transient` restores the token to Redis and
   * returns 503 + Retry-After (so a Convex blip doesn't force re-auth).
   * F3 of the U7+U8 review pass.
   */
  validateProMcpToken: typeof validateProMcpToken;
  /** Random UUID — injectable so tests can assert specific ids in the response payload. */
  randomUuid: () => string;
}

interface CodeDataPro {
  kind: 'pro';
  userId: string;
  mcpTokenId: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope?: string;
}

interface CodeDataLegacy {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope?: string;
  api_key_hash: string;
  kind?: undefined;
}

interface RefreshDataPro {
  kind: 'pro';
  client_id: string;
  userId: string;
  mcpTokenId: string;
  scope: string;
  family_id: string;
}

interface RefreshDataLegacy {
  client_id: string;
  api_key_hash: string;
  scope: string;
  family_id: string;
  kind?: undefined;
}

// ---------------------------------------------------------------------------
// Per-grant handlers — extracted so the top-level `tokenHandler` stays under
// the cognitive-complexity threshold (biome lint rule). Each helper assumes
// rate-limiting + method dispatch already happened at the caller.
// ---------------------------------------------------------------------------

async function handleAuthorizationCode(
  params: URLSearchParams,
  clientId: string | null,
  deps: TokenHandlerDeps,
): Promise<Response> {
  const code = params.get('code');
  const codeVerifier = params.get('code_verifier');
  const redirectUri = params.get('redirect_uri');

  if (!code || !codeVerifier || !clientId || !redirectUri) {
    return jsonResp(
      {
        error: 'invalid_request',
        error_description: 'Missing required parameters: code, code_verifier, client_id, redirect_uri',
      },
      400,
    );
  }

  // Validate code_verifier format before any crypto work
  if (
    codeVerifier.length < 43 ||
    codeVerifier.length > 128 ||
    !/^[A-Za-z0-9\-._~]+$/.test(codeVerifier)
  ) {
    return jsonResp(
      {
        error: 'invalid_request',
        error_description: 'code_verifier must be 43-128 URL-safe characters [A-Za-z0-9-._~]',
      },
      400,
    );
  }

  // Atomically consume the auth code (GETDEL — prevents concurrent exchange race).
  let codeData: CodeDataPro | CodeDataLegacy | null;
  try {
    codeData = (await deps.redisGetDel(`oauth:code:${code}`)) as CodeDataPro | CodeDataLegacy | null;
  } catch {
    return jsonResp(
      { error: 'server_error', error_description: 'Auth service temporarily unavailable. Please retry.' },
      503,
    );
  }
  if (!codeData) {
    return jsonResp(
      { error: 'invalid_grant', error_description: 'Authorization code is invalid, expired, or already used' },
      400,
    );
  }
  if (codeData.client_id !== clientId) {
    return jsonResp({ error: 'invalid_grant', error_description: 'client_id mismatch' }, 400);
  }
  if (codeData.redirect_uri !== redirectUri) {
    return jsonResp({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400);
  }

  // Verify PKCE (same for both kinds)
  const pkceVerify = await verifyPkceS256(codeVerifier, codeData.code_challenge);
  if (pkceVerify === null) {
    return jsonResp({ error: 'invalid_request', error_description: 'Malformed PKCE parameters' }, 400);
  }
  if (pkceVerify === false) {
    return jsonResp(
      { error: 'invalid_grant', error_description: 'code_verifier does not match code_challenge' },
      400,
    );
  }

  const clientCheck = await checkClientExists(deps, clientId);
  if (clientCheck) return clientCheck;

  const accessUuid = deps.randomUuid();
  const refreshUuid = deps.randomUuid();
  const familyId = deps.randomUuid();

  // Branch by code-record kind. Pro records carry `userId` + `mcpTokenId`;
  // legacy records carry the `api_key_hash` SHA-256.
  if (codeData.kind === 'pro') {
    const scope = codeData.scope ?? 'mcp_pro';
    const stored = await storeProTokens(
      deps.redisPipeline,
      accessUuid,
      refreshUuid,
      codeData.userId,
      codeData.mcpTokenId,
      clientId,
      scope,
      familyId,
    );
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

  // Legacy env-key path — unchanged
  const scope = codeData.scope ?? 'mcp';
  const stored = await storeNewTokens(
    deps.redisPipeline,
    accessUuid,
    refreshUuid,
    codeData.api_key_hash,
    clientId,
    scope,
    familyId,
  );
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

async function handleRefreshToken(
  params: URLSearchParams,
  clientId: string | null,
  deps: TokenHandlerDeps,
): Promise<Response> {
  const refreshToken = params.get('refresh_token');

  if (!refreshToken || !clientId) {
    return jsonResp(
      {
        error: 'invalid_request',
        error_description: 'Missing required parameters: refresh_token, client_id',
      },
      400,
    );
  }

  // Atomically consume the refresh token (GETDEL — prevents concurrent rotation race).
  let refreshData: RefreshDataPro | RefreshDataLegacy | null;
  try {
    refreshData = (await deps.redisGetDel(`oauth:refresh:${refreshToken}`)) as
      | RefreshDataPro
      | RefreshDataLegacy
      | null;
  } catch {
    return jsonResp(
      { error: 'server_error', error_description: 'Auth service temporarily unavailable. Please retry.' },
      503,
    );
  }
  if (!refreshData) {
    return jsonResp(
      { error: 'invalid_grant', error_description: 'Refresh token is invalid, expired, or already used' },
      400,
    );
  }
  if (refreshData.client_id !== clientId) {
    return jsonResp({ error: 'invalid_grant', error_description: 'client_id mismatch' }, 400);
  }

  const clientCheck = await checkClientExists(deps, clientId);
  if (clientCheck) return clientCheck;

  const accessUuid = deps.randomUuid();
  const newRefreshUuid = deps.randomUuid();

  if (refreshData.kind === 'pro') {
    // F3 (U7+U8 review pass): branch on the discriminated-union result so
    // a transient Convex blip does NOT consume the refresh token. The
    // GETDEL above already removed the token from Redis; on `transient`
    // we best-effort write it BACK with the original TTL and return 503,
    // letting the client retry once Convex recovers.
    //
    // userId-mismatch defensive check on the `valid` branch: if Convex
    // ever returns a different user for this tokenId (impossible under
    // U1's schema, but cheap), refuse rather than silently rotate to the
    // wrong identity.
    const validation: ProMcpValidateUnion = await deps.validateProMcpToken(refreshData.mcpTokenId);

    if (validation.ok === 'transient') {
      // Best-effort restore: the user's refresh token was just consumed
      // by GETDEL but Convex hasn't ruled it revoked. Put it back so the
      // next attempt can succeed once the blip clears. Failure here is
      // accepted (the user re-authorizes; not catastrophic, just
      // operationally noisy).
      try {
        await deps.redisPipeline([[
          'SET',
          `oauth:refresh:${refreshToken}`,
          JSON.stringify(refreshData),
          'EX',
          REFRESH_TTL_SECONDS,
        ]]);
      } catch {
        // Best-effort. If restore fails the user re-authorizes — same
        // outcome as before this fix; we've not made anything worse.
      }
      return jsonResp(
        { error: 'server_error', error_description: 'Auth service temporarily unavailable. Please retry.' },
        503,
      );
    }

    if (validation.ok === 'revoked' || validation.userId !== refreshData.userId) {
      // Authoritatively revoked OR cross-user binding violation. The
      // refresh token is genuinely consumed (GETDEL); collapse to
      // `invalid_grant` so the client re-authorizes. Same opaque error
      // copy in both cases — don't leak revoked vs. cross-user.
      return jsonResp(
        { error: 'invalid_grant', error_description: 'Refresh token is invalid, expired, or already used' },
        400,
      );
    }

    const scope = refreshData.scope ?? 'mcp_pro';
    const stored = await storeProTokens(
      deps.redisPipeline,
      accessUuid,
      newRefreshUuid,
      refreshData.userId,
      refreshData.mcpTokenId,
      clientId,
      scope,
      refreshData.family_id,
    );
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

  // Legacy env-key path — unchanged
  const scope = refreshData.scope ?? 'mcp';
  const stored = await storeNewTokens(
    deps.redisPipeline,
    accessUuid,
    newRefreshUuid,
    refreshData.api_key_hash,
    clientId,
    scope,
    refreshData.family_id,
  );
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

async function handleClientCredentials(
  clientSecret: string | null,
  deps: TokenHandlerDeps,
): Promise<Response> {
  if (!(await validateSecret(clientSecret))) {
    return jsonResp({ error: 'invalid_client', error_description: 'Invalid client credentials' }, 401);
  }
  const uuid = deps.randomUuid();
  const stored = await storeLegacyToken(deps.redisPipeline, uuid, clientSecret as string);
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

/**
 * Verify `oauth:client:<id>` exists; returns a Response on failure (caller
 * short-circuits) or null on success. Also fires the sliding-TTL EXPIRE.
 */
async function checkClientExists(deps: TokenHandlerDeps, clientId: string): Promise<Response | null> {
  let client: unknown;
  try {
    client = await deps.redisGet(`oauth:client:${clientId}`);
  } catch {
    return jsonResp(
      { error: 'server_error', error_description: 'Auth service temporarily unavailable. Please retry.' },
      503,
    );
  }
  if (!client) {
    return jsonResp(
      {
        error: 'invalid_client',
        error_description: 'Client registration not found or expired. Please re-register.',
      },
      401,
    );
  }
  // Extend client TTL (sliding 90-day window) — fire-and-forget
  deps.redisPipeline([['EXPIRE', `oauth:client:${clientId}`, CLIENT_TTL_SECONDS]]).catch(() => {});
  return null;
}

async function applyRateLimit(
  req: Request,
  grantType: string | null,
  clientSecret: string | null,
  clientId: string | null,
): Promise<Response | null> {
  const rl = getRatelimit();
  if (!rl) return null;
  try {
    let rlKey: string;
    if (grantType === 'client_credentials' && clientSecret) {
      rlKey = `cred:${(await sha256Hex(clientSecret)).slice(0, 8)}`;
    } else if (clientId) {
      rlKey = `cid:${clientId}`;
    } else {
      rlKey = `ip:${getClientIp(req)}`;
    }
    const { success } = await rl.limit(rlKey);
    if (!success) {
      return jsonResp(
        { error: 'rate_limit_exceeded', error_description: 'Too many token requests. Try again later.' },
        429,
      );
    }
    return null;
  } catch {
    return null; // graceful degradation
  }
}

export async function tokenHandler(req: Request, deps: TokenHandlerDeps): Promise<Response> {
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

  const rateLimited = await applyRateLimit(req, grantType, clientSecret, clientId);
  if (rateLimited) return rateLimited;

  if (grantType === 'authorization_code') {
    return handleAuthorizationCode(params, clientId, deps);
  }
  if (grantType === 'refresh_token') {
    return handleRefreshToken(params, clientId, deps);
  }
  if (grantType === 'client_credentials') {
    return handleClientCredentials(clientSecret, deps);
  }
  return jsonResp({ error: 'unsupported_grant_type' }, 400);
}

// ---------------------------------------------------------------------------
// Default handler — wires production deps. The Vercel edge entry point.
// ---------------------------------------------------------------------------

export default async function handler(req: Request): Promise<Response> {
  return tokenHandler(req, {
    redisGetDel: rawRedisGetDel,
    redisGet: rawRedisGet,
    redisPipeline: rawRedisPipeline,
    validateProMcpToken,
    randomUuid: () => crypto.randomUUID(),
  });
}
