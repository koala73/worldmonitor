import type { GetResilienceRankingResponse, GetResilienceScoreResponse, ResilienceDomain, ResilienceDimension, ResilienceRankingItem, ScoreInterval } from '@/generated/client/worldmonitor/resilience/v1/service_client';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { ResilienceServiceClient } from '@/services/generated-rpc-clients';

export type ResilienceScoreResponse = GetResilienceScoreResponse;
export type ResilienceRankingResponse = GetResilienceRankingResponse;
export type { ResilienceDomain, ResilienceDimension, ResilienceRankingItem, ScoreInterval };

let _client: InstanceType<typeof ResilienceServiceClient> | null = null;

function getClient(): InstanceType<typeof ResilienceServiceClient> {
  if (!_client) {
    _client = new ResilienceServiceClient(getRpcBaseUrl(), {
      fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
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
