/**
 * RPC: getBisPolicyRates -- reads BIS policy rate data from Railway seed cache.
 * All external BIS SDMX API calls happen in seed-bis-data.mjs on Railway.
 */

import type {
  ServerContext,
  GetBisPolicyRatesRequest,
  GetBisPolicyRatesResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';

const SEED_CACHE_KEY = 'economic:bis:policy:v1';

export async function getBisPolicyRates(
  ctx: ServerContext,
  _req: GetBisPolicyRatesRequest,
): Promise<GetBisPolicyRatesResponse> {
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as GetBisPolicyRatesResponse | null;
    return result || markNoStoreFallbackResponse(ctx.request, { rates: [] });
  } catch {
    return markNoStoreFallbackResponse(ctx.request, { rates: [] });
  }
}
