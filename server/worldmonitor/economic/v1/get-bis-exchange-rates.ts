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

const SEED_CACHE_KEY = 'economic:bis:eer:v1';

export async function getBisExchangeRates(
  _ctx: ServerContext,
  _req: GetBisExchangeRatesRequest,
): Promise<GetBisExchangeRatesResponse> {
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as GetBisExchangeRatesResponse | null;
    return result || { rates: [] };
  } catch {
    return { rates: [] };
  }
}
