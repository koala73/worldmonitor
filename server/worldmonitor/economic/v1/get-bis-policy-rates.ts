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

const SEED_CACHE_KEY = 'economic:bis:policy:v1';

export async function getBisPolicyRates(
  _ctx: ServerContext,
  _req: GetBisPolicyRatesRequest,
): Promise<GetBisPolicyRatesResponse> {
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as GetBisPolicyRatesResponse | null;
    return result || { rates: [] };
  } catch {
    return { rates: [] };
  }
}
