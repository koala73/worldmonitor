import { ForecastServiceClient } from '@/generated/client/worldmonitor/forecast/v1/service_client';
import type { Forecast } from '@/generated/client/worldmonitor/forecast/v1/service_client';
import { getRpcBaseUrl } from '@/services/rpc-client';

export type { Forecast };

export { escapeHtml } from '@/utils/sanitize';

let _client: ForecastServiceClient | null = null;

function getClient(): ForecastServiceClient {
  if (!_client) {
    _client = new ForecastServiceClient(getRpcBaseUrl(), {
      fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
    });
  }
  return _client;
}

export async function fetchForecasts(domain?: string, region?: string): Promise<Forecast[]> {
  const resp = await getClient().getForecasts({ domain: domain || '', region: region || '' });
  return resp.forecasts || [];
}
