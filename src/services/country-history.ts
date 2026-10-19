import { createLazyClient, getRpcBaseUrl } from '@/services/rpc-client';
import { IntelligenceServiceClient } from '@/services/generated-rpc-clients';
import { proFreshRpcFetch } from '@/services/premium-fetch';

export type { GetCountryHistoryResponse, CountryHistoryPoint } from '@/generated/client/worldmonitor/intelligence/v1/service_client';

const client = createLazyClient(() => new IntelligenceServiceClient(getRpcBaseUrl(), {
  fetch: proFreshRpcFetch,
}));

export function fetchCountryHistory(country: string, days: number, signal: AbortSignal) {
  return client().getCountryHistory({ country, days }, { signal });
}
