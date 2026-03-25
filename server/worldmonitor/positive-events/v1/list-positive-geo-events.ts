import type {
  ServerContext,
  ListPositiveGeoEventsRequest,
  ListPositiveGeoEventsResponse,
  PositiveGeoEvent,
} from '../../../../src/generated/server/worldmonitor/positive_events/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const CACHE_KEY = 'positive-events:geo:v1';
const MAX_AGE_MS = 25 * 60 * 60 * 1000;

let fallback: { events: PositiveGeoEvent[]; ts: number } | null = null;

export async function listPositiveGeoEvents(
  _ctx: ServerContext,
  _req: ListPositiveGeoEventsRequest,
): Promise<ListPositiveGeoEventsResponse> {
  try {
    const raw = await getCachedJson(CACHE_KEY, true) as { events?: PositiveGeoEvent[]; fetchedAt?: number } | null;
    if (raw?.events?.length && (!raw.fetchedAt || (Date.now() - raw.fetchedAt) < MAX_AGE_MS)) {
      fallback = { events: raw.events, ts: Date.now() };
      return { events: raw.events };
    }
  } catch { /* fall through */ }

  if (fallback && (Date.now() - fallback.ts) < 12 * 60 * 60 * 1000) {
    return { events: fallback.events };
  }

  return { events: [] };
}
