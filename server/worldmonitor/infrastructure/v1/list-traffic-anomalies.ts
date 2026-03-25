/**
 * ListInternetTrafficAnomalies RPC -- reads seeded traffic anomaly data from Railway seed cache.
 * All external Cloudflare Radar API calls happen in seed-internet-outages.mjs on Railway.
 */

import type {
  ServerContext,
  ListInternetTrafficAnomaliesRequest,
  ListInternetTrafficAnomaliesResponse,
  TrafficAnomaly,
} from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'cf:radar:traffic-anomalies:v1';

export async function listInternetTrafficAnomalies(
  _ctx: ServerContext,
  req: ListInternetTrafficAnomaliesRequest,
): Promise<ListInternetTrafficAnomaliesResponse> {
  try {
    const data = await getCachedJson(SEED_CACHE_KEY, true) as ListInternetTrafficAnomaliesResponse | null;
    let anomalies: TrafficAnomaly[] = data?.anomalies || [];

    if (req.country) {
      const target = req.country.toUpperCase();
      anomalies = anomalies.filter((a) => a.locationCode === target);
    }

    return { anomalies, totalCount: anomalies.length };
  } catch {
    return { anomalies: [], totalCount: 0 };
  }
}
