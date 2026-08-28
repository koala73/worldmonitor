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
import { getClientIp, rateLimitErrorLevel, rateLimitFingerprintStage } from '../_rate-limit.js';
// @ts-expect-error — JS module, no declaration file
import { getPublicCorsHeaders } from '../_cors.js';
// @ts-expect-error — JS module, no declaration file
import { jsonResponse } from '../_json-response.js';
// @ts-expect-error — JS module, no declaration file
import { keyFingerprint, sha256Hex, timingSafeIncludes, verifyPkceS256 } from '../_crypto.js';
import { validateProMcpToken } from '../../server/_shared/pro-mcp-token';
import type { ProMcpValidateUnion } from '../../server/_shared/pro-mcp-token';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../_sentry-edge.js';
// @ts-expect-error — JS module, no declaration file
import { emitOAuthTokenUsage } from '../_usage-telemetry.js';
import {
  REFRESH_TTL_SECONDS,
  finalizeRefreshAttempt,
  markRefreshFamilyRevoked,
  persistRefreshFamilyPointer,
  rawRedisBeginRefreshAttempt,
  rawRedisFinalizeRefreshAttempt,
  rawRedisProtectFailedRefreshAttempt,
  rawRedisRestoreRefreshAttempt,
  refreshFamilyPointerKey,
  refreshFamilyRevocationKey,
  restoreRefreshAttempt,
} from './_refresh-recovery';
import type {
  PipelineCommand,
  PipelineResult,
  RefreshConsumeResult,
  RefreshRecoveryDeps,
  RefreshRestoreFailureContext,
} from './_refresh-recovery';

export const config = { runtime: 'edge' };

const TOKEN_TTL_SECONDS = 3600;
const CLIENT_TTL_SECONDS = 90 * 24 * 3600;

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

type WaitUntilCtx = { waitUntil: (promise: Promise<unknown>) => void };

interface TokenRateLimiter {
  limit(identifier: string): Promise<{ success: boolean; reason?: string }>;
}

type TokenRateLimitDecision =
  | { kind: 'allow' }
  | { kind: 'degraded' }
  | { kind: 'limited'; response: Response };

function jsonResp(body: unknown, status = 200): Response {
  return jsonResponse(body, status, { ...getPublicCorsHeaders('POST, OPTIONS'), ...NO_STORE });
}

function withRateLimitDegradedHeader(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('X-RateLimit-Mode', 'degraded');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// @upstash/redis defaults to 5 retries (~4.3s) before surfacing an unreachable
// Redis error. Under the node test runner skip retries so fail-open tests that
// point UPSTASH_REDIS_REST_URL at a fake host degrade immediately. Production
// (env unset) keeps the resilient default. Mirrors api/_rate-limit.js.
const REDIS_TEST_RETRY_OPTS: { retry?: false } = process.env.NODE_TEST_CONTEXT ? { retry: false } : {};

// Tight rate limiter for credential endpoint
let _rl: TokenRateLimiter | null = null;
let _rlOverride: TokenRateLimiter | null | undefined;
const DEGRADED_CAPTURE_DEDUP_MS = 60_000;
const lastDegradedCaptureAtByStage = new Map<string, number>();
const OAUTH_RATE_LIMIT_KEY_PATTERN = /rl:oauth-token:(?:cid|cred|ip):[^"\\]+/g;

function getRatelimit(): TokenRateLimiter | null {
  if (_rlOverride !== undefined) return _rlOverride;
  if (_rl) return _rl;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _rl = new Ratelimit({
    redis: new Redis({ url, token, ...REDIS_TEST_RETRY_OPTS }),
    limiter: Ratelimit.slidingWindow(10, '60 s'),
    prefix: 'rl:oauth-token',
    analytics: false,
  });
  return _rl;
}

/**
 * Test-only limiter injection. `null` forces the unconfigured path; omit via
 * `__resetOAuthTokenRateLimitForTest` to restore production construction.
 */
export function __setOAuthTokenRatelimitForTest(rl: TokenRateLimiter | null): void {
  _rlOverride = rl;
}

export function __resetOAuthTokenRateLimitForTest(): void {
  _rl = null;
  _rlOverride = undefined;
  lastDegradedCaptureAtByStage.clear();
}

/**
 * Bounded ops signal when the token limiter cannot decide. Deduped per isolate
 * per stage so an Upstash outage does not mint one Sentry event per POST.
 * Logs and Sentry extras never include client secrets, codes, refresh tokens,
 * or full client identifiers (#7270).
 */
function boundedGrantTag(grantType: string | null): string {
  if (
    grantType === 'authorization_code'
    || grantType === 'refresh_token'
    || grantType === 'client_credentials'
  ) {
    return grantType;
  }
  return grantType ? 'other' : 'none';
}

/**
 * `@upstash/redis` embeds the serialized command body in non-2xx errors.
 * Sliding-window keys contain the full limiter identifier, which must not
 * reach logs or Sentry (#7270).
 */
function sanitizeTokenRateLimitError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const msg = raw.replace(OAUTH_RATE_LIMIT_KEY_PATTERN, 'rl:oauth-token:<redacted>');
  if (err instanceof Error && msg === raw) return err;
  const sanitized = new Error(msg);
  if (err instanceof Error) {
    sanitized.name = err.name;
    if (typeof err.stack === 'string') {
      sanitized.stack = err.stack.split(raw).join(msg);
    }
  }
  return sanitized;
}

function reportTokenRateLimitDegraded(
  stage: string,
  err: unknown,
  ctx: WaitUntilCtx | undefined,
  grantType: string | null,
): void {
  const now = Date.now();
  const last = lastDegradedCaptureAtByStage.get(stage);
  if (last !== undefined && now - last < DEGRADED_CAPTURE_DEDUP_MS) return;
  lastDegradedCaptureAtByStage.set(stage, now);

  const sanitized = sanitizeTokenRateLimitError(err);
  const msg = sanitized.message;
  console.error(`[rate-limit] redis-error stage=${stage} msg=${msg}`);
  captureSilentError(sanitized, {
    tags: {
      surface: 'api',
      component: 'rate-limit',
      route: 'api/oauth/token',
      stage,
      grant: boundedGrantTag(grantType),
    },
    fingerprint: ['rate-limit', 'redis-error', rateLimitFingerprintStage(stage)],
    ctx,
    level: rateLimitErrorLevel(stage, sanitized.message),
  });
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
 * Token/refresh record shapes are unchanged (backward compat is load-bearing
 * for any already-issued bearers and refresh tokens still in flight), but
 * GHSA-f6gj also writes sibling family pointers used for reuse containment:
 *   oauth:token:<uuid>   = JSON.stringify("<sha256-hex-64>")
 *   oauth:refresh:<uuid> = JSON.stringify({client_id, api_key_hash, scope, family_id})
 *   oauth:tokenfam:<uuid> = JSON.stringify(family_id)
 *   oauth:famptr:<uuid>   = JSON.stringify(family_id)
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
    ['SET', accessTokenFamilyKey(accessUuid), JSON.stringify(familyId), 'EX', TOKEN_TTL_SECONDS],
    [
      'SET',
      `oauth:refresh:${refreshUuid}`,
      JSON.stringify({ client_id: clientId, api_key_hash: apiKeyHash, scope, family_id: familyId }),
      'EX',
      REFRESH_TTL_SECONDS,
    ],
    // Persistent family pointer (GHSA-f6gj): survives the GETDEL of the refresh
    // record so a later replay of this token can be traced to its family and
    // trigger family revocation. Same TTL as the refresh token.
    ['SET', refreshFamilyPointerKey(refreshUuid), JSON.stringify(familyId), 'EX', REFRESH_TTL_SECONDS],
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
 *   oauth:tokenfam:<uuid> = JSON.stringify(family_id)
 *   oauth:famptr:<uuid>   = JSON.stringify(family_id)
 *
 * `family_id` is preserved across refresh rotation and, together with the
 * persistent `oauth:famptr:<uuid>` pointer, powers reuse-detection family
 * revocation (GHSA-f6gj) — replaying a rotated token revokes the whole family.
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
    ['SET', accessTokenFamilyKey(accessUuid), JSON.stringify(familyId), 'EX', TOKEN_TTL_SECONDS],
    [
      'SET',
      `oauth:refresh:${refreshUuid}`,
      JSON.stringify({ kind: 'pro', client_id: clientId, userId, mcpTokenId, scope, family_id: familyId }),
      'EX',
      REFRESH_TTL_SECONDS,
    ],
    // Persistent family pointer (GHSA-f6gj) — see storeNewTokens.
    ['SET', refreshFamilyPointerKey(refreshUuid), JSON.stringify(familyId), 'EX', REFRESH_TTL_SECONDS],
  ]);
  return Array.isArray(results) && results.every((r) => r?.result === 'OK');
}

function accessTokenFamilyKey(accessToken: string): string {
  return `oauth:tokenfam:${accessToken}`;
}

// ---------------------------------------------------------------------------
// Inner handler — exported for unit tests with injected deps.
// ---------------------------------------------------------------------------

export interface TokenHandlerDeps extends RefreshRecoveryDeps {
  /** Atomic GETDEL on `oauth:code:<code>`. Throws on transport failure. */
  redisGetDel: (key: string) => Promise<unknown | null>;
  /** Non-consuming parsed read of raw `oauth:*` keys. Throws on transport failure. */
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
  /** Attempt id used to fence one consumed refresh-token recovery. */
  randomPointerId: () => string;
  /** Optional Vercel isolate context so limiter Sentry/usage survive teardown. */
  ctx?: WaitUntilCtx;
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

  // Consume the refresh record and create a recovery attempt in one Redis
  // script. A concurrent miss can then distinguish an in-flight attempt from
  // proven replay without changing the rollback-compatible family pointer.
  let consume: RefreshConsumeResult;
  try {
    consume = await deps.redisBeginRefreshAttempt(refreshToken, deps.randomPointerId());
  } catch {
    return temporaryAuthFailure();
  }

  if (consume.kind === 'miss') {
    if (consume.recoveryPending) return temporaryAuthFailure();

    // Only a miss with durable family evidence and no active recovery attempt
    // is a replay. Failed and in-flight attempts remain non-revocation-eligible.
    try {
      if (consume.familyId && !(await markRefreshFamilyRevoked(deps, consume.familyId))) {
        return temporaryAuthFailure();
      }
    } catch {
      return temporaryAuthFailure();
    }
    return invalidRefreshGrant();
  }

  const refreshData = consume.refreshData as RefreshDataPro | RefreshDataLegacy;
  const attemptValue = consume.attemptValue;
  if (!refreshData || typeof refreshData !== 'object') {
    return temporaryAuthFailure();
  }

  if (refreshData.client_id !== clientId) {
    if (!(await finalizeRefreshAttempt(deps, refreshToken, attemptValue))) return temporaryAuthFailure();
    return jsonResp({ error: 'invalid_grant', error_description: 'client_id mismatch' }, 400);
  }

  // New writes always use JSON.stringify(familyId). The old handler at the
  // merge base reads this exact shape, so rollback and mixed-version traffic
  // preserve replay revocation.
  let pointerStored = !refreshData.family_id;
  try {
    if (refreshData.family_id) {
      pointerStored = await persistRefreshFamilyPointer(deps, refreshToken, refreshData.family_id);
    }
  } catch {
    pointerStored = false;
  }
  if (!pointerStored) {
    await restoreRefreshAttempt(
      deps,
      refreshToken,
      attemptValue,
      refreshData,
      refreshData.family_id,
      'persist-family-pointer',
    );
    return temporaryAuthFailure();
  }

  // Reuse-detection containment (GHSA-f6gj): if this token's family was revoked
  // because a sibling token was replayed, refuse to rotate. The atomic claim
  // already consumed this token, so a revoked family forces the client to
  // re-authorize — this is what kills the attacker's rotated token (and the
  // victim's) once reuse is detected. Unknown revocation state is fail-closed:
  // restore the consumed token best-effort and ask the client to retry.
  if (refreshData.family_id) {
    let familyRevoked = false;
    try {
      familyRevoked = (await deps.redisGet(refreshFamilyRevocationKey(refreshData.family_id))) != null;
    } catch {
      await restoreRefreshAttempt(
        deps,
        refreshToken,
        attemptValue,
        refreshData,
        refreshData.family_id,
        'read-family-revocation',
      );
      return temporaryAuthFailure();
    }
    if (familyRevoked) {
      if (!(await finalizeRefreshAttempt(deps, refreshToken, attemptValue))) return temporaryAuthFailure();
      return invalidRefreshGrant();
    }
  }

  const clientCheck = await checkClientExists(deps, clientId);
  if (clientCheck) {
    const restored = await restoreRefreshAttempt(
      deps,
      refreshToken,
      attemptValue,
      refreshData,
      refreshData.family_id,
      'client-validation',
    );
    return restored ? clientCheck : temporaryAuthFailure();
  }

  const accessUuid = deps.randomUuid();
  const newRefreshUuid = deps.randomUuid();

  if (refreshData.kind === 'pro') {
    // F3 (U7+U8 review pass): branch on the discriminated-union result so
    // a transient Convex blip does NOT consume the refresh token. The
    // atomic claim replaced the token with a marker; on `transient` we
    // best-effort write it BACK with the original TTL and return 503,
    // letting the client retry once Convex recovers.
    //
    // userId-mismatch defensive check on the `valid` branch: if Convex
    // ever returns a different user for this tokenId (impossible under
    // U1's schema, but cheap), refuse rather than silently rotate to the
    // wrong identity.
    const validation: ProMcpValidateUnion = await deps.validateProMcpToken(refreshData.mcpTokenId);

    if (validation.ok === 'transient') {
      // Restore the user's refresh token after the claim because Convex has not
      // ruled it revoked. Put it back so the
      // next attempt can succeed once the blip clears. Restore the family
      // pointer in the same operation so a restored near-expiry token cannot
      // outlive its replay-detection pointer.
      // If restoration fails, preserve a family-free recovery tombstone. The
      // retry must not be misclassified as reuse and revoke every sibling
      // session in the family (GHSA-f6gj).
      await restoreRefreshAttempt(
        deps,
        refreshToken,
        attemptValue,
        refreshData,
        refreshData.family_id,
        'convex-transient',
      );
      return temporaryAuthFailure();
    }

    if (validation.ok === 'revoked' || validation.userId !== refreshData.userId) {
      // Authoritatively revoked OR cross-user binding violation. The
      // refresh token is genuinely consumed (GETDEL); collapse to
      // `invalid_grant` so the client re-authorizes. Same opaque error
      // copy in both cases — don't leak revoked vs. cross-user.
      if (!(await finalizeRefreshAttempt(deps, refreshToken, attemptValue))) return temporaryAuthFailure();
      return invalidRefreshGrant();
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
      await restoreRefreshAttempt(
        deps,
        refreshToken,
        attemptValue,
        refreshData,
        refreshData.family_id,
        'store-rotated-token',
      );
      return temporaryAuthFailure();
    }
    if (!(await finalizeRefreshAttempt(deps, refreshToken, attemptValue))) return temporaryAuthFailure();
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
    await restoreRefreshAttempt(
      deps,
      refreshToken,
      attemptValue,
      refreshData,
      refreshData.family_id,
      'store-rotated-token',
    );
    return temporaryAuthFailure();
  }
  if (!(await finalizeRefreshAttempt(deps, refreshToken, attemptValue))) return temporaryAuthFailure();
  return jsonResp({
    access_token: accessUuid,
    token_type: 'Bearer',
    expires_in: TOKEN_TTL_SECONDS,
    refresh_token: newRefreshUuid,
    scope,
  });
}

function temporaryAuthFailure(): Response {
  return jsonResp(
    { error: 'server_error', error_description: 'Auth service temporarily unavailable. Please retry.' },
    503,
  );
}

function invalidRefreshGrant(): Response {
  return jsonResp(
    { error: 'invalid_grant', error_description: 'Refresh token is invalid, expired, or already used' },
    400,
  );
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

/**
 * Abuse budget for POST /oauth/token. All grant types stay fail-open when the
 * limiter is unconfigured or throws: MCP clients abort the handshake on a 503
 * here, Redis persistence still fails closed downstream when storage is down,
 * and `client_credentials` still has the env-key allowlist. The current
 * fallback must stay operator-visible (#7270) — log + Sentry (deduped),
 * `X-RateLimit-Mode: degraded` on the response, and a usage `reason`.
 */
async function applyRateLimit(
  req: Request,
  grantType: string | null,
  clientSecret: string | null,
  clientId: string | null,
  ctx: WaitUntilCtx | undefined,
): Promise<TokenRateLimitDecision> {
  const rl = getRatelimit();
  if (!rl) {
    reportTokenRateLimitDegraded(
      'oauthToken:missing-config',
      new Error('Upstash Redis is not configured'),
      ctx,
      grantType,
    );
    return { kind: 'degraded' };
  }
  try {
    let rlKey: string;
    if (grantType === 'client_credentials' && clientSecret) {
      rlKey = `cred:${(await sha256Hex(clientSecret)).slice(0, 8)}`;
    } else if (clientId) {
      rlKey = `cid:${clientId}`;
    } else {
      rlKey = `ip:${getClientIp(req)}`;
    }
    const result = await rl.limit(rlKey);
    // @upstash/ratelimit v2 races Redis against an internal timeout and
    // RESOLVES `{ success: true, reason: 'timeout' }` rather than rejecting,
    // so a slow Redis is indistinguishable from a genuine allow unless we
    // treat timeout as the same fail-open degraded path as a throw (#6412).
    if (result.reason === 'timeout') {
      reportTokenRateLimitDegraded(
        'oauthToken:timeout',
        new Error('Upstash rate-limit decision timed out'),
        ctx,
        grantType,
      );
      return { kind: 'degraded' };
    }
    if (!result.success) {
      return {
        kind: 'limited',
        response: jsonResp(
          { error: 'rate_limit_exceeded', error_description: 'Too many token requests. Try again later.' },
          429,
        ),
      };
    }
    return { kind: 'allow' };
  } catch (err) {
    reportTokenRateLimitDegraded('oauthToken', err, ctx, grantType);
    return { kind: 'degraded' };
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

  const startedAt = Date.now();
  const params = new URLSearchParams(await req.text().catch(() => ''));
  const grantType = params.get('grant_type');
  const clientSecret = params.get('client_secret');
  const clientId = params.get('client_id');

  const rateLimit = await applyRateLimit(req, grantType, clientSecret, clientId, deps.ctx);
  if (rateLimit.kind === 'limited') {
    emitOAuthTokenUsage(deps.ctx, req, rateLimit.response, startedAt, 'rate_limit_429');
    return rateLimit.response;
  }

  let response: Response;
  if (grantType === 'authorization_code') {
    response = await handleAuthorizationCode(params, clientId, deps);
  } else if (grantType === 'refresh_token') {
    response = await handleRefreshToken(params, clientId, deps);
  } else if (grantType === 'client_credentials') {
    response = await handleClientCredentials(clientSecret, deps);
  } else {
    response = jsonResp({ error: 'unsupported_grant_type' }, 400);
  }

  if (rateLimit.kind === 'degraded') {
    response = withRateLimitDegradedHeader(response);
    emitOAuthTokenUsage(deps.ctx, req, response, startedAt, 'rate_limit_degraded');
  }
  return response;
}

// ---------------------------------------------------------------------------
// Default handler — wires production deps. The Vercel edge entry point.
// ---------------------------------------------------------------------------

export default async function handler(
  req: Request,
  ctx?: { waitUntil: (promise: Promise<unknown>) => void },
): Promise<Response> {
  return tokenHandler(req, {
    redisGetDel: rawRedisGetDel,
    redisGet: rawRedisGet,
    redisBeginRefreshAttempt: rawRedisBeginRefreshAttempt,
    redisRestoreRefreshAttempt: rawRedisRestoreRefreshAttempt,
    redisFinalizeRefreshAttempt: rawRedisFinalizeRefreshAttempt,
    redisProtectFailedRefreshAttempt: rawRedisProtectFailedRefreshAttempt,
    redisPipeline: rawRedisPipeline,
    validateProMcpToken,
    randomUuid: () => crypto.randomUUID(),
    randomPointerId: () => crypto.randomUUID(),
    ctx,
    captureRestoreFailure: (context: RefreshRestoreFailureContext) => {
      void captureSilentError(new Error('OAuth refresh token restore failed'), {
        tags: {
          route: 'api/oauth/token',
          step: 'refresh-restore',
          stage: context.stage,
        },
        ctx,
      });
    },
  });
}
