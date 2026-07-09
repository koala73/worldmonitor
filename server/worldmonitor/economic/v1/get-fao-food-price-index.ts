/**
 * RPC: getFaoFoodPriceIndex -- reads seeded FAO FFPI data from Railway seed cache.
 * All data fetching happens in seed-fao-food-price-index.mjs on Railway.
 */

import type {
  ServerContext,
  GetFaoFoodPriceIndexRequest,
  GetFaoFoodPriceIndexResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';

const SEED_CACHE_KEY = 'economic:fao-ffpi:v1';

const EMPTY: GetFaoFoodPriceIndexResponse = {
  points: [],
  fetchedAt: '',
  currentFfpi: 0,
  momPct: 0,
  yoyPct: 0,
};

export async function getFaoFoodPriceIndex(
  ctx: ServerContext,
  _req: GetFaoFoodPriceIndexRequest,
): Promise<GetFaoFoodPriceIndexResponse> {
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as GetFaoFoodPriceIndexResponse | null;
    if (!result?.points?.length) return markNoStoreFallbackResponse(ctx.request, EMPTY);
    return result;
  } catch {
    return markNoStoreFallbackResponse(ctx.request, EMPTY);
  }
}
