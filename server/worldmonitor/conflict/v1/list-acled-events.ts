import type {
  ServerContext,
  ListAcledEventsRequest,
  ListAcledEventsResponse,
} from '../../../../src/generated/server/worldmonitor/conflict/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { normalizeCountryToIso2 } from '../../../_shared/country-normalize';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';

const REDIS_CACHE_KEY = 'conflict:acled:v1';
export const ACLED_DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

interface AcledEventWindow {
  startMs: number;
  endMs: number;
}

export function resolveAcledEventWindow(
  req: Pick<ListAcledEventsRequest, 'start' | 'end'>,
  now = Date.now(),
): AcledEventWindow {
  return {
    startMs: req.start > 0 ? req.start : Math.floor((now - ACLED_DEFAULT_WINDOW_MS) / 86_400_000) * 86_400_000,
    endMs: req.end > 0 ? req.end : now,
  };
}

function acledCountryCode(country: string): string | null {
  // ACLED omits "the" in the DRC name used by the shared gazetteer.
  return normalizeCountryToIso2(country)
    ?? (country.trim().toLowerCase() === 'democratic republic of congo' ? 'CD' : null);
}

// Railway owns ACLED fetching. Caller filters never create cache entries or live requests.
export async function listAcledEvents(
  ctx: ServerContext,
  req: ListAcledEventsRequest,
): Promise<ListAcledEventsResponse> {
  try {
    const seeded = await getCachedJson(`${REDIS_CACHE_KEY}:all:0:0`, true) as ListAcledEventsResponse | null;
    if (seeded) {
      // GDELT fallback rows in this seed have no coordinates and cannot be mapped by this RPC.
      let events = seeded.events.filter(event => event.location
        && Number.isFinite(event.location.latitude) && Math.abs(event.location.latitude) <= 90
        && Number.isFinite(event.location.longitude) && Math.abs(event.location.longitude) <= 180);
      if (req.country || req.start !== 0 || req.end !== 0) {
        const window = resolveAcledEventWindow(req);
        const country = acledCountryCode(req.country);
        events = events.filter(event =>
          (!req.country || event.country === req.country
            || (country !== null && acledCountryCode(event.country) === country))
          && event.occurredAt >= window.startMs && event.occurredAt <= window.endMs);
      }
      return { events, pagination: seeded.pagination };
    }
  } catch {
    // A failed seed read retains the empty RPC contract, without caching the outage.
  }
  return markNoStoreFallbackResponse(ctx.request, { events: [], pagination: undefined });
}
