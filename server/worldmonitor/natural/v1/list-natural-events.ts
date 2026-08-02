/**
 * ListNaturalEvents RPC -- reads seeded natural disaster data from Railway seed cache.
 * All external EONET/GDACS/NHC/HKO API calls happen in seed-natural-events.mjs on Railway.
 */

import type {
  NaturalServiceHandler,
  ServerContext,
  ListNaturalEventsRequest,
  ListNaturalEventsResponse,
} from '../../../../src/generated/server/worldmonitor/natural/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'natural:events:v1';
const SEED_META_KEY = 'seed-meta:natural:events';

interface SeedMeta {
  fetchedAt?: number;
}

export const listNaturalEvents: NaturalServiceHandler['listNaturalEvents'] = async (
  _ctx: ServerContext,
  _req: ListNaturalEventsRequest,
): Promise<ListNaturalEventsResponse> => {
  try {
    const [result, meta] = await Promise.all([
      getCachedJson(SEED_CACHE_KEY, true) as Promise<Partial<ListNaturalEventsResponse> | null>,
      getCachedJson(SEED_META_KEY, true) as Promise<SeedMeta | null>,
    ]);
    if (!result) return { events: [], fetchedAt: 0, dataAvailable: false };

    return {
      events: result.events ?? [],
      fetchedAt: Number(result.fetchedAt || meta?.fetchedAt || 0),
      dataAvailable: true,
    };
  } catch {
    return { events: [], fetchedAt: 0, dataAvailable: false };
  }
};
