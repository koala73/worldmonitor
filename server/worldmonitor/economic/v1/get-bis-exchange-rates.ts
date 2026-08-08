/**
 * RPC: getBisExchangeRates -- reads BIS exchange rate data from Railway seed cache.
 * All external BIS SDMX API calls happen in seed-bis-data.mjs on Railway.
 */

import type {
  ServerContext,
  GetBisExchangeRatesRequest,
  GetBisExchangeRatesResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';

const SEED_CACHE_KEY = 'economic:bis:eer:v1';

export async function getBisExchangeRates(
  ctx: ServerContext,
  _req: GetBisExchangeRatesRequest,
): Promise<GetBisExchangeRatesResponse> {
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as GetBisExchangeRatesResponse | null;
    return result || markNoStoreFallbackResponse(ctx.request, { rates: [] });
  } catch {
    return markNoStoreFallbackResponse(ctx.request, { rates: [] });
  }
}
