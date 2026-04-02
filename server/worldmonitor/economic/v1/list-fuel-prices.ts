/**
 * RPC: listFuelPrices -- reads seeded retail fuel price data from Railway seed cache.
 * All data fetching happens in seed-fuel-prices.mjs on Railway.
 */

import type {
  ServerContext,
  ListFuelPricesRequest,
  ListFuelPricesResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'economic:fuel-prices:v1';

export async function listFuelPrices(
  _ctx: ServerContext,
  _req: ListFuelPricesRequest,
): Promise<ListFuelPricesResponse> {
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as ListFuelPricesResponse | null;
    if (!result?.countries?.length) {
      return { countries: [], fetchedAt: '', cheapestGasoline: '', cheapestDiesel: '', mostExpensiveGasoline: '', mostExpensiveDiesel: '', wowAvailable: false, prevFetchedAt: '', sourceCount: 0, countryCount: 0 };
    }
    return result;
  } catch {
    return { countries: [], fetchedAt: '', cheapestGasoline: '', cheapestDiesel: '', mostExpensiveGasoline: '', mostExpensiveDiesel: '', wowAvailable: false, prevFetchedAt: '', sourceCount: 0, countryCount: 0 };
  }
}
