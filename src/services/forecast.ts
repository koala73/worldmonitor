
import type { Forecast, GetForecastsResponse } from '@/generated/client/worldmonitor/forecast/v1/service_client';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { publicRpcFetch } from '@/services/public-rpc-fetch';
import { ForecastServiceClient } from '@/services/generated-rpc-clients';

export type { Forecast };

export interface ForecastFeed {
  forecasts: Forecast[];
  generatedAt: number;
  degraded: boolean;
  stale: boolean;
  error: string;
}

export { escapeHtml } from '@/utils/sanitize';

let _client: InstanceType<typeof ForecastServiceClient> | null = null;

function getClient(): InstanceType<typeof ForecastServiceClient> {
  if (!_client) {
    _client = new ForecastServiceClient(getRpcBaseUrl(), {
      fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
    });
  }
  return _client;
}

// The unfiltered feed is the shared production payload — identical for every caller —
// so it goes through its CDN-shielded public URL (#5300). This matters because
// getHydratedData() is one-shot: every 30-minute dashboard refresh fell through to
// this call, and with no CDN in front of it that was ~17.5k uncached origin reads/day
// of a 188 KB payload. A FILTERED feed (domain/region) is caller-varying, so it keeps
// the credentialed client.
let _publicClient: InstanceType<typeof ForecastServiceClient> | null = null;
function getPublicClient(): InstanceType<typeof ForecastServiceClient> {
  if (!_publicClient) {
    _publicClient = new ForecastServiceClient(getRpcBaseUrl(), { fetch: publicRpcFetch });
  }
  return _publicClient;
}

export async function fetchForecastFeed(domain?: string, region?: string): Promise<ForecastFeed> {
  const filtered = Boolean(domain || region);
  const client = filtered ? getClient() : getPublicClient();
  const resp = await client.getForecasts({ domain: domain || '', region: region || '' });
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
