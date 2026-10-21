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
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';

const SEED_CACHE_KEY = 'economic:bigmac:v1';

export async function listBigMacPrices(
  ctx: ServerContext,
  _req: ListBigMacPricesRequest,
): Promise<ListBigMacPricesResponse> {
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as ListBigMacPricesResponse | null;
    if (!result?.countries?.length) {
      return markNoStoreFallbackResponse(ctx.request, { countries: [], fetchedAt: '', cheapestCountry: '', mostExpensiveCountry: '', wowAvgPct: 0, wowAvailable: false, prevFetchedAt: '' });
    }
    return result;
  } catch {
    return markNoStoreFallbackResponse(ctx.request, { countries: [], fetchedAt: '', cheapestCountry: '', mostExpensiveCountry: '', wowAvgPct: 0, wowAvailable: false, prevFetchedAt: '' });
  }
}
