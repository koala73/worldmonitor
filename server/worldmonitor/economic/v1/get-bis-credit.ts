/**
 * RPC: getBisCredit -- reads BIS credit-to-GDP data from Railway seed cache.
 * All external BIS SDMX API calls happen in seed-bis-data.mjs on Railway.
 */

import type {
  ServerContext,
  GetBisCreditRequest,
  GetBisCreditResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'economic:bis:credit:v1';

export async function getBisCredit(
  _ctx: ServerContext,
  _req: GetBisCreditRequest,
): Promise<GetBisCreditResponse> {
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as GetBisCreditResponse | null;
    return result || { entries: [] };
  } catch {
    return { entries: [] };
  }
}
