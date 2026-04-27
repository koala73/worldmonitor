/**
 * Entitlement enforcement middleware for the Vercel API gateway.
 *
 * Reads cached entitlements from Redis (raw keys, no deployment prefix) with
 * Convex fallback on cache miss. Returns a 403 Response for tier-gated endpoints
 * when the user lacks the required tier.
 *
 * Fail-closed behavior:
 *   - No userId header on a gated endpoint -> 403 (authentication required)
 *   - Redis miss + Convex failure -> 403 (unable to verify entitlements)
 *   - Endpoint not in ENDPOINT_ENTITLEMENTS -> allow (unrestricted)
 */

import { getCachedJson, setCachedJson } from './redis';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CachedEntitlements {
  planKey: string;
  features: {
    tier: number;
    apiAccess: boolean;
    apiRateLimit: number;
    maxDashboards: number;
    prioritySupport: boolean;
    exportFormats: string[];
  };
  validUntil: number;
}

// ---------------------------------------------------------------------------
// Endpoint-to-tier map (replaces PREMIUM_RPC_PATHS)
// ---------------------------------------------------------------------------

/**
 * Maps API endpoints to the minimum tier required for access.
 * Tier hierarchy: 0=free, 1=pro, 2=api, 3=enterprise.
 *
 * Adding a new gated endpoint = adding one line to this map.
 * Endpoints NOT in this map are unrestricted.
 *
 * Stock-analysis endpoints sit at tier 1 (Pro) — the productCatalog markets
 * "AI stock analysis & backtesting" as a Pro feature, and these paths are
 * also in PREMIUM_RPC_PATHS where the legacy bearer gate accepts tier >= 1.
 * Tier-2 here would have made the new gate stricter than the legacy one and
 * 403'd real Pro subscribers calling via Clerk session (no tester key).
 */
const ENDPOINT_ENTITLEMENTS: Record<string, number> = {
  '/api/market/v1/analyze-stock': 1,
  '/api/market/v1/get-stock-analysis-history': 1,
  '/api/market/v1/backtest-stock': 1,
  '/api/market/v1/list-stored-stock-backtests': 1,
};

const CONVEX_INTERNAL_ENTITLEMENTS_PATH = '/api/internal-entitlements';
let _didWarnMissingConvexSharedSecret = false;

function getConvexSharedSecret(): string {
  const secret = process.env.CONVEX_SERVER_SHARED_SECRET ?? '';
  if (!secret && !_didWarnMissingConvexSharedSecret) {
    _didWarnMissingConvexSharedSecret = true;
    console.warn('[entitlement-check] CONVEX_SERVER_SHARED_SECRET not set; Convex fallback disabled');
  }
  return secret;
}

// ---------------------------------------------------------------------------
// Request coalescing (P1-6: Cache stampede mitigation)
// ---------------------------------------------------------------------------

const _inFlight = new Map<string, Promise<CachedEntitlements | null>>();

// ---------------------------------------------------------------------------
// Environment-aware Redis key prefix (P2-3)
// ---------------------------------------------------------------------------

const ENV_PREFIX = process.env.DODO_PAYMENTS_ENVIRONMENT === 'live_mode' ? 'live' : 'test';

// Cache TTL: 15 min — short enough that subscription expiry is reflected promptly (P2-5)
const ENTITLEMENT_CACHE_TTL_SECONDS = 900;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the minimum tier required for a given endpoint pathname.
 * Returns null if the endpoint is unrestricted (not in the map).
 */
export function getRequiredTier(pathname: string): number | null {
  return ENDPOINT_ENTITLEMENTS[pathname] ?? null;
}

/**
 * Fetches entitlements for a user. Tries Redis cache first (raw key),
 * then falls back to ConvexHttpClient query on cache miss.
 *
 * Returns null on any failure (fail-closed: caller must treat null as no entitlements).
 *
 * Uses request coalescing to prevent cache stampede: concurrent requests for
 * the same userId share a single in-flight promise.
 */
export async function getEntitlements(userId: string): Promise<CachedEntitlements | null> {
  const existing = _inFlight.get(userId);
  if (existing) return existing;

  const promise = _getEntitlementsImpl(userId);
  _inFlight.set(userId, promise);
  try {
    return await promise;
  } finally {
    _inFlight.delete(userId);
  }
}

async function _getEntitlementsImpl(userId: string): Promise<CachedEntitlements | null> {
  try {
    // Redis cache check (raw=true: entitlements use user-scoped keys, no deployment prefix)
    const cached = await getCachedJson(`entitlements:${ENV_PREFIX}:${userId}`, true);

    if (cached && typeof cached === 'object') {
      const ent = cached as CachedEntitlements;
      // Only use cached data if it hasn't expired
      if (ent.validUntil >= Date.now()) {
        return ent;
      }
      // Expired -- fall through to Convex
    }

    // Convex fallback on cache miss or expired cache
    const convexSiteUrl = process.env.CONVEX_SITE_URL;
    const convexSharedSecret = getConvexSharedSecret();
    if (!convexSiteUrl || !convexSharedSecret) return null;

    const response = await fetch(`${convexSiteUrl}${CONVEX_INTERNAL_ENTITLEMENTS_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'worldmonitor-gateway/1.0',
        'x-convex-shared-secret': convexSharedSecret,
      },
      body: JSON.stringify({ userId }),
    });
    if (!response.ok) return null;
    const result = await response.json() as CachedEntitlements | null;

    if (result) {
      // Populate Redis cache for subsequent requests (15-min TTL, raw key)
      await setCachedJson(`entitlements:${ENV_PREFIX}:${userId}`, result, ENTITLEMENT_CACHE_TTL_SECONDS, true);
      return result as CachedEntitlements;
    }

    return null;
  } catch (err) {
    // Fail-closed: any error in entitlement lookup returns null (caller blocks the request)
    console.warn('[entitlement-check] getEntitlements failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Checks whether the current request is allowed based on tier entitlements.
 *
 * Returns:
 *   - null if the request is allowed (unrestricted endpoint or sufficient tier)
 *   - a 403 Response if the user is unauthenticated, entitlements cannot be verified,
 *     or the user's tier is below the required tier (fail-closed)
 */
export async function checkEntitlement(
  request: Request,
  pathname: string,
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  const requiredTier = getRequiredTier(pathname);
  if (requiredTier === null) {
    // Unrestricted endpoint -- no check needed
    return null;
  }

  // Extract userId from request header (set by session middleware).
  // Fail-closed: if no userId on a gated endpoint, block the request.
  const userId = request.headers.get('x-user-id');
  if (!userId) {
    return new Response(
      JSON.stringify({ error: 'Authentication required', requiredTier }),
      { status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
    );
  }

  const ent = await getEntitlements(userId);
  if (!ent) {
    // Fail-closed: unable to verify entitlements -> block the request
    return new Response(
      JSON.stringify({ error: 'Unable to verify entitlements', requiredTier }),
      { status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
    );
  }

  if (ent.features.tier >= requiredTier) {
    // User has sufficient tier -- allow
    return null;
  }

  // User lacks required tier -- return 403
  return new Response(
    JSON.stringify({
      error: 'Upgrade required',
      requiredTier,
      currentTier: ent.features.tier,
      planKey: ent.planKey,
    }),
    {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    },
  );
}
