/**
 * RPC: listBigMacPrices -- reads seeded Big Mac Index data from Railway seed cache.
 * All EXA API calls happen in seed-bigmac.mjs on Railway.
 */

import type {
  ServerContext,
  ListBigMacPricesRequest,
  ListBigMacPricesResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'economic:bigmac:v1';

export async function listBigMacPrices(
  _ctx: ServerContext,
  _req: ListBigMacPricesRequest,
): Promise<ListBigMacPricesResponse> {
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as ListBigMacPricesResponse | null;
    if (!result?.countries?.length) {
      return { countries: [], fetchedAt: '', cheapestCountry: '', mostExpensiveCountry: '', wowAvgPct: 0, wowAvailable: false, prevFetchedAt: '' };
    }
    return result;
  } catch {
    return { countries: [], fetchedAt: '', cheapestCountry: '', mostExpensiveCountry: '', wowAvgPct: 0, wowAvailable: false, prevFetchedAt: '' };
  }
}
