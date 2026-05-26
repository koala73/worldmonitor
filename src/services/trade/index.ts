/**
 * Trade policy intelligence service.
 * WTO MFN baselines, trade flows/barriers, and US customs/effective tariff context.
 */

import { getRpcBaseUrl } from '@/services/rpc-client';
import { premiumFetch } from '@/services/premium-fetch';
import { getCurrentClerkUser } from '@/services/clerk';
import { hasPremiumAccess } from '@/services/panel-gating';
import { onEntitlementChange } from '@/services/entitlements';
import { IS_EMBEDDED_PREVIEW } from '@/utils/embedded-preview';
import {
  TradeServiceClient,
  type GetTradeRestrictionsResponse,
  type GetTariffTrendsResponse,
  type GetTradeFlowsResponse,
  type GetTradeBarriersResponse,
  type GetCustomsRevenueResponse,
  type ListComtradeFlowsResponse,
  type ComtradeFlowRecord,
  type TradeRestriction,
  type TariffDataPoint,
  type EffectiveTariffRate,
  type TradeFlowRecord,
  type TradeBarrier,
  type CustomsRevenueMonth,
} from '@/generated/client/worldmonitor/trade/v1/service_client';
import { createCircuitBreaker } from '@/utils';
import { isFeatureAvailable } from '../runtime-config';
import { getHydratedData } from '@/services/bootstrap';

// Re-export types for consumers
export type { TradeRestriction, TariffDataPoint, EffectiveTariffRate, TradeFlowRecord, TradeBarrier, CustomsRevenueMonth, ComtradeFlowRecord };
export type {
  GetTradeRestrictionsResponse,
  GetTariffTrendsResponse,
  GetTradeFlowsResponse,
  GetTradeBarriersResponse,
  GetCustomsRevenueResponse,
  ListComtradeFlowsResponse,
};

// Two clients to prevent cross-entitlement cache leakage.
//
// The breakers below use `persistCache: true` and auth-invariant cache
// keys — once a response lands in the cache it's served to any future
// session on the same browser without re-authenticating. Routing
// premium-backed calls through the same client as non-premium calls
// would let a pro user's tariff/comtrade response populate the cache
// and leak to the next free / signed-out session. Keep them split:
//
//   - publicClient  (globalThis.fetch)  — feeds restrictionsBreaker,
//     flowsBreaker, barriersBreaker, revenueBreaker. Unauthenticated,
//     shareable response bodies, safe to cache across auth states.
//
//   - premiumClient (premiumFetch)      — ONLY used for get-tariff-trends
//     and list-comtrade-flows. Injects the caller's Clerk bearer /
//     tester-key / WORLDMONITOR_API_KEY, so pro users get real data
//     instead of 401.
const publicClient = new TradeServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });
const premiumClient = new TradeServiceClient(getRpcBaseUrl(), { fetch: premiumFetch });

const restrictionsBreaker = createCircuitBreaker<GetTradeRestrictionsResponse>({ name: 'WTO Restrictions', cacheTtlMs: 30 * 60 * 1000, persistCache: true });
// Premium endpoints: persistCache:false so a pro user's response is NOT
// written to localStorage/IndexedDB where a later free / signed-out session
// on the same browser would read it back without re-authenticating.
const tariffsBreaker = createCircuitBreaker<GetTariffTrendsResponse>({ name: 'WTO Tariffs', cacheTtlMs: 30 * 60 * 1000, persistCache: false });
const flowsBreaker = createCircuitBreaker<GetTradeFlowsResponse>({ name: 'WTO Flows', cacheTtlMs: 30 * 60 * 1000, persistCache: true });
const barriersBreaker = createCircuitBreaker<GetTradeBarriersResponse>({ name: 'WTO Barriers', cacheTtlMs: 30 * 60 * 1000, persistCache: true });
const revenueBreaker = createCircuitBreaker<GetCustomsRevenueResponse>({ name: 'Treasury Revenue', cacheTtlMs: 30 * 60 * 1000, persistCache: true });
const comtradeBreaker = createCircuitBreaker<ListComtradeFlowsResponse>({ name: 'Comtrade Flows', cacheTtlMs: 6 * 60 * 60 * 1000, persistCache: false });

// Track the identity + entitlement fingerprint that last populated the
// in-memory premium breaker caches. On any change — sign-out, user switch,
// OR entitlement downgrade/upgrade for the same user — wipe the premium
// breakers so the new session doesn't see the previous session's premium
// response. persistCache:false already closes the cross-browser-reload
// path; this closes the in-tab SPA transition path.
//
// ENTITLEMENT SIGNAL: hasPremiumAccess() is the repo's single source of
// truth (src/services/panel-gating.ts). It unions API key, tester key,
// Clerk pro role, and Convex Dodo entitlement via isProUser/isEntitled.
// The earlier version of this fingerprint used Clerk publicMetadata.plan,
// which is NOT written by the webhook pipeline — a paying user with a
// valid Dodo entitlement would still fingerprint as 'free', and a user
// whose Dodo subscription lapsed would still fingerprint as 'pro' until
// the next Clerk session refresh. Swap to hasPremiumAccess() so the
// fingerprint tracks authoritative entitlement state directly.
//
// Shape: `${userId}:${entitled ? 'pro' : 'free'}` | `anon:<state>` | undefined-not-yet-observed
let lastPremiumFingerprint: string | null | undefined; // undefined = never observed

function currentPremiumFingerprint(): string {
  let userId = 'anon';
  try {
    userId = getCurrentClerkUser()?.id ?? 'anon';
  } catch { /* Clerk not loaded yet */ }
  let entitled = false;
  try {
    entitled = hasPremiumAccess();
  } catch { /* entitlement/panel-gating not ready */ }
  return `${userId}:${entitled ? 'pro' : 'free'}`;
}

function invalidatePremiumBreakersIfIdentityChanged(): void {
  const fp = currentPremiumFingerprint();
  if (lastPremiumFingerprint !== undefined && fp !== lastPremiumFingerprint) {
    tariffsBreaker.clearMemoryCache();
    comtradeBreaker.clearMemoryCache();
  }
  lastPremiumFingerprint = fp;
}

// Reactive path: when Convex publishes an entitlement change, wipe the
// premium breakers immediately rather than waiting for the next premium
// fetcher call. A user whose subscription lapses after they've opened
// the tariff panel shouldn't keep seeing premium data until they click
// something else.
onEntitlementChange(() => {
  const fp = currentPremiumFingerprint();
  if (lastPremiumFingerprint !== undefined && fp !== lastPremiumFingerprint) {
    tariffsBreaker.clearMemoryCache();
    comtradeBreaker.clearMemoryCache();
    lastPremiumFingerprint = fp;
  }
});

const emptyRestrictions: GetTradeRestrictionsResponse = { restrictions: [], fetchedAt: '', upstreamUnavailable: false };
const emptyTariffs: GetTariffTrendsResponse = { datapoints: [], fetchedAt: '', upstreamUnavailable: false };
const emptyFlows: GetTradeFlowsResponse = { flows: [], fetchedAt: '', upstreamUnavailable: false };
const emptyBarriers: GetTradeBarriersResponse = { barriers: [], fetchedAt: '', upstreamUnavailable: false };
const emptyRevenue: GetCustomsRevenueResponse = { months: [], fetchedAt: '', upstreamUnavailable: false };
const emptyComtrade: ListComtradeFlowsResponse = { flows: [], fetchedAt: '', upstreamUnavailable: false };

export async function fetchTradeRestrictions(countries: string[] = [], limit = 50): Promise<GetTradeRestrictionsResponse> {
  if (!isFeatureAvailable('wtoTrade')) return emptyRestrictions;
  try {
    return await restrictionsBreaker.execute(async () => {
      return publicClient.getTradeRestrictions({ countries, limit });
    }, emptyRestrictions, { shouldCache: r => (r.restrictions?.length ?? 0) > 0 });
  } catch {
    return emptyRestrictions;
  }
}

export async function fetchTariffTrends(reportingCountry: string, partnerCountry: string, productSector = '', years = 10): Promise<GetTariffTrendsResponse> {
  if (!isFeatureAvailable('wtoTrade')) return emptyTariffs;
  // /pro live-preview iframe: no Clerk session → guaranteed 401 → breaker
  // would fall through to emptyTariffs anyway. Short-circuit to silence the
  // console noise this path causes on the embedding /pro page.
  if (IS_EMBEDDED_PREVIEW) return emptyTariffs;
  invalidatePremiumBreakersIfIdentityChanged();
  try {
    return await tariffsBreaker.execute(async () => {
      return premiumClient.getTariffTrends({ reportingCountry, partnerCountry, productSector, years });
    }, emptyTariffs, { shouldCache: r => (r.datapoints?.length ?? 0) > 0 });
  } catch {
    return emptyTariffs;
  }
}

export async function fetchTradeFlows(reportingCountry: string, partnerCountry: string, years = 10): Promise<GetTradeFlowsResponse> {
  if (!isFeatureAvailable('wtoTrade')) return emptyFlows;
  try {
    return await flowsBreaker.execute(async () => {
      return publicClient.getTradeFlows({ reportingCountry, partnerCountry, years });
    }, emptyFlows, { shouldCache: r => (r.flows?.length ?? 0) > 0 });
  } catch {
    return emptyFlows;
  }
}

export async function fetchTradeBarriers(countries: string[] = [], measureType = '', limit = 50): Promise<GetTradeBarriersResponse> {
  if (!isFeatureAvailable('wtoTrade')) return emptyBarriers;
  try {
    return await barriersBreaker.execute(async () => {
      return publicClient.getTradeBarriers({ countries, measureType, limit });
    }, emptyBarriers, { shouldCache: r => (r.barriers?.length ?? 0) > 0 });
  } catch {
    return emptyBarriers;
  }
}

export async function fetchCustomsRevenue(): Promise<GetCustomsRevenueResponse> {
  const hydrated = getHydratedData('customsRevenue') as GetCustomsRevenueResponse | undefined;
  if (hydrated?.months?.length) return hydrated;
  try {
    return await revenueBreaker.execute(async () => {
      return publicClient.getCustomsRevenue({});
    }, emptyRevenue, { shouldCache: r => (r.months?.length ?? 0) > 0 });
  } catch {
    return emptyRevenue;
  }
}

export async function fetchComtradeFlows(): Promise<ListComtradeFlowsResponse> {
  // /pro live-preview iframe: see fetchTariffTrends comment above.
  if (IS_EMBEDDED_PREVIEW) return emptyComtrade;
  invalidatePremiumBreakersIfIdentityChanged();
  try {
    return await comtradeBreaker.execute(async () => {
      return premiumClient.listComtradeFlows({ reporterCode: '', cmdCode: '', anomaliesOnly: false });
    }, emptyComtrade, { shouldCache: r => (r.flows?.length ?? 0) > 0 });
  } catch {
    return emptyComtrade;
  }
}
