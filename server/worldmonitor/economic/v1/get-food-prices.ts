import type { ServerContext, GetFoodPricesRequest, GetFoodPricesResponse } from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';
import { getCachedJsonBatch } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';
import { FOOD_PRICE_SOURCES, buildFoodPriceSource, foodPriceKey } from './food-prices';

export async function getFoodPrices(ctx: ServerContext, _req: GetFoodPricesRequest): Promise<GetFoodPricesResponse> {
  let values: Map<string, unknown>;
  try {
    values = await getCachedJsonBatch(FOOD_PRICE_SOURCES.map(source => foodPriceKey(source.id)), true);
  } catch { values = new Map(); }
  const sources = FOOD_PRICE_SOURCES.map(source => buildFoodPriceSource(source, values.get(foodPriceKey(source.id))));
  const result = { sources, unavailable: sources.every(source => source.status === 'unavailable') };
  return sources.some(source => source.status !== 'current') ? markNoStoreFallbackResponse(ctx.request, result) : result;
}
