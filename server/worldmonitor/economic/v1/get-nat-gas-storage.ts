/**
 * RPC: getNatGasStorage -- reads seeded EIA NW2_EPG0_SWO_R48_BCF natural gas storage data.
 * All external EIA API calls happen in seed-economy.mjs on Railway.
 */

import type {
  ServerContext,
  GetNatGasStorageRequest,
  GetNatGasStorageResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';

const SEED_CACHE_KEY = 'economic:nat-gas-storage:v1';

export async function getNatGasStorage(
  ctx: ServerContext,
  _req: GetNatGasStorageRequest,
): Promise<GetNatGasStorageResponse> {
  try {
    // true = raw key: seed scripts write without Vercel env prefix
    const result = await getCachedJson(SEED_CACHE_KEY, true) as GetNatGasStorageResponse | null;
    if (!result?.weeks?.length) return markNoStoreFallbackResponse(ctx.request, { weeks: [], latestPeriod: '' });
    return result;
  } catch (err) {
    console.error('[getNatGasStorage] Redis read failed:', err);
    return markNoStoreFallbackResponse(ctx.request, { weeks: [], latestPeriod: '' });
  }
}
