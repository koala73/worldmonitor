import { createLazyClient, getRpcBaseUrl } from '@/services/rpc-client';
import { IntelligenceServiceClient } from '@/services/generated-rpc-clients';
import { premiumFetch } from '@/services/premium-fetch';
export type { WsbTicker } from '@/generated/client/worldmonitor/intelligence/v1/service_client';

const getClient = createLazyClient(() => new IntelligenceServiceClient(getRpcBaseUrl(), { fetch: premiumFetch }));

export async function fetchWsbTickers() {
  try {
    return (await getClient().listWsbTickers({}, { signal: AbortSignal.timeout(15_000) })).tickers;
  } catch {
    return [];
  }
}
