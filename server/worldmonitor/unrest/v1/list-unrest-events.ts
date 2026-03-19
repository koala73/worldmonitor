/**
 * ListUnrestEvents RPC -- reads seeded unrest data from Railway seed cache.
 * All external ACLED/GDELT API calls happen in seed-unrest.mjs on Railway.
 */

import type {
  ServerContext,
  ListUnrestEventsRequest,
  ListUnrestEventsResponse,
  UnrestEvent,
} from '../../../../src/generated/server/worldmonitor/unrest/v1/service_server';

import { sortBySeverityAndRecency } from './_shared';
import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'unrest:events:v1';

function filterSeedEvents(
  events: UnrestEvent[],
  req: ListUnrestEventsRequest,
): UnrestEvent[] {
  let filtered = events;
  if (req.country) {
    const country = req.country.toLowerCase();
    filtered = filtered.filter(
      (e) => e.country.toLowerCase() === country || e.country.toLowerCase().includes(country),
    );
  }
  if (req.start > 0) {
    filtered = filtered.filter((e) => e.occurredAt >= req.start);
  }
  if (req.end > 0) {
    filtered = filtered.filter((e) => e.occurredAt <= req.end);
  }
  return filtered;
}

export async function listUnrestEvents(
  _ctx: ServerContext,
  req: ListUnrestEventsRequest,
): Promise<ListUnrestEventsResponse> {
  try {
    const seedData = await getCachedJson(SEED_CACHE_KEY, true) as ListUnrestEventsResponse | null;
    const filtered = filterSeedEvents(seedData?.events || [], req);
    const sorted = sortBySeverityAndRecency(filtered);
    return { events: sorted, clusters: [], pagination: undefined };
  } catch {
    return { events: [], clusters: [], pagination: undefined };
  }
}
