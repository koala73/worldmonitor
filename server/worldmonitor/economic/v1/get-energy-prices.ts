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
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';
// sebuf serializes repeated query params comma-form; split before filtering.
import { parseStringArray } from '../../../_shared/parse-string-array';
import { eiaWeeklySpotProvenance } from '../../../../shared/oil-price-observation';

const SEED_CACHE_KEY = 'economic:energy:v1:all';

export async function getEnergyPrices(
  ctx: ServerContext,
  req: GetEnergyPricesRequest,
): Promise<GetEnergyPricesResponse> {
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as GetEnergyPricesResponse | null;
    if (!result?.prices?.length) return markNoStoreFallbackResponse(ctx.request, { prices: [] });
    const commodities = parseStringArray(req.commodities);
    const prices = commodities.length > 0
      ? result.prices.filter(p => commodities.includes(p.commodity))
      : result.prices;
    const now = Date.now();
    return {
      ...(commodities.length === 0 ? result : {}),
      prices: prices.map(price => price.commodity === 'brent' || price.commodity === 'wti' ? {
        ...price,
        ...eiaWeeklySpotProvenance(price.priceAt, now),
      } : price),
    };
  } catch {
    return markNoStoreFallbackResponse(ctx.request, { prices: [] });
  }
}
