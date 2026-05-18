import type {
  ServerContext,
  ListPositiveGeoEventsRequest,
  ListPositiveGeoEventsResponse,
  PositiveGeoEvent,
} from '../../../../src/generated/server/worldmonitor/positive_events/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const CACHE_KEY = 'positive-events:geo:v1';
const MAX_AGE_MS = 25 * 60 * 60 * 1000;
const FALLBACK_MAX_AGE_MS = 12 * 60 * 60 * 1000;

let fallback: { events: PositiveGeoEvent[]; ts: number } | null = null;

export async function listPositiveGeoEvents(
  _ctx: ServerContext,
  _req: ListPositiveGeoEventsRequest,
): Promise<ListPositiveGeoEventsResponse> {
  try {
    const raw = await getCachedJson(CACHE_KEY, true) as { events?: PositiveGeoEvent[]; fetchedAt?: number } | null;
    if (raw?.events?.length && (!raw.fetchedAt || (Date.now() - raw.fetchedAt) < MAX_AGE_MS)) {
      const fetchedAt = raw.fetchedAt ?? Date.now();
      fallback = { events: raw.events, ts: fetchedAt };
      return { events: raw.events, fetchedAt, stale: false };
    }
  } catch { /* fall through */ }

  if (fallback && (Date.now() - fallback.ts) < FALLBACK_MAX_AGE_MS) {
    // Serving a previously-cached payload because the upstream source is
    // unavailable or has aged out. Mark stale so clients can surface a
    // freshness warning. See issue #3706.
    return { events: fallback.events, fetchedAt: fallback.ts, stale: true };
  }

  return { events: [], fetchedAt: 0, stale: false };
}
