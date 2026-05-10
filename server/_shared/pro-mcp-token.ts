/**
 * Edge-runtime-safe wrappers around the Convex Pro-MCP-token internal
 * HTTP actions (U1).
 *
 * Per plan U2: every Pro MCP request hits Convex `validateProMcpToken` —
 * positive results are NEVER cached at the edge. Revoke takes effect on
 * the next request, period. A short-lived 60s **negative cache** is kept
 * for already-known-bad bearers (revoked / never-existed tokenIds) so a
 * misbehaving Claude client can't hammer Convex with a stale bearer.
 *
 * Differences from `user-api-key.ts` (the closest sibling pattern):
 *   - That file positive-caches the {userId, keyId, name} payload for
 *     CACHE_TTL_SECONDS via `cachedFetchJson`. We do NOT — revoke must be
 *     authoritative on the next request (R3).
 *   - We still negative-cache for 60s, sharing the same fail-soft posture
 *     on Convex/network errors (returns null → caller's bearer resolution
 *     returns null → 401). See memory `entitlement-signal-server-outlier-sweep`
 *     — entitlement gates fail closed; bearer-resolution failures fail-soft
 *     so a transient Convex blip yields a clean 401 instead of a hung 500.
 *
 * The Convex validate route schedules `touchProMcpTokenLastUsed` in-mutation
 * via `ctx.scheduler.runAfter` (mirrors apiKeys at convex/http.ts:839). We
 * do NOT need a `touchProMcpTokenLastUsedFireAndForget` helper here.
 */

import { deleteRedisKey } from './redis';

/** Negative-cache TTL: 60s — short enough that a re-issued tokenId (vanishingly
 *  rare given Convex IDs) becomes resolvable promptly, long enough to suppress
 *  hammering on a known-bad bearer. Plan U2 default. */
const NEG_TTL_SECONDS = 60;

/** Convex internal HTTP-action call timeout. Matches user-api-key.ts (3s). */
const CONVEX_TIMEOUT_MS = 3_000;

/** Redis key namespace for the negative-cache sentinel. */
const NEG_CACHE_KEY_PREFIX = 'pro-mcp-token-neg:';

/** Sentinel value (presence check is what matters; value is opaque). */
const NEG_SENTINEL_VALUE = '1';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProMcpValidateResult {
  userId: string;
}

export interface ProMcpIssueResult {
  tokenId: string;
}

/** Discriminated error kinds for `issueProMcpTokenForUser`. */
export type IssueFailedKind =
  | 'pro-required'        // Convex 403 PRO_REQUIRED — caller's user is not Pro.
  | 'invalid-user-id'     // Convex 400 INVALID_USER_ID — empty/missing userId.
  | 'config'              // Edge env (CONVEX_SITE_URL / shared secret) missing.
  | 'network';            // Convex 5xx, network error, timeout, or unknown 4xx.

export class ProMcpIssueFailed extends Error {
  readonly kind: IssueFailedKind;
  readonly status?: number;
  constructor(kind: IssueFailedKind, message: string, status?: number) {
    super(message);
    this.name = 'ProMcpIssueFailed';
    this.kind = kind;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Convex env wiring
// ---------------------------------------------------------------------------

interface ConvexEnv {
  siteUrl: string;
  sharedSecret: string;
}

function getConvexEnv(): ConvexEnv | null {
  const siteUrl = process.env.CONVEX_SITE_URL;
  const sharedSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
  if (!siteUrl || !sharedSecret) return null;
  return { siteUrl, sharedSecret };
}

function convexHeaders(sharedSecret: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'User-Agent': 'worldmonitor-gateway/1.0',
    'x-convex-shared-secret': sharedSecret,
  };
}

// ---------------------------------------------------------------------------
// Negative-cache helpers — direct Upstash REST so the cache key is exactly
// `pro-mcp-token-neg:<tokenId>` and does NOT inherit env-prefix semantics
// from `redis.ts` (these tokenIds are Convex IDs scoped to the Convex deploy
// already; double-prefixing would be redundant).
// ---------------------------------------------------------------------------

const REDIS_OP_TIMEOUT_MS = 1_500;

function negCacheKey(tokenId: string): string {
  return `${NEG_CACHE_KEY_PREFIX}${tokenId}`;
}

async function readNegCache(tokenId: string): Promise<boolean> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;
  try {
    const resp = await fetch(`${url}/get/${encodeURIComponent(negCacheKey(tokenId))}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REDIS_OP_TIMEOUT_MS),
    });
    if (!resp.ok) return false;
    const data = (await resp.json()) as { result?: string | null };
    return typeof data.result === 'string' && data.result.length > 0;
  } catch (err) {
    // Fail-open on Redis errors: a Redis blip should not cause every Pro
    // request to bypass the negative-cache short-circuit AND succeed —
    // returning false here just means we round-trip Convex this once,
    // which is the safe direction.
    console.warn('[pro-mcp-token] readNegCache failed:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

async function writeNegCache(tokenId: string): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  try {
    await fetch(
      `${url}/set/${encodeURIComponent(negCacheKey(tokenId))}/${encodeURIComponent(NEG_SENTINEL_VALUE)}/EX/${NEG_TTL_SECONDS}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REDIS_OP_TIMEOUT_MS),
      },
    );
  } catch (err) {
    // Best-effort: if we can't write the sentinel, the next request will
    // re-hit Convex. Not load-bearing for correctness.
    console.warn('[pro-mcp-token] writeNegCache failed:', err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Issue a new Pro MCP token row in Convex.
 *
 * Called from `/oauth/authorize-pro` (U5) AFTER the Clerk grant has been
 * verified. Throws a typed `ProMcpIssueFailed`:
 *   - `pro-required`: caller's userId is not Pro (Convex 403). U5 returns
 *     an HTML error page or redirects to upgrade.
 *   - `invalid-user-id`: empty/missing userId (Convex 400). U5 returns 400.
 *   - `network`: Convex 5xx, network error, timeout, or unknown 4xx. U5
 *     returns 503 (the OAuth flow is replayable — Claude will retry).
 *   - `config`: edge env missing. U5 returns 500.
 */
export async function issueProMcpTokenForUser(
  userId: string,
  clientId?: string,
  name?: string,
): Promise<ProMcpIssueResult> {
  const env = getConvexEnv();
  if (!env) {
    throw new ProMcpIssueFailed(
      'config',
      'CONVEX_SITE_URL or CONVEX_SERVER_SHARED_SECRET not configured',
    );
  }

  let resp: Response;
  try {
    resp = await fetch(`${env.siteUrl}/api/internal-issue-pro-mcp-token`, {
      method: 'POST',
      headers: convexHeaders(env.sharedSecret),
      body: JSON.stringify({ userId, clientId, name }),
      signal: AbortSignal.timeout(CONVEX_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ProMcpIssueFailed(
      'network',
      `Convex issue request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (resp.ok) {
    const data = (await resp.json().catch(() => null)) as ProMcpIssueResult | null;
    if (!data || typeof data.tokenId !== 'string' || !data.tokenId) {
      throw new ProMcpIssueFailed('network', 'Convex issue response missing tokenId', resp.status);
    }
    return { tokenId: data.tokenId };
  }

  // Map Convex error responses (see convex/http.ts /api/internal-issue-pro-mcp-token).
  if (resp.status === 403) {
    throw new ProMcpIssueFailed('pro-required', 'Pro entitlement required to issue MCP token', 403);
  }
  if (resp.status === 400) {
    throw new ProMcpIssueFailed('invalid-user-id', 'Invalid userId for Pro MCP token issue', 400);
  }
  // 401 (shared-secret mismatch) and 5xx and any other status → network/transient.
  throw new ProMcpIssueFailed(
    'network',
    `Convex issue returned HTTP ${resp.status}`,
    resp.status,
  );
}

/**
 * Validate a Pro MCP token by tokenId.
 *
 * Returns `{userId}` if the row exists and is not revoked. Returns null
 * otherwise (revoked, never-existed, malformed, or transient Convex
 * failure — all collapse to "unauthenticated" at the caller).
 *
 * Caching policy (load-bearing — see plan U2):
 *   1. Read `pro-mcp-token-neg:<tokenId>`. If sentinel is present, return
 *      null IMMEDIATELY without hitting Convex.
 *   2. Otherwise round-trip Convex `/api/internal-validate-pro-mcp-token`.
 *   3. If Convex returns `{userId}`: return it. Do NOT cache positively
 *      (revoke must be authoritative on the next request).
 *   4. If Convex returns null: write the negative-cache sentinel (60s TTL)
 *      and return null.
 *   5. If Convex 5xx / network / timeout / non-JSON: log + return null.
 *      (Fail-soft. Do NOT write the sentinel — a blip should not mark a
 *      legitimate token as bad for 60s.)
 */
export async function validateProMcpToken(tokenId: string): Promise<ProMcpValidateResult | null> {
  if (!tokenId) return null;

  // Step 1: negative-cache short-circuit.
  if (await readNegCache(tokenId)) return null;

  // Step 2: Convex round-trip.
  const env = getConvexEnv();
  if (!env) return null;

  let resp: Response;
  try {
    resp = await fetch(`${env.siteUrl}/api/internal-validate-pro-mcp-token`, {
      method: 'POST',
      headers: convexHeaders(env.sharedSecret),
      body: JSON.stringify({ tokenId }),
      signal: AbortSignal.timeout(CONVEX_TIMEOUT_MS),
    });
  } catch (err) {
    // Fail-soft: timeout / network error → null, no neg-cache write.
    console.warn(
      '[pro-mcp-token] validateProMcpToken Convex fetch failed:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  if (!resp.ok) {
    // 5xx / 401 / unexpected: fail-soft, no neg-cache write.
    console.warn(`[pro-mcp-token] validateProMcpToken Convex HTTP ${resp.status}`);
    return null;
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch (err) {
    console.warn(
      '[pro-mcp-token] validateProMcpToken Convex JSON parse failed:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  // Convex returns `null` for revoked / not-found / malformed-id; otherwise
  // `{userId: string}`. Defensive-shape check before trusting.
  if (
    body &&
    typeof body === 'object' &&
    'userId' in body &&
    typeof (body as { userId: unknown }).userId === 'string' &&
    (body as { userId: string }).userId.length > 0
  ) {
    // Step 3: positive — return WITHOUT caching.
    return { userId: (body as { userId: string }).userId };
  }

  // Step 4: negative — write sentinel and return null.
  await writeNegCache(tokenId);
  return null;
}

/**
 * Revoke a Pro MCP token via the internal Convex HTTP route (server-to-server,
 * shared-secret + in-mutation tenancy gate).
 *
 * Use this from rollback paths (e.g. `/oauth/authorize-pro` U5: after
 * `issueProMcpToken` succeeds but the `oauth:code` SETEX fails). The
 * settings-UI revoke endpoint (U9) calls the **public** `revokeProMcpToken`
 * Convex mutation directly, NOT this helper.
 *
 * After a successful revoke, writes the negative-cache sentinel so any
 * already-resolved bearer with this tokenId stops on the next validate.
 *
 * Returns `{ ok: true }` on success, `{ ok: false, reason }` on logical
 * failures (NOT_FOUND / ALREADY_REVOKED / config / network). Does not
 * throw — rollback callers should not let revoke errors mask the original
 * cause they were rolling back from.
 */
export async function revokeProMcpToken(
  userId: string,
  tokenId: string,
): Promise<{ ok: true } | { ok: false; reason: 'config' | 'not-found' | 'already-revoked' | 'network' }> {
  if (!userId || !tokenId) return { ok: false, reason: 'not-found' };

  const env = getConvexEnv();
  if (!env) return { ok: false, reason: 'config' };

  let resp: Response;
  try {
    resp = await fetch(`${env.siteUrl}/api/internal-revoke-pro-mcp-token`, {
      method: 'POST',
      headers: convexHeaders(env.sharedSecret),
      body: JSON.stringify({ userId, tokenId }),
      signal: AbortSignal.timeout(CONVEX_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(
      '[pro-mcp-token] revokeProMcpToken Convex fetch failed:',
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, reason: 'network' };
  }

  if (resp.ok) {
    // Set the negative-cache sentinel so the next validate short-circuits
    // even if some in-flight bearer has already been resolved.
    await writeNegCache(tokenId);
    return { ok: true };
  }

  if (resp.status === 404) return { ok: false, reason: 'not-found' };
  if (resp.status === 409) return { ok: false, reason: 'already-revoked' };
  return { ok: false, reason: 'network' };
}

/**
 * Set the negative-cache sentinel for a tokenId. Public so the U9 settings
 * revoke endpoint (which talks to the public Convex mutation directly) can
 * call this after a successful revoke to invalidate any cached bearers.
 *
 * Equivalent to writing `pro-mcp-token-neg:<tokenId>` = "1" with 60s EX.
 */
export async function invalidateProMcpTokenCache(tokenId: string): Promise<void> {
  if (!tokenId) return;
  await writeNegCache(tokenId);
}

/**
 * Test/admin helper: clear the negative-cache sentinel for a tokenId.
 * Used by integration tests; not exercised by production code paths.
 */
export async function clearProMcpTokenNegCache(tokenId: string): Promise<void> {
  if (!tokenId) return;
  await deleteRedisKey(negCacheKey(tokenId), /* raw */ true);
}
