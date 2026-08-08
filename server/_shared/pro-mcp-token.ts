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

/**
 * Discriminated union returned by `validateProMcpToken`. Distinguishes:
 *   - `valid`: Convex returned an active row → `{userId}` resolved.
 *   - `revoked`: Convex authoritatively returned null (row missing or revoked).
 *               Negative-cache sentinel is written; safe to fail-closed.
 *   - `transient`: Convex 5xx, network error, timeout, or malformed JSON.
 *                 No neg-cache write — a blip should not mark a legitimate
 *                 token as bad for 60s.
 *
 * Refresh-grant callers (api/oauth/token.ts) need this distinction so a
 * transient Convex blip does NOT consume the user's refresh token. See
 * F3 in the U7+U8 review pass.
 */
export type ProMcpValidateUnion =
  | { ok: 'valid'; userId: string }
  | { ok: 'revoked' }
  | { ok: 'transient' };

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
    // Fail-open on Redis errors: round-trip Convex this once; the worst
    // case is one extra Convex call, which is the safe direction.
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
 * Validate a Pro MCP token by tokenId — discriminated-union variant.
 *
 * Returns `{ok:'valid', userId}` if the row exists and is not revoked.
 * Returns `{ok:'revoked'}` if Convex authoritatively returned null
 * (row missing, revoked, or malformed-id). Returns `{ok:'transient'}` on
 * Convex 5xx / network error / timeout / non-JSON — caller can decide
 * whether to fail-closed (per-request validate) or preserve the refresh
 * token (refresh-grant path) instead of consuming it.
 *
 * Caching policy (load-bearing — see plan U2):
 *   1. Read `pro-mcp-token-neg:<tokenId>`. If sentinel is present, return
 *      `{ok:'revoked'}` IMMEDIATELY without hitting Convex.
 *   2. Otherwise round-trip Convex `/api/internal-validate-pro-mcp-token`.
 *   3. If Convex returns `{userId}`: return `{ok:'valid', userId}`. Do NOT
 *      cache positively (revoke must be authoritative on the next request).
 *   4. If Convex returns null / missing-userId: write the negative-cache
 *      sentinel (60s TTL) and return `{ok:'revoked'}`.
 *   5. If Convex 5xx / network / timeout / non-JSON: log + return
 *      `{ok:'transient'}`. (Fail-soft. Do NOT write the sentinel — a blip
 *      should not mark a legitimate token as bad for 60s.)
 *
 * Most callers want the simpler `userId | null` shape (per-request
 * validate, fail-closed on transient is correct because a 401 will retry
 * via the OAuth flow anyway). Use {@link validateProMcpTokenOrNull} for
 * that — it wraps this and maps `revoked|transient → null`.
 */
export async function validateProMcpToken(tokenId: string): Promise<ProMcpValidateUnion> {
  if (!tokenId) return { ok: 'revoked' };

  // Step 1: negative-cache short-circuit.
  if (await readNegCache(tokenId)) return { ok: 'revoked' };

  // Step 2: Convex round-trip.
  const env = getConvexEnv();
  if (!env) return { ok: 'transient' };

  let resp: Response;
  try {
    resp = await fetch(`${env.siteUrl}/api/internal-validate-pro-mcp-token`, {
      method: 'POST',
      headers: convexHeaders(env.sharedSecret),
      body: JSON.stringify({ tokenId }),
      signal: AbortSignal.timeout(CONVEX_TIMEOUT_MS),
    });
  } catch (err) {
    // Fail-soft: timeout / network error → transient, no neg-cache write.
    console.warn(
      '[pro-mcp-token] validateProMcpToken Convex fetch failed:',
      err instanceof Error ? err.message : String(err),
    );
    return { ok: 'transient' };
  }

  if (!resp.ok) {
    // 5xx / 401 / unexpected: fail-soft, no neg-cache write.
    console.warn(`[pro-mcp-token] validateProMcpToken Convex HTTP ${resp.status}`);
    return { ok: 'transient' };
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch (err) {
    console.warn(
      '[pro-mcp-token] validateProMcpToken Convex JSON parse failed:',
      err instanceof Error ? err.message : String(err),
    );
    // Malformed body — treat as transient (NOT revoked). Don't poison the
    // cache for what is structurally a server-side glitch.
    return { ok: 'transient' };
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
    return { ok: 'valid', userId: (body as { userId: string }).userId };
  }

  // Step 4: negative — write sentinel and return revoked.
  await writeNegCache(tokenId);
  return { ok: 'revoked' };
}

/**
 * Backward-compatible wrapper that maps the discriminated union to the
 * legacy `{userId} | null` shape. Use this for per-request validate paths
 * where transient and revoked both fail-closed (the caller returns 401 and
 * the client retries via OAuth — no information loss).
 *
 * The refresh-grant path in `api/oauth/token.ts` MUST call
 * `validateProMcpToken` directly to distinguish transient from revoked,
 * otherwise a Convex blip silently consumes the refresh token.
 */
export async function validateProMcpTokenOrNull(tokenId: string): Promise<ProMcpValidateResult | null> {
  const r = await validateProMcpToken(tokenId);
  if (r.ok === 'valid') return { userId: r.userId };
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

// ---------------------------------------------------------------------------
// Daily quota counter — single-source-of-truth key shape
// ---------------------------------------------------------------------------

/**
 * Redis key shape for the Pro daily-quota INCR/DECR counter.
 *
 * U7 (api/mcp.ts) writes via INCR-first reservation on every `tools/call`.
 * U9 (api/user/mcp-quota.ts) reads the same key for the settings UI.
 * BOTH MUST CALL THIS HELPER — drift between writer and reader produces
 * silent UI-vs-enforcement disagreement (the failure mode this helper exists
 * to prevent).
 *
 * Date is UTC YYYY-MM-DD. The fixed UTC midnight rollover is documented in
 * the plan ("Daily window — sliding or fixed? R: Fixed UTC midnight via
 * single Redis INCR counter for predictable reset and clean UI copy.").
 *
 * Env-prefixed: when running on a Vercel preview deploy
 * (VERCEL_ENV=preview, with VERCEL_GIT_COMMIT_SHA), the key is prefixed
 * `<env>:<sha8>:<base>` so preview traffic does NOT collide with
 * production counters in the shared Upstash instance. Production
 * (VERCEL_ENV unset or 'production') uses the bare base key — preserves
 * the historical wire format.
 *
 * Mirrors `server/_shared/redis.ts`'s `prefixKey` convention; replicated
 * here (not imported) because this helper is read by both the API edge
 * runtime and the gateway, and direct Upstash REST callers in this module
 * cannot consume the JSON-helper-specific paths in `redis.ts`.
 *
 * @param userId Clerk userId. Empty / falsy → returns "" (caller should
 *               never reach the INCR path with no userId, but the empty-
 *               key fail-soft mirrors the rest of this module).
 * @param date   Optional Date for test injection; defaults to `new Date()`.
 */
export function dailyCounterKey(userId: string, date?: Date): string {
  if (!userId) return '';
  const d = date ?? new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const base = `mcp:pro-usage:${userId}:${yyyy}-${mm}-${dd}`;
  return `${envPrefix()}${base}`;
}

/**
 * Compute the env-prefix at call time (NOT memoized — tests may mutate
 * VERCEL_ENV between calls; the cost is one trivial string read).
 * Production / unset → empty string. Mirrors `redis.ts::getKeyPrefix`.
 */
function envPrefix(): string {
  const env = process.env.VERCEL_ENV;
  if (!env || env === 'production') return '';
  const sha = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) || 'dev';
  return `${env}:${sha}:`;
}

/**
 * Seconds remaining until the next UTC midnight — used for the
 * `Retry-After` header on -32029 quota-exceeded responses.
 */
export function secondsUntilUtcMidnight(now?: Date): number {
  const d = now ?? new Date();
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0));
  return Math.max(1, Math.ceil((next.getTime() - d.getTime()) / 1000));
}

/** Hard cap per UTC day for Pro MCP `tools/call`s. Plan default. */
export const PRO_DAILY_QUOTA_LIMIT = 50;

/** TTL on the daily counter Redis key. 48h covers UTC-midnight rollover plus
 *  inspection window (operators can poke at yesterday's value through ~midday
 *  the next UTC day before the EXPIRE evicts it). */
export const PRO_DAILY_QUOTA_TTL_SECONDS = 172_800;
