import {
  ResilienceServiceClient,
  type GetResilienceRankingResponse,
  type GetResilienceScoreResponse,
  type ResilienceDomain,
  type ResilienceDimension,
  type ResilienceRankingItem,
} from '@/generated/client/worldmonitor/resilience/v1/service_client';
import { getRpcBaseUrl } from '@/services/rpc-client';

export type ResilienceScoreResponse = GetResilienceScoreResponse;
export type ResilienceRankingResponse = GetResilienceRankingResponse;
export type { ResilienceDomain, ResilienceDimension, ResilienceRankingItem };

let _client: ResilienceServiceClient | null = null;

function getClient(): ResilienceServiceClient {
  if (!_client) {
    _client = new ResilienceServiceClient(getRpcBaseUrl(), {
      fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
    });
  }
  return _client;
}

function normalizeCountryCode(countryCode: string): string {
  return countryCode.trim().toUpperCase();
}

export async function getResilienceScore(countryCode: string): Promise<ResilienceScoreResponse> {
  return getClient().getResilienceScore({
    countryCode: normalizeCountryCode(countryCode),
  });
}

export async function getResilienceRanking(): Promise<ResilienceRankingResponse> {
  return getClient().getResilienceRanking({});
}
