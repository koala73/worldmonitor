/**
 * RPC: getCrudeInventories -- reads seeded EIA WCRSTUS1 crude oil inventory data.
 * All external EIA API calls happen in seed-economy.mjs on Railway.
 */

import type {
  ServerContext,
  GetCrudeInventoriesRequest,
  GetCrudeInventoriesResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';

const SEED_CACHE_KEY = 'economic:crude-inventories:v1';

export async function getCrudeInventories(
  ctx: ServerContext,
  _req: GetCrudeInventoriesRequest,
): Promise<GetCrudeInventoriesResponse> {
  try {
    // true = raw key: seed scripts write without Vercel env prefix
    const result = await getCachedJson(SEED_CACHE_KEY, true) as GetCrudeInventoriesResponse | null;
    if (!result?.weeks?.length) return markNoStoreFallbackResponse(ctx.request, { weeks: [], latestPeriod: '' });
    return result;
  } catch (err) {
    console.error('[getCrudeInventories] Redis read failed:', err);
    return markNoStoreFallbackResponse(ctx.request, { weeks: [], latestPeriod: '' });
  }
}
