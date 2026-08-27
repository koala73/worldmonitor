/**
 * RPC: getEnergyCapacity -- reads seeded energy capacity data from Railway seed cache.
 * All external EIA API calls happen in seed-economy.mjs on Railway.
 */

import type {
  ServerContext,
  GetEnergyCapacityRequest,
  GetEnergyCapacityResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';
// sebuf serializes repeated query params comma-form; split before filtering.
import { parseStringArray } from '../../../_shared/parse-string-array';

const SEED_CACHE_KEY = 'economic:capacity:v1:COL,SUN,WND:20';

export async function getEnergyCapacity(
  ctx: ServerContext,
  req: GetEnergyCapacityRequest,
): Promise<GetEnergyCapacityResponse> {
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as GetEnergyCapacityResponse | null;
    if (!result?.series?.length) return markNoStoreFallbackResponse(ctx.request, { series: [] });
    const energySources = parseStringArray(req.energySources);
    if (energySources.length > 0) {
      return { series: result.series.filter(s => energySources.includes(s.energySource)) };
    }
    return result;
  } catch {
    return markNoStoreFallbackResponse(ctx.request, { series: [] });
  }
}
