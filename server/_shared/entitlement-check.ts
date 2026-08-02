/**
 * Entitlement enforcement middleware for the Vercel API gateway.
 *
 * Reads cached entitlements from Redis (raw keys, no deployment prefix) with
 * Convex fallback on cache miss. Returns a 403 Response for tier-gated endpoints
 * when the user lacks the required tier.
 *
 * Fail-closed behavior of checkEntitlement():
 *   - No userId header on a gated endpoint -> 403 (authentication required)
 *   - Redis miss + Convex failure -> 403 (unable to verify entitlements)
 *   - Endpoint not in ENDPOINT_ENTITLEMENTS -> allow (unrestricted)
 *
 * A lookup that was attempted but produced no answer — Redis/Convex failure,
 * Convex 5xx, or a Convex 4xx that means our own credential is wrong — returns a
 * verificationUnavailable marker so callers answer with a retryable 503 instead
 * of a misleading hard denial. A null means either that no lookup was attempted
 * (backend unconfigured) or that Convex confirmed the user has no entitlement.
 * The user-key gateway fails closed on null when the backend is configured and
 * retains a logged fail-open exception only when lookup is wholly unconfigured.
 *
 * classifyBillingVerification() is the single decision point for that denial;
 * getBillingVerificationDenial() renders it as JSON, and the HTML / OAuth-grant
 * / boolean-premium surfaces render the same decision in their own vocabulary
 * (#5622). A transient answer is negative-cached in-process for a few seconds so
 * a backend outage costs one lookup per user per window, not one per request.
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
     * Per-account daily REST allowance (#3199). The rate-limit layer
     * hard-rejects (in enforce mode) at this value (#4635). `-1` =
     * unlimited. Unlike `mcpAccess`, consumers treat `undefined` as
     * **no daily limit (fail-OPEN)** — a stale/legacy cache must not punish
     * a paying customer. NOT added to the cache-staleness gate below for
     * that reason (forcing a re-fetch would contradict fail-open).
     */
    apiDailyAllowance?: number;
    /**
     * Data-export entitlement (plan 2026-07-25-001) — the enforcement field
     * for CSV/JSON/PDF export. Like `apiDailyAllowance` and unlike
     * `mcpAccess`, consumers treat `undefined` on a `tier >= 2` row as
     * **entitled (fail-OPEN)**, and deliberately NOT added to the
     * cache-staleness gate below — which is exactly why that fail-open is
     * permanent rather than a migration window.
     */
    dataExport?: boolean;
    /**
     * Catalog plan limits, mirrored verbatim from `PlanFeatures.planLimits`
     * (convex/config/productCatalog.ts). Optional because legacy rows predate
     * it and because the Convex read path only merges what the catalog holds.
     * `null` on a member means **unlimited**; a MISSING member (or a missing
     * `planLimits` altogether) means unknown, and consumers resolve unknown
     * toward cost protection — never toward the higher allowance. The MCP
     * daily quota (plan 2026-07-25-001 U3) is the first consumer.
     */
    planLimits?: {
      apiRequestsPerDay?: number | null;
      apiBurstRequestsPerMinute?: number | null;
      mcpCallsPerDay?: number | null;
      mcpBurstRequestsPerMinute?: number | null;
    };
  };
  validUntil: number;
  billingStatus?: BillingVerificationStatus;
  retryAfterSeconds?: number;
  renewalVerificationFreshness?: {
    status: 'not_applicable';
    checkedAt: number;
  };
  // Synthesized by getEntitlements() when a lookup was ATTEMPTED and produced
  // no answer about this user: a fetch abort at the 3s budget (which the #4770
  // on-demand provider re-check can consume), a network error, a Convex 5xx, or
  // a Convex 4xx (#5619 — our own shared secret or contract is wrong, which
  // says nothing about the caller's plan). A free-shaped, deny-side value that
  // getBillingVerificationDenial turns into the retryable
  // entitlement_verification_unavailable 503 instead of a hard "upgrade
  // required"/401. Never originates from Convex and is never written to the
  // Redis cache (it IS held for a few seconds in the in-process negative cache
  // below, which bounds outage amplification without making the state durable
  // or visible to another isolate).
  //
  // A null return therefore means one of exactly two things: the backend is
  // unconfigured so no lookup was attempted (server/gateway.ts detects that
  // with isEntitlementBackendConfigured() and keeps its wm_-key fail-open
  // exception), or Convex answered and this user has no entitlement row — a
  // confirmed free account, which is the one state that may honestly upsell.
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
  '/api/intelligence/v1/search-intel-history': 1,
  '/api/intelligence/v1/get-intel-timeline': 1,
  '/api/intelligence/v1/get-similar-events': 1,
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
let _didWarnMissingConvexSiteUrl = false;

function getConvexSharedSecret(): string {
  const secret = process.env.CONVEX_SERVER_SHARED_SECRET ?? '';
  if (!secret && !_didWarnMissingConvexSharedSecret) {
    _didWarnMissingConvexSharedSecret = true;
    console.warn('[entitlement-check] CONVEX_SERVER_SHARED_SECRET not set; Convex fallback disabled');
  }
  return secret;
}

/**
 * Warn once when CONVEX_SITE_URL is missing. Its sibling above covered only the
 * shared secret, so a deploy missing ONLY the site URL disabled the Convex
 * fallback with no signal from this module. The warning keeps that deployment
 * defect visible alongside the gateway's explicit unconfigured-backend log.
 */
function getConvexSiteUrl(): string {
  const siteUrl = process.env.CONVEX_SITE_URL ?? '';
  if (!siteUrl && !_didWarnMissingConvexSiteUrl) {
    _didWarnMissingConvexSiteUrl = true;
    console.warn('[entitlement-check] CONVEX_SITE_URL not set; Convex fallback disabled');
  }
  return siteUrl;
}

// ---------------------------------------------------------------------------
// Request coalescing (P1-6: Cache stampede mitigation)
// ---------------------------------------------------------------------------

const _inFlight = new Map<string, Promise<CachedEntitlements | null>>();

// ---------------------------------------------------------------------------
// Transient-failure negative cache (#5622)
// ---------------------------------------------------------------------------

/**
 * How long a synthesized verificationUnavailable answer is reused for the same
 * user without re-attempting the backend.
 *
 * The problem this bounds: a transient answer was never cached anywhere.
 * `unavailableEntitlements()` is synthesized in-process and deliberately never
 * written to Redis, so during a Convex outage EVERY request re-ran the lookup
 * and paid the full 3s fetch budget before producing the identical denial.
 * Request coalescing (`_inFlight` above) only collapses *concurrent* requests;
 * a client politely retrying in sequence amplified the outage instead. Bounding
 * the tier-0 marker to 60s in #5600 made this path more reachable.
 *
 * The value is load-bearing, not arbitrary: it MUST stay strictly below the
 * `Retry-After` that getBillingVerificationDenial advertises for this state
 * (clampRetryAfterSeconds's 5s default, since the synthesized marker carries no
 * retryAfterSeconds). Otherwise a client that correctly honors `Retry-After`
 * would land back inside the window and be served the cached failure — turning
 * a bounded outage into one that outlives it. The negative-cache test pins that
 * inequality so raising this constant past the advertised delay fails.
 */
const UNAVAILABLE_NEGATIVE_CACHE_TTL_MS = 3_000;

/**
 * Cap on distinct users held in the negative cache. A fleet-wide Convex outage
 * would otherwise grow this map with one entry per active user for the life of
 * the isolate; entries are ~40 bytes, so the cap is about memory hygiene rather
 * than a real ceiling. Eviction drops expired entries first, then the oldest
 * insertions (Map preserves insertion order), so overflow degrades to the
 * pre-#5622 behavior (an extra lookup) rather than to unbounded growth.
 */
const UNAVAILABLE_NEGATIVE_CACHE_MAX_ENTRIES = 1_000;

/**
 * userId -> when the cached transient failure expires, plus any upstream-supplied
 * cooldown that produced it.
 *
 * `retryAfterSeconds` rides along because the cache HIT re-synthesizes the
 * marker rather than storing it: without this, a 429's own Retry-After would be
 * honored on the first response and silently downgraded to the generic default
 * for every hit inside the window — sending clients back at the upstream sooner
 * than it asked, which is the amplification the header exists to prevent.
 */
const _unavailableUntil = new Map<string, { expiresAt: number; retryAfterSeconds?: number }>();

function rememberVerificationUnavailable(userId: string, retryAfterSeconds?: number): void {
  const now = Date.now();
  if (_unavailableUntil.size >= UNAVAILABLE_NEGATIVE_CACHE_MAX_ENTRIES) {
    for (const [key, entry] of _unavailableUntil) {
      if (entry.expiresAt <= now) _unavailableUntil.delete(key);
    }
    while (_unavailableUntil.size >= UNAVAILABLE_NEGATIVE_CACHE_MAX_ENTRIES) {
      const oldest = _unavailableUntil.keys().next();
      if (oldest.done) break;
      _unavailableUntil.delete(oldest.value);
    }
  }
  _unavailableUntil.set(userId, {
    expiresAt: now + UNAVAILABLE_NEGATIVE_CACHE_TTL_MS,
    retryAfterSeconds,
  });
}

/**
 * Module state is per-isolate and survives between tests in the same file.
 * Exposed so a test can assert the negative cache both hits AND expires without
 * depending on which userIds earlier tests happened to poison.
 */
export function __resetEntitlementNegativeCacheForTests(): void {
  _unavailableUntil.clear();
}

/** Test-only view of the advertised-retry invariant the TTL above depends on. */
export const __negativeCacheTtlMsForTests = UNAVAILABLE_NEGATIVE_CACHE_TTL_MS;

/**
 * Test-only view of the cap and the live entry count, so the eviction branch can
 * be driven past its threshold and asserted bounded. Without these the cap is
 * unreachable from a test — the branch only fires above 1000 distinct
 * concurrently-failing users, which is exactly the fleet-wide-outage case whose
 * memory behavior the cap exists to bound.
 */
export const __negativeCacheMaxEntriesForTests = UNAVAILABLE_NEGATIVE_CACHE_MAX_ENTRIES;
export function __negativeCacheSizeForTests(): number {
  return _unavailableUntil.size;
}

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
// Convex stamps the not-applicable marker ONLY for a user with zero
// subscription rows (convex/payments/billing.ts
// claimRecentlyStaleSubscriptionForVerification: no billing history ->
// not_applicable, any history -> lapsed). "No history" is therefore not the
// stable state the previous 900s assumed: it is also what a buyer looks like
// in the seconds between checkout return and the Dodo webhook landing.
//
// The "syncEntitlementCache always overwrites this key" invariant does NOT
// close that window — the read path is not atomic. A request that misses cache
// at t0 can have its stale free+marker payload land in Redis AFTER the
// webhook's Pro write at t0+ε, re-poisoning the key for the marker's full TTL
// (#5600: 15 min of 403s on every tier-gated endpoint for a paying customer,
// reproduced live 2026-07-25). Bounding the marker bounds that worst case.
//
// Be precise about WHICH window this bounds, because it is not the whole one a
// buyer experiences:
//
//   wrongful-403 window = dodo_webhook_latency + min(this TTL, resync residual)
//
// Only the second term is bounded here. convex/http.ts re-stamps a fresh
// not_applicable marker on every fallback for as long as the user has zero
// subscription rows, so an expiry just mints another window — the buyer waits out
// the webhook either way, just re-checking every 60s instead of every 900s.
// And the second term is usually already covered: convex/payments/
// subscriptionHelpers.ts schedules resyncEntitlementCacheFromDb at
// ENTITLEMENT_CACHE_RESYNC_DELAY_MS (15s), a quarter of this TTL, which corrects a
// poisoned key first in the common case. This TTL is the bound for when that
// re-sync also loses the race or throws (it is fire-and-forget, no retry). Raising
// that delay past this TTL silently promotes this constant to sole defense.
//
// The cost is one extra Convex round-trip per minute per actively-requesting
// never-subscribed user — still far cheaper than pre-#4770, where a tier-0
// answer was never served from cache at all (free rows carry validUntil: 0,
// so the ordinary freshness gate below always fell through).
const NOT_APPLICABLE_VERIFICATION_TTL_SECONDS = 60;

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
 * Every tier-gated pathname, as a set.
 *
 * Exported so tests/premium-paths-guard.test.mts can enforce that this map
 * stays a subset of PREMIUM_RPC_PATHS — an invariant src/services/premium-fetch.ts
 * documents and depends on, but which nothing checked before #5674. The gateway
 * sets `forceKey` on tier-gated routes, and forceKey rejects a valid anonymous
 * wms_ token with 401, so a route added here but not there 401s every anonymous
 * browser call and drives the wm-session interceptor into its mint→replay→
 * 15-minute-blackout loop. The map itself stays private so it keeps its single
 * point of edit.
 */
export const TIER_GATED_PATHS: ReadonlySet<string> = new Set(Object.keys(ENDPOINT_ENTITLEMENTS));

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
  // Negative cache first: a transient failure recorded moments ago is reused
  // rather than re-paying the backend's 3s budget. Only the synthesized
  // verificationUnavailable answer is cached here — never a confirmed row and
  // never a fail-closed null, both of which have their own (Redis) cache policy.
  const unavailable = _unavailableUntil.get(userId);
  if (unavailable !== undefined) {
    if (unavailable.expiresAt > Date.now()) {
      return unavailableEntitlements(unavailable.retryAfterSeconds);
    }
    _unavailableUntil.delete(userId);
  }

  const existing = _inFlight.get(userId);
  if (existing) return existing;

  const promise = _getEntitlementsImpl(userId);
  _inFlight.set(userId, promise);
  try {
    const result = await promise;
    if (result?.verificationUnavailable) {
      rememberVerificationUnavailable(userId, result.retryAfterSeconds);
    }
    return result;
  } finally {
    _inFlight.delete(userId);
  }
}

// Free-shaped deny-side value for transient lookup failures. Grants nothing
// (tier 0, no apiAccess/mcpAccess, validUntil 0); its only power is steering
// the gates to the retryable 503 via getBillingVerificationDenial.
//
// `retryAfterSeconds` is optional and only supplied when the upstream told us
// how long to wait (a 429's own Retry-After). Omitted, the denial constructors
// fall back to the generic clamp default, which is the behavior every other
// failure mode here wants.
function unavailableEntitlements(retryAfterSeconds?: number): CachedEntitlements {
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
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

/**
 * Parse an HTTP `Retry-After` header into seconds.
 *
 * Only the delta-seconds form is honored. The HTTP-date form is legal but
 * Convex does not emit it, and guessing at clock skew to support it would be
 * worse than falling back to the caller's default.
 */
function parseRetryAfterSeconds(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
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
    const convexSiteUrl = getConvexSiteUrl();
    const convexSharedSecret = getConvexSharedSecret();
    // MISCONFIGURATION HAZARD: a deploy missing CONVEX_SITE_URL or
    // CONVEX_SERVER_SHARED_SECRET returns null for every user on every request.
    // The gateway recognizes that configuration state and logs before using its
    // explicit fail-open deploy-defect exception; other entitlement gates remain
    // fail closed. Warn once per variable here so neither missing value is silent.
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
      // Neither a 5xx (Convex/platform blip) nor a 4xx (bad shared secret,
      // contract rejection) produced an answer about this user, so neither may
      // reach the wire as one.
      //
      // #5661 split them — 4xx returned the fail-closed null on the reasoning
      // that a deploy defect is not transient. True, but "not transient" and
      // "is a verdict about this account's plan" are different axes, and the
      // gates only read the second: a null renders as `pro_required` /
      // INSUFFICIENT_TIER, i.e. an upsell shown to a paying customer because
      // OUR credential is wrong (#5619, the #5600 failure mode). The marker
      // denies exactly as hard — tier 0, nothing granted — and only changes the
      // wording to the retryable contract, which is already what
      // server/gateway.ts answers for this state on wm_-key traffic. A client
      // that keeps retrying spends its transient budget and lands on `give_up`:
      // still terminal, still not an upsell.
      //
      // A 429 is the one status that tells us how long to wait. Re-advertising
      // the generic 5s default would send clients back inside the upstream's
      // own cooldown and amplify the throttling we were just asked to ease, so
      // its Retry-After rides along on the marker.
      return unavailableEntitlements(
        response.status === 429
          ? parseRetryAfterSeconds(response.headers.get('Retry-After'))
          : undefined,
      );
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

/** Entitlement fields the billing-verification decision reads. */
export type BillingVerificationInput = Pick<
  CachedEntitlements,
  'billingStatus' | 'retryAfterSeconds' | 'verificationUnavailable'
>;

/** Wire code for a billing-verification denial, mirrored into `X-Billing-Verification`. */
export type BillingVerificationCode =
  | BillingVerificationStatus
  | 'entitlement_verification_unavailable';

export function isBillingVerificationCode(
  value: unknown,
): value is BillingVerificationCode {
  return value === 'entitlement_verification_unavailable'
    || isBillingVerificationStatus(value);
}

export interface BillingVerificationDenial {
  /**
   * False ONLY for a lapse the provider confirmed. Everything else in this
   * union is a statement about the *verification*, not the subscription, so a
   * caller that renders it as terminal reproduces #5600.
   */
  retryable: boolean;
  code: BillingVerificationCode;
  /** Seconds to wait before retrying. 0 for a terminal denial. */
  retryAfterSeconds: number;
  /** Wire `error` string for JSON surfaces. */
  message: string;
  /** HTTP status the JSON surfaces use: 503 when retryable, 403 when terminal. */
  status: 403 | 503;
}

/**
 * The "we could not verify" denial, built in ONE place.
 *
 * Two situations produce it and they must not drift apart on the wire: the
 * synthesized `verificationUnavailable` marker below, and a caller that already
 * knows no lookup could have answered — `getEntitlements` returns null WITHOUT
 * attempting one when the backend is unconfigured, so an absent row there is a
 * deploy defect rather than a verdict about the account (#5619).
 */
export function unverifiableEntitlementDenial(
  retryAfterSeconds?: number,
): BillingVerificationDenial {
  return {
    retryable: true,
    code: 'entitlement_verification_unavailable',
    retryAfterSeconds: clampRetryAfterSeconds(retryAfterSeconds),
    message: 'Unable to verify API access',
    status: 503,
  };
}

/**
 * The billing-verification decision, as a pure predicate over an entitlement
 * row — no Response, no headers, no transport.
 *
 * Extracted from getBillingVerificationDenial (#5622) because three consumers
 * cannot use a `Response`: `api/oauth/authorize-pro.ts` renders HTML,
 * `api/internal/mcp-grant-{mint,context}.ts` own an `INSUFFICIENT_TIER`-style
 * vocabulary inside an OAuth handshake, and `server/_shared/premium-check.ts`
 * answers with a boolean/identity. Before this existed each of them flattened
 * an *unverifiable* entitlement into a hard denial, which is exactly the #5600
 * failure mode the shared contract was built to remove.
 *
 * Keep this the single decision point: getBillingVerificationDenial below is a
 * thin renderer over it, so a new status cannot reach the JSON surfaces and
 * silently miss the HTML/handshake ones.
 */
export function classifyBillingVerification(
  entitlements: BillingVerificationInput | null | undefined,
): BillingVerificationDenial | null {
  if (entitlements?.verificationUnavailable) {
    // Lookup failure: same wire contract as server/gateway.ts's wm_-key
    // null-entitlement branch (docs/usage-errors.mdx).
    return unverifiableEntitlementDenial(entitlements.retryAfterSeconds);
  }

  const status = entitlements?.billingStatus;
  if (!isBillingVerificationStatus(status)) return null;

  if (status === 'subscription_lapsed') {
    // The ONLY terminal member: the provider confirmed coverage ended, so
    // retrying cannot flip it (tests/premium-denial.test.mts pins the same
    // reading on the client side).
    return {
      retryable: false,
      code: status,
      retryAfterSeconds: 0,
      message: 'Subscription lapsed',
      status: 403,
    };
  }

  return {
    retryable: true,
    code: status,
    retryAfterSeconds: clampRetryAfterSeconds(entitlements?.retryAfterSeconds),
    message: status === 'renewal_verification_pending'
      ? 'Renewal verification pending'
      : 'Renewal verification failed',
    status: 503,
  };
}

/**
 * Turns Convex's billing-verification metadata into the shared gateway denial
 * contract. Callers use this before their ordinary tier/feature checks so a
 * provider outage is never flattened into a misleading "upgrade required".
 *
 * JSON surfaces only. Non-JSON consumers call classifyBillingVerification()
 * above and render the decision in their own vocabulary.
 */
export function getBillingVerificationDenial(
  entitlements: BillingVerificationInput | null | undefined,
  corsHeaders: Record<string, string>,
  requiredTier?: number,
): Response | null {
  const denial = classifyBillingVerification(entitlements);
  return denial ? renderBillingVerificationDenial(denial, corsHeaders, requiredTier) : null;
}

/**
 * Renders an ALREADY-classified denial as the JSON wire contract.
 *
 * Split out from getBillingVerificationDenial for callers that classified
 * earlier and carry the decision with them — `server/_shared/premium-check.ts`
 * attaches it to the denied identity, and api/chat-analyst.ts renders that.
 * Before this existed, that route hand-built `{ verificationUnavailable: true }`
 * to re-enter the classifier, which collapsed all four states into one.
 */
export function renderBillingVerificationDenial(
  denial: BillingVerificationDenial,
  corsHeaders: Record<string, string>,
  requiredTier?: number,
): Response {
  return new Response(
    JSON.stringify({
      error: denial.message,
      code: denial.code,
      ...(requiredTier == null ? {} : { requiredTier }),
    }),
    {
      status: denial.status,
      headers: {
        // corsHeaders FIRST: the contract headers below are this function's own
        // output and must win. The pre-#5622 version was inconsistent about it
        // (a corsHeaders map could clobber X-Billing-Verification but not
        // Retry-After); no cors helper in the repo emits either name, so this is
        // inert today and pinned by test so it stays that way.
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Billing-Verification': denial.code,
        // Terminal denials carry no Retry-After — advertising one would invite
        // a lapsed subscriber into an infinite retry instead of a resubscribe.
        ...(denial.retryable ? { 'Retry-After': String(denial.retryAfterSeconds) } : {}),
      },
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
    // An absent row is a verdict about the account only when a lookup could
    // actually run. With the backend unconfigured getEntitlements returns null
    // BEFORE attempting one — for everyone, paying customers included — so the
    // hard 403 below would tell every subscriber their entitlement could not be
    // verified because of our own deploy defect. This gate is reached from
    // server/gateway.ts on every tier-gated session request, which makes it the
    // widest surface of the #5619 asymmetry (#5600 is the precedent).
    if (!isEntitlementBackendConfigured()) {
      return {
        response: renderBillingVerificationDenial(
          unverifiableEntitlementDenial(),
          corsHeaders,
          requiredTier,
        ),
        entitlements: null,
      };
    }
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
