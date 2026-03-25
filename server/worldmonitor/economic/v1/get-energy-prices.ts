/**
 * RPC: getEnergyPrices -- reads seeded energy price data from Railway seed cache.
 * All external EIA API calls happen in seed-economy.mjs on Railway.
 */

import type {
  ServerContext,
  GetEnergyPricesRequest,
  GetEnergyPricesResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'economic:energy:v1:all';

export async function getEnergyPrices(
  _ctx: ServerContext,
  req: GetEnergyPricesRequest,
): Promise<GetEnergyPricesResponse> {
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as GetEnergyPricesResponse | null;
    if (!result?.prices?.length) return { prices: [] };
    if (req.commodities.length > 0) {
      return { prices: result.prices.filter(p => req.commodities.includes(p.commodity)) };
    }
    return result;
  } catch {
    return { prices: [] };
  }
}
