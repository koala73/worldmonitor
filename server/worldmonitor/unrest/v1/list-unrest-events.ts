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
import { readRequiredSeed } from '../../../_shared/required-seed';
import { resolveCountryCode } from '../../../../shared/country-code-resolve';

const SEED_CACHE_KEY = 'unrest:events:v1';

function filterSeedEvents(
  events: UnrestEvent[],
  req: ListUnrestEventsRequest,
): UnrestEvent[] {
  let filtered = events;
  if (req.country) {
    const country = resolveCountryCode(req.country);
    filtered = country ? filtered.filter((e) => resolveCountryCode(e.country) === country) : [];
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
  const seedData = await readRequiredSeed(SEED_CACHE_KEY, value => {
    const data = value as ListUnrestEventsResponse | null;
    return data && Array.isArray(data.events) ? data : undefined;
  });
  const filtered = filterSeedEvents(seedData.events, req);
  const sorted = sortBySeverityAndRecency(filtered);
  return { events: sorted, clusters: [], pagination: undefined };
}
