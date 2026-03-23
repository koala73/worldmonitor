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

const SEED_CACHE_KEY = 'economic:crude-inventories:v1';

export async function getCrudeInventories(
  _ctx: ServerContext,
  _req: GetCrudeInventoriesRequest,
): Promise<GetCrudeInventoriesResponse> {
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as GetCrudeInventoriesResponse | null;
    if (!result?.weeks?.length) return { weeks: [], latestPeriod: '' };
    return result;
  } catch {
    return { weeks: [], latestPeriod: '' };
  }
}
