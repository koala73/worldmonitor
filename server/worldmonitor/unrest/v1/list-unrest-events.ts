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

function isSeedUnrestEvent(value: unknown): value is UnrestEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  const location = event.location;
  return typeof event.id === 'string'
    && typeof event.title === 'string'
    && typeof event.summary === 'string'
    && typeof event.city === 'string'
    && typeof event.country === 'string'
    && typeof event.region === 'string'
    && typeof event.eventType === 'string'
    && typeof event.severity === 'string'
    && typeof event.sourceType === 'string'
    && typeof event.confidence === 'string'
    && typeof event.occurredAt === 'number'
    && Number.isFinite(event.occurredAt)
    && typeof event.fatalities === 'number'
    && Number.isFinite(event.fatalities)
    && Array.isArray(event.sources) && event.sources.every((source) => typeof source === 'string')
    && Array.isArray(event.tags) && event.tags.every((tag) => typeof tag === 'string')
    && Array.isArray(event.actors) && event.actors.every((actor) => typeof actor === 'string')
    && Array.isArray(event.sourceUrls) && event.sourceUrls.every((url) => typeof url === 'string')
    && (location === undefined || (
      typeof location === 'object'
      && location !== null
      && Number.isFinite((location as { latitude?: unknown }).latitude)
      && Number.isFinite((location as { longitude?: unknown }).longitude)
    ));
}

/**
 * One malformed event (the seeder writes an unparseable ACLED date as
 * occurredAt: null) must not take down the whole feed: drop it and serve the
 * rest. A seed that is missing, not an array, or has no usable event left out
 * of a non-empty array is unavailable, not a confirmed empty feed.
 */
function decodeUnrestSeed(value: unknown): ListUnrestEventsResponse | undefined {
  const data = value as { events?: unknown } | null;
  if (!data || !Array.isArray(data.events)) return undefined;
  const events = data.events.filter(isSeedUnrestEvent);
  if (data.events.length > 0 && events.length === 0) return undefined;
  return { events, clusters: [], pagination: undefined };
}

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
  const seedData = await readRequiredSeed(SEED_CACHE_KEY, decodeUnrestSeed);
  const filtered = filterSeedEvents(seedData.events, req);
  const sorted = sortBySeverityAndRecency(filtered);
  return { events: sorted, clusters: [], pagination: undefined };
}
