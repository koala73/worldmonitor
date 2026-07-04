/**
 * ListFireDetections RPC -- reads seeded wildfire data from Railway seed cache.
 * All external NASA FIRMS API calls happen in seed-wildfires.mjs on Railway.
 */

import type {
  WildfireServiceHandler,
  ServerContext,
  ListFireDetectionsRequest,
  ListFireDetectionsResponse,
} from '../../../../src/generated/server/worldmonitor/wildfire/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'wildfire:fires:v1';
const SEED_META_KEY = 'seed-meta:wildfire:fires';

interface SeedMeta {
  fetchedAt?: number;
}

export const listFireDetections: WildfireServiceHandler['listFireDetections'] = async (
  _ctx: ServerContext,
  _req: ListFireDetectionsRequest,
): Promise<ListFireDetectionsResponse> => {
  try {
    const [result, meta] = await Promise.all([
      getCachedJson(SEED_CACHE_KEY, true) as Promise<Partial<ListFireDetectionsResponse> | null>,
      getCachedJson(SEED_META_KEY, true) as Promise<SeedMeta | null>,
    ]);
    if (!result) return { fireDetections: [], pagination: undefined, fetchedAt: 0, dataAvailable: false };

    return {
      fireDetections: result.fireDetections ?? [],
      pagination: result.pagination,
      fetchedAt: Number(result.fetchedAt || meta?.fetchedAt || 0),
      dataAvailable: true,
    };
  } catch {
    return { fireDetections: [], pagination: undefined, fetchedAt: 0, dataAvailable: false };
  }
};
