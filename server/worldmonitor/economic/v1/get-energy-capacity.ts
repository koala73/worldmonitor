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

const SEED_CACHE_KEY = 'economic:capacity:v1:COL,SUN,WND:20';

export async function getEnergyCapacity(
  _ctx: ServerContext,
  req: GetEnergyCapacityRequest,
): Promise<GetEnergyCapacityResponse> {
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as GetEnergyCapacityResponse | null;
    if (!result?.series?.length) return { series: [] };
    if (req.energySources.length > 0) {
      return { series: result.series.filter(s => req.energySources.includes(s.energySource)) };
    }
    return result;
  } catch {
    return { series: [] };
  }
}
