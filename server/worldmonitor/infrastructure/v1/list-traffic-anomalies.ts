/**
 * ListInternetTrafficAnomalies RPC -- reads seeded traffic anomaly data from Railway seed cache.
 * All external Cloudflare Radar API calls happen in seed-internet-outages.mjs on Railway.
 */

import {
  ApiError,
  type ServerContext,
  type ListInternetTrafficAnomaliesRequest,
  type ListInternetTrafficAnomaliesResponse,
} from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';

import { logCacheReadError, readCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'cf:radar:traffic-anomalies:v1';

export async function listInternetTrafficAnomalies(
  _ctx: ServerContext,
  req: ListInternetTrafficAnomaliesRequest,
): Promise<ListInternetTrafficAnomaliesResponse> {
  const cached = await readCachedJson(SEED_CACHE_KEY, true);
  if (cached.status === 'error') logCacheReadError(SEED_CACHE_KEY, cached.error);
  const data = cached.status === 'hit' ? cached.value as Partial<ListInternetTrafficAnomaliesResponse> | null : null;
  if (!data || !Array.isArray(data.anomalies)
    || !data.anomalies.every((a) => a && typeof a.locationCode === 'string')) {
    throw new ApiError(503, 'Traffic anomalies cache unavailable', '');
  }
  const target = req.country?.toUpperCase();
  const anomalies = target ? data.anomalies.filter((a) => a.locationCode === target) : data.anomalies;
  return { anomalies, totalCount: data.anomalies.length };
}
