/**
 * RPC: listGroceryBasketPrices -- reads seeded grocery basket data from Railway seed cache.
 * All EXA API calls happen in seed-grocery-basket.mjs on Railway.
 */

import type {
  ServerContext,
  ListGroceryBasketPricesRequest,
  ListGroceryBasketPricesResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'economic:grocery-basket:v1';

export async function listGroceryBasketPrices(
  _ctx: ServerContext,
  _req: ListGroceryBasketPricesRequest,
): Promise<ListGroceryBasketPricesResponse> {
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as ListGroceryBasketPricesResponse | null;
    if (!result?.countries?.length) {
      return { countries: [], fetchedAt: '', cheapestCountry: '', mostExpensiveCountry: '', upstreamUnavailable: true, wowAvgPct: 0, wowAvailable: false, prevFetchedAt: '' };
    }
    return result;
  } catch {
    return { countries: [], fetchedAt: '', cheapestCountry: '', mostExpensiveCountry: '', upstreamUnavailable: true, wowAvgPct: 0, wowAvailable: false, prevFetchedAt: '' };
  }
}
