import type { GetDemographicsCapabilityResponse, GetFoodStocksResponse, GetResilienceRankingResponse, GetResilienceScoreResponse, ResilienceDomain, ResilienceDimension, ResilienceRankingItem, ScoreInterval } from '@/generated/client/worldmonitor/resilience/v1/service_client';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { premiumFetch } from '@/services/premium-fetch';
import { ResilienceServiceClient } from '@/services/generated-rpc-clients';

export type ResilienceScoreResponse = GetResilienceScoreResponse;
export type ResilienceRankingResponse = GetResilienceRankingResponse;
export type FoodStocksResponse = GetFoodStocksResponse;
export type DemographicsCapabilityResponse = GetDemographicsCapabilityResponse;
export type { ResilienceDomain, ResilienceDimension, ResilienceRankingItem, ScoreInterval };

let _client: InstanceType<typeof ResilienceServiceClient> | null = null;

function getClient(): InstanceType<typeof ResilienceServiceClient> {
  if (!_client) {
    // Resilience RPCs are in PREMIUM_RPC_PATHS, so the global fetch patch
    // was already attaching their Clerk bearer — but routing around
    // `premiumFetch` also routed around `reportServerError`, which is why a real
    // `billing_verification_503` on get-resilience-ranking (2026-08-08, 2026-08-10)
    // never opened a Sentry issue the way its market and intelligence siblings did.
    _client = new ResilienceServiceClient(getRpcBaseUrl(), {
      fetch: premiumFetch,
    });
  }
  return _client;
}

function normalizeCountryCode(countryCode: string): string {
  const normalized = countryCode.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : '';
}

export async function getResilienceScore(countryCode: string): Promise<ResilienceScoreResponse> {
  return getClient().getResilienceScore({
    countryCode: normalizeCountryCode(countryCode),
  });
}

export async function getResilienceRanking(): Promise<ResilienceRankingResponse> {
  return getClient().getResilienceRanking({});
}

export async function getFoodStocks(
  opts: { countryCode?: string; commodity?: string; signal?: AbortSignal } = {},
): Promise<FoodStocksResponse> {
  return getClient().getFoodStocks(
    {
      countryCode: opts.countryCode ? normalizeCountryCode(opts.countryCode) || opts.countryCode.trim().toUpperCase() : '',
      commodity: opts.commodity ?? '',
    },
    // Forwarded so a panel close or country switch actually cancels the request
    // rather than only discarding its result.
    opts.signal ? { signal: opts.signal } : undefined,
  );
}

export async function getDemographicsCapability(
  opts: { countryCode: string; signal?: AbortSignal },
): Promise<DemographicsCapabilityResponse> {
  const normalized = normalizeCountryCode(opts.countryCode);
  return getClient().getDemographicsCapability(
    { countryCode: normalized || opts.countryCode.trim().toUpperCase() },
    opts.signal ? { signal: opts.signal } : undefined,
  );
}
