/**
 * Entitlement enforcement middleware for the Vercel API gateway.
 *
 * Reads cached entitlements from Redis (raw keys, no deployment prefix) with
 * Convex fallback on cache miss. Returns a 403 Response for tier-gated endpoints
 * when the user lacks the required tier. Degrades gracefully:
 *   - No userId header -> skip check (allow)
 *   - Redis miss + Convex failure -> allow (fail-open)
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
 */
const ENDPOINT_ENTITLEMENTS: Record<string, number> = {
  '/api/market/v1/analyze-stock': 2,
  '/api/market/v1/get-stock-analysis-history': 2,
  '/api/market/v1/backtest-stock': 2,
  '/api/market/v1/list-stored-stock-backtests': 2,
};

// ---------------------------------------------------------------------------
// Module-level singletons (avoid per-request import + construction)
// ---------------------------------------------------------------------------

let _convexClientPromise: Promise<{ client: InstanceType<typeof import('convex/browser').ConvexHttpClient>; api: typeof import('../../convex/_generated/api').api } | null> | null = null;

function getConvexSingleton() {
  if (!_convexClientPromise) {
    _convexClientPromise = (async () => {
      const convexUrl = process.env.CONVEX_URL;
      if (!convexUrl) return null;

      const [{ ConvexHttpClient }, { api }] = await Promise.all([
        import('convex/browser'),
        import('../../convex/_generated/api'),
      ]);

      return { client: new ConvexHttpClient(convexUrl), api };
    })();
  }
  return _convexClientPromise;
}

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
 * Returns null on any failure (fail-open).
 */
export async function getEntitlements(userId: string): Promise<CachedEntitlements | null> {
  try {
    // Redis cache check (raw=true: entitlements use user-scoped keys, no deployment prefix)
    const cached = await getCachedJson(`entitlements:${userId}`, true);

    if (cached && typeof cached === 'object') {
      const ent = cached as CachedEntitlements;
      // Only use cached data if it hasn't expired
      if (ent.validUntil >= Date.now()) {
        return ent;
      }
      // Expired -- fall through to Convex
    }

    // Convex fallback on cache miss or expired cache
    const singleton = await getConvexSingleton();
    if (!singleton) return null;

    const result = await singleton.client.query(singleton.api.entitlements.getEntitlementsForUser, { userId });

    if (result) {
      // Populate Redis cache for subsequent requests (1-hour TTL, raw key)
      await setCachedJson(`entitlements:${userId}`, result, 3600, true);
      return result as CachedEntitlements;
    }

    return null;
  } catch (err) {
    // Fail-open: any error in entitlement lookup allows the request through
    console.warn('[entitlement-check] getEntitlements failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Core entitlement check logic. Accepts a getEntitlementsFn parameter for
 * testability (dependency injection). Production callers use checkEntitlement()
 * which binds to the real getEntitlements.
 */
async function _checkEntitlementCore(
  request: Request,
  pathname: string,
  corsHeaders: Record<string, string>,
  getEntitlementsFn: (userId: string) => Promise<CachedEntitlements | null>,
): Promise<Response | null> {
  const requiredTier = getRequiredTier(pathname);
  if (requiredTier === null) {
    // Unrestricted endpoint -- no check needed
    return null;
  }

  // Extract userId from request header (set by session middleware when auth is ready).
  // During auth-stub era, this header won't be present -- degrade gracefully.
  const userId = request.headers.get('x-user-id');
  if (!userId) {
    // No user context -- skip entitlement check (graceful degradation)
    return null;
  }

  const ent = await getEntitlementsFn(userId);
  if (!ent) {
    // Cache miss + Convex failure -- fail-open (allow request)
    return null;
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

/**
 * Checks whether the current request is allowed based on tier entitlements.
 *
 * Returns:
 *   - null if the request is allowed (unrestricted endpoint, no userId, sufficient tier, or fail-open)
 *   - a 403 Response if the user's tier is below the required tier
 */
export async function checkEntitlement(
  request: Request,
  pathname: string,
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  return _checkEntitlementCore(request, pathname, corsHeaders, getEntitlements);
}

/**
 * Testable version of checkEntitlement that accepts a custom getEntitlements
 * function. Used in unit tests to inject mock entitlement data without needing
 * to mock Redis or Convex.
 */
export const _testCheckEntitlement = _checkEntitlementCore;
