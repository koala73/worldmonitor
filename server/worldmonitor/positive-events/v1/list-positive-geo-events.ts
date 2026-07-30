import type {
  ServerContext,
  ListPositiveGeoEventsRequest,
  ListPositiveGeoEventsResponse,
  PositiveGeoEvent,
} from '../../../../src/generated/server/worldmonitor/positive_events/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const CACHE_KEY = 'positive-events:geo:v1';
const MAX_SOURCE_AGE_MS = 25 * 60 * 60 * 1000;
const FALLBACK_WINDOW_MS = 12 * 60 * 60 * 1000;

// `sourceTs` is the upstream-produced timestamp surfaced in responses;
// `readAt` is when we last successfully loaded this payload from Redis
// and drives the 12 h availability window so a Redis blip on borderline-
// aged data still serves the fallback (issue #3706 review pass).
let fallback: { events: PositiveGeoEvent[]; readAt: number; sourceTs: number } | null = null;

// Test-only reset. The handler keeps `fallback` in module-local state for
// cross-request availability; tests need to exercise the empty-path
// branch deterministically without inheriting state from a previous test.
export function __resetFallbackForTest(): void {
  fallback = null;
}

export async function listPositiveGeoEvents(
  _ctx: ServerContext,
  _req: ListPositiveGeoEventsRequest,
): Promise<ListPositiveGeoEventsResponse> {
  try {
    const raw = await getCachedJson(CACHE_KEY, true) as { events?: PositiveGeoEvent[]; fetchedAt?: number } | null;
    if (raw?.events?.length && (!raw.fetchedAt || (Date.now() - raw.fetchedAt) < MAX_SOURCE_AGE_MS)) {
      const sourceTs = raw.fetchedAt ?? Date.now();
      fallback = { events: raw.events, readAt: Date.now(), sourceTs };
      return { events: raw.events, fetchedAt: sourceTs, stale: false };
    }
  } catch { /* fall through */ }

  if (fallback && (Date.now() - fallback.readAt) < FALLBACK_WINDOW_MS) {
    // Serving a previously-cached payload because the upstream source is
    // unavailable or has aged out. `fetchedAt` reports the original
    // upstream timestamp so the client can render an accurate "data
    // produced N hours ago" warning; the FALLBACK_WINDOW_MS check uses
    // `readAt` so we keep serving for the full 12 h after the last
    // successful read regardless of how aged the source was at that
    // moment. See issue #3706.
    return { events: fallback.events, fetchedAt: fallback.sourceTs, stale: true };
  }

  return { events: [], fetchedAt: 0, stale: false };
}
