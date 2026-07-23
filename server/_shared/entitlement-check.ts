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

// Single source of truth for the billing-verification status union — imported
// by api/mcp/types.ts, api/mcp/auth.ts, and api/mcp/billing-denial.ts so the
// four surfaces cannot silently drift when a status is added.
export type BillingVerificationStatus =
  | 'subscription_lapsed'
  | 'renewal_verification_pending'
  | 'renewal_verification_failed';

export interface CachedEntitlements {
  planKey: string;
  features: {
    tier: number;
    apiAccess: boolean;
    apiRateLimit: number;
    maxDashboards: number;
    prioritySupport: boolean;
    exportFormats: string[];
    /**
     * Pro MCP access (plan 2026-05-10-001). Undefined on legacy entitlement
     * rows written before the catalog field landed; every consumer
     * (gateway HMAC verifier, isCallerPremium, MCP edge handler) treats
     * undefined as `false` — fail-closed. The Dodo webhook repopulates
     * this on the next subscription event.
     */
    mcpAccess?: boolean;
    /**
     * Per-account daily REST allowance (#3199). The rate-limit layer meters
     * but never rejects at this value; the hard ceiling is 10×. `-1` =
     * unlimited. Unlike `mcpAccess`, consumers treat `undefined` as
     * **no daily limit (fail-OPEN)** — a stale/legacy cache must not punish
     * a paying customer. NOT added to the cache-staleness gate below for
     * that reason (forcing a re-fetch would contradict fail-open).
     */
    apiDailyAllowance?: number;
  };
  validUntil: number;
  billingStatus?: BillingVerificationStatus;
  retryAfterSeconds?: number;
  renewalVerificationFreshness?: {
    status: 'not_applicable';
    checkedAt: number;
  };
  // Synthesized by getEntitlements() when the backend lookup failed
  // TRANSIENTLY (fetch abort at the 3s budget — which the #4770 on-demand
  // provider re-check can consume — network error, Convex 5xx): a free-shaped,
  // deny-side value that getBillingVerificationDenial turns into the retryable
  // entitlement_verification_unavailable 503 instead of a hard "upgrade
  // required"/401. Never originates from Convex and is never written to the
  // Redis cache. A null return now means the backend is unconfigured or gave a
  // confirmed/malformed answer — callers keep their fail-closed posture there.
  verificationUnavailable?: true;
}

export interface EntitlementCheckResult {
  response: Response | null;
  entitlements: CachedEntitlements | null;
}

export interface EntitlementCheckOptions {
  clerkRole?: 'free' | 'pro' | null;
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
  '/api/forecast/v1/trigger-simulation': 1,
  '/api/intelligence/v1/classify-event': 1,
  '/api/intelligence/v1/get-country-intel-brief': 1,
  '/api/market/v1/analyze-stock': 1,
  '/api/market/v1/get-stock-analysis-history': 1,
  '/api/market/v1/backtest-stock': 1,
  '/api/market/v1/list-stored-stock-backtests': 1,
  '/api/economic/v1/list-global-tenders': 1,
  '/api/sanctions/v1/list-sanctions-pressure': 1,
  '/api/scenario/v1/run-scenario': 1,
  '/api/scenario/v1/get-scenario-status': 1,
  '/api/supply-chain/v1/get-country-chokepoint-index': 1,
  '/api/supply-chain/v1/get-bypass-options': 1,
  '/api/supply-chain/v1/get-country-cost-shock': 1,
  '/api/supply-chain/v1/get-route-explorer-lane': 1,
  '/api/supply-chain/v1/get-route-impact': 1,
  '/api/supply-chain/v1/get-country-products': 1,
  '/api/supply-chain/v1/get-multi-sector-cost-shock': 1,
  '/api/supply-chain/v1/get-sector-dependency': 1,
  '/api/trade/v1/list-comtrade-flows': 1,
  '/api/trade/v1/get-tariff-trends': 1,
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
// Hard-403 markers are served for their FULL Redis TTL with no Convex
// fallback, so this TTL is also the worst-case wrongful-denial window when a
// stale marker write races a renewal webhook. Keep it short: the row-level
// 5-min lapsed cooldown (billing.ts) already suppresses Dodo calls, so the
// only cost of a short marker is ~1 cheap Convex round-trip per minute per
// actively-retrying lapsed user.
const LAPSED_BILLING_MARKER_TTL_SECONDS = 60;
// No-billing-history is structurally invariant while tier stays 0, and every
// tier-changing write path unconditionally overwrites this cache key via
// syncEntitlementCache — so a longer marker cannot delay a new subscription
// from taking effect (invariant re-audited in the fresh review round). Full
// 900s restores pre-#4770 cache economics for the never-subscribed cohort,
// the bulk of tier-0 traffic; short/dynamic TTLs stay reserved for the
// genuinely uncertain lapsed/pending/failed states.
const NOT_APPLICABLE_VERIFICATION_TTL_SECONDS = 900;

/**
 * True when the Convex entitlement backend is reachable in principle. Callers
 * that fail closed on a null entitlement use this to distinguish a genuine
 * verification failure (fail closed) from a deploy misconfiguration where no
 * lookup could ever succeed (fail open + page).
 */
export function isEntitlementBackendConfigured(): boolean {
  return Boolean(process.env.CONVEX_SITE_URL && getConvexSharedSecret());
}

function clampRetryAfterSeconds(raw: number | undefined): number {
  return Number.isFinite(raw)
    ? Math.max(1, Math.min(60, Math.ceil(raw!)))
    : 5;
}

function isBillingVerificationStatus(
  value: unknown,
): value is NonNullable<CachedEntitlements['billingStatus']> {
  return value === 'subscription_lapsed'
    || value === 'renewal_verification_pending'
    || value === 'renewal_verification_failed';
}

function billingMarkerTtlSeconds(entitlements: CachedEntitlements): number | null {
  if (!isBillingVerificationStatus(entitlements.billingStatus)) return null;
  if (entitlements.billingStatus === 'subscription_lapsed') {
    return LAPSED_BILLING_MARKER_TTL_SECONDS;
  }
  return clampRetryAfterSeconds(entitlements.retryAfterSeconds);
}

function notApplicableVerificationTtlSeconds(
  entitlements: CachedEntitlements,
): number | null {
  const marker = entitlements.renewalVerificationFreshness;
  if (
    marker?.status !== 'not_applicable'
    || !Number.isFinite(marker.checkedAt)
  ) {
    return null;
  }
  const remainingMs = marker.checkedAt
    + NOT_APPLICABLE_VERIFICATION_TTL_SECONDS * 1_000
    - Date.now();
  return remainingMs > 0
    ? Math.max(1, Math.min(
      NOT_APPLICABLE_VERIFICATION_TTL_SECONDS,
      Math.ceil(remainingMs / 1_000),
    ))
    : null;
}

function entitlementMarkerTtlSeconds(entitlements: CachedEntitlements): number | null {
  return billingMarkerTtlSeconds(entitlements)
    ?? notApplicableVerificationTtlSeconds(entitlements);
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

// Free-shaped deny-side value for transient lookup failures. Grants nothing
// (tier 0, no apiAccess/mcpAccess, validUntil 0); its only power is steering
// the gates to the retryable 503 via getBillingVerificationDenial.
function unavailableEntitlements(): CachedEntitlements {
  return {
    planKey: 'free',
    features: {
      tier: 0,
      apiAccess: false,
      apiRateLimit: 0,
      maxDashboards: 3,
      prioritySupport: false,
      exportFormats: ['csv'],
      mcpAccess: false,
    },
    validUntil: 0,
    verificationUnavailable: true,
  };
}

async function _getEntitlementsImpl(userId: string): Promise<CachedEntitlements | null> {
  try {
    // Redis cache check (raw=true: entitlements use user-scoped keys, no deployment prefix)
    const cached = await getCachedJson(`entitlements:${ENV_PREFIX}:${userId}`, true);

    if (cached && typeof cached === 'object') {
      const ent = cached as CachedEntitlements;
      // Verification markers have their own short Redis TTL. Serve them even
      // though validUntil is expired so cooldown requests stop at Redis instead
      // of repeating the Convex action/claim chain.
      if (entitlementMarkerTtlSeconds(ent) !== null) return ent;
      // Only use cached data if it hasn't expired AND has the post-U10 shape.
      //
      // Legacy cache entries written before plan 2026-05-10-001 U10 lack the
      // `features.mcpAccess` field. The Convex read path read-time-merges
      // catalog defaults (convex/entitlements.ts:50), but bare-cache reads
      // bypass that merge — paying users with hot pre-deploy cache entries
      // would see `mcpAccess !== true` at the grant/MCP gates and get
      // blocked for up to 15 min until the cache expires. Treating
      // missing-field cache entries as stale falls through to Convex,
      // which returns the merged shape and rewrites the cache with the
      // post-U10 layout. Self-healing, bounded to one extra Convex
      // round-trip per affected user during the migration window.
      // Reviewer round-2 P2 (cache layer).
      if (
        ent.validUntil >= Date.now() &&
        typeof (ent.features as { mcpAccess?: boolean }).mcpAccess === 'boolean'
      ) {
        return ent;
      }
      // Expired OR legacy shape -- fall through to Convex.
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
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      // 5xx = Convex/platform blip -> retryable-503 posture at the gates.
      // 4xx (bad shared secret, contract rejection) = deploy defect, not a
      // transient: keep the fail-closed null so callers hold the hard posture.
      return response.status >= 500 ? unavailableEntitlements() : null;
    }
    const result = await response.json() as CachedEntitlements | null;

    if (result) {
      // Populate Redis cache for subsequent requests (15-min TTL, raw key).
      //
      // Cache-write failures must NOT collapse "entitlement confirmed by Convex"
      // into the null-means-no-entitlement return. Today setCachedJson swallows
      // its own Upstash errors via an internal try/catch (server/_shared/redis.ts),
      // but that contract is fragile — the tauri-sidecar dynamic import path at
      // redis.ts:142-146 is OUTSIDE the inner try/catch, and any future code
      // motion could let other errors propagate. Wrap explicitly here so the
      // property "Convex said yes ⇒ caller sees yes" is local and load-bearing.
      // Without this, an Upstash hiccup would 403 every paying customer on the
      // very call paths this file gates — the same shape PR #3505 fixed for the
      // Clerk-only-no-Convex outlier in api/widget-agent.ts.
      try {
        await setCachedJson(
          `entitlements:${ENV_PREFIX}:${userId}`,
          result,
          entitlementMarkerTtlSeconds(result) ?? ENTITLEMENT_CACHE_TTL_SECONDS,
          true,
        );
      } catch (cacheErr) {
        console.warn('[entitlement-check] cache write failed (non-fatal):', cacheErr instanceof Error ? cacheErr.message : String(cacheErr));
      }
      return result as CachedEntitlements;
    }

    return null;
  } catch (err) {
    // Still fail-closed — nothing is granted — but a TRANSIENT failure
    // (timeout/abort, network, a throwing cache read) is distinguishable from
    // "no entitlement": return the verificationUnavailable marker so every
    // gate answers with the retryable entitlement_verification_unavailable
    // 503 (Retry-After) instead of a misleading hard 403/401. Without this,
    // the on-demand provider re-check (#4770) overrunning the 3s fetch budget
    // reproduced exactly the hard-denial the rework exists to eliminate.
    console.warn('[entitlement-check] getEntitlements failed:', err instanceof Error ? err.message : String(err));
    return unavailableEntitlements();
  }
}

/**
 * Turns Convex's billing-verification metadata into the shared gateway denial
 * contract. Callers use this before their ordinary tier/feature checks so a
 * provider outage is never flattened into a misleading "upgrade required".
 */
export function getBillingVerificationDenial(
  entitlements: Pick<CachedEntitlements, 'billingStatus' | 'retryAfterSeconds' | 'verificationUnavailable'> | null | undefined,
  corsHeaders: Record<string, string>,
  requiredTier?: number,
): Response | null {
  if (entitlements?.verificationUnavailable) {
    // Transient lookup failure: same wire contract as server/gateway.ts's
    // wm_-key null-entitlement branch (docs/usage-errors.mdx).
    return new Response(
      JSON.stringify({
        error: 'Unable to verify API access',
        code: 'entitlement_verification_unavailable',
        ...(requiredTier == null ? {} : { requiredTier }),
      }),
      {
        status: 503,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-Billing-Verification': 'entitlement_verification_unavailable',
          'Retry-After': String(clampRetryAfterSeconds(entitlements.retryAfterSeconds)),
          ...corsHeaders,
        },
      },
    );
  }

  const status = entitlements?.billingStatus;
  if (!isBillingVerificationStatus(status)) return null;

  const commonHeaders = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Billing-Verification': status,
    ...corsHeaders,
  };
  const requiredTierBody = requiredTier == null ? {} : { requiredTier };

  if (status === 'subscription_lapsed') {
    return new Response(
      JSON.stringify({
        error: 'Subscription lapsed',
        code: status,
        ...requiredTierBody,
      }),
      { status: 403, headers: commonHeaders },
    );
  }

  const retryAfter = clampRetryAfterSeconds(entitlements?.retryAfterSeconds);
  return new Response(
    JSON.stringify({
      error: status === 'renewal_verification_pending'
        ? 'Renewal verification pending'
        : 'Renewal verification failed',
      code: status,
      ...requiredTierBody,
    }),
    {
      status: 503,
      headers: { ...commonHeaders, 'Retry-After': String(retryAfter) },
    },
  );
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
  userId: string | null,
  pathname: string,
  corsHeaders: Record<string, string>,
  options: EntitlementCheckOptions = {},
): Promise<Response | null> {
  const result = await checkEntitlementDetailed(userId, pathname, corsHeaders, options);
  return result.response;
}

/**
 * Same authorization decision as checkEntitlement(), plus the resolved
 * entitlement row when one was available. Gateway telemetry uses this so
 * allow/deny events reflect the exact plan/tier that drove the decision.
 */
export async function checkEntitlementDetailed(
  userId: string | null,
  pathname: string,
  corsHeaders: Record<string, string>,
  options: EntitlementCheckOptions = {},
): Promise<EntitlementCheckResult> {
  const requiredTier = getRequiredTier(pathname);
  if (requiredTier === null) {
    // Unrestricted endpoint -- no check needed
    return { response: null, entitlements: null };
  }

  if (!userId) {
    return {
      response: new Response(
        JSON.stringify({ error: 'Authentication required', requiredTier }),
        { status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
      ),
      entitlements: null,
    };
  }

  // Preserve the legacy Pro bearer contract for tier-1 gates. Complimentary,
  // tester, and legacy Clerk-role grants can have no Convex entitlement row,
  // while the frontend still unlocks Pro panels for role='pro'.
  if (options.clerkRole === 'pro' && requiredTier <= 1) {
    return { response: null, entitlements: null };
  }

  const ent = await getEntitlements(userId);
  if (!ent) {
    // Fail-closed: unable to verify entitlements -> block the request
    return {
      response: new Response(
        JSON.stringify({ error: 'Unable to verify entitlements', requiredTier }),
        { status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
      ),
      entitlements: null,
    };
  }

  // A stronger recently-stale subscription can be under verification while a
  // lower plan still provides current, known-good coverage. Let that fallback
  // authorize requests within its tier; the billing marker remains relevant
  // only to capabilities above the fallback.
  if (
    ent.features.tier >= requiredTier &&
    ent.validUntil >= Date.now()
  ) {
    return { response: null, entitlements: ent };
  }

  const billingDenial = getBillingVerificationDenial(ent, corsHeaders, requiredTier);
  if (billingDenial) {
    return { response: billingDenial, entitlements: ent };
  }

  // User lacks required tier -- return 403
  return {
    response: new Response(
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
    ),
    entitlements: ent,
  };
}
