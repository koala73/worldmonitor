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

export const listFireDetections: WildfireServiceHandler['listFireDetections'] = async (
  _ctx: ServerContext,
  _req: ListFireDetectionsRequest,
): Promise<ListFireDetectionsResponse> => {
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as ListFireDetectionsResponse | null;
    return result || { fireDetections: [], pagination: undefined };
  } catch {
    return { fireDetections: [], pagination: undefined };
  }
};
