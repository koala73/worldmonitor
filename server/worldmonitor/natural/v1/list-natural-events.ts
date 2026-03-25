/**
 * ListNaturalEvents RPC -- reads seeded natural disaster data from Railway seed cache.
 * All external EONET/GDACS/NHC API calls happen in seed-natural-events.mjs on Railway.
 */

import type {
  NaturalServiceHandler,
  ServerContext,
  ListNaturalEventsRequest,
  ListNaturalEventsResponse,
} from '../../../../src/generated/server/worldmonitor/natural/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'natural:events:v1';

export const listNaturalEvents: NaturalServiceHandler['listNaturalEvents'] = async (
  _ctx: ServerContext,
  _req: ListNaturalEventsRequest,
): Promise<ListNaturalEventsResponse> => {
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as { events: ListNaturalEventsResponse['events'] } | null;
    return { events: result?.events || [] };
  } catch {
    return { events: [] };
  }
};
