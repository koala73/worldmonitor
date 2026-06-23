import { ForecastServiceClient } from '@/generated/client/worldmonitor/forecast/v1/service_client';
import type { Forecast, GetForecastsResponse } from '@/generated/client/worldmonitor/forecast/v1/service_client';
import { getRpcBaseUrl } from '@/services/rpc-client';

export type { Forecast };

export interface ForecastFeed {
  forecasts: Forecast[];
  generatedAt: number;
  degraded: boolean;
  stale: boolean;
  error: string;
}

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

export async function fetchForecastFeed(domain?: string, region?: string): Promise<ForecastFeed> {
  const resp = await getClient().getForecasts({ domain: domain || '', region: region || '' });
  return normalizeForecastFeed(resp);
}

function normalizeForecastFeed(resp: GetForecastsResponse): ForecastFeed {
  return {
    forecasts: resp.forecasts || [],
    generatedAt: resp.generatedAt || 0,
    degraded: resp.degraded === true,
    stale: resp.stale === true,
    error: resp.error || '',
  };
}

export async function fetchSimulationOutcome(): Promise<string> {
  const resp = await getClient().getSimulationOutcome({ runId: '' });
  return (resp.found && resp.theaterSummariesJson) ? resp.theaterSummariesJson : '';
}
