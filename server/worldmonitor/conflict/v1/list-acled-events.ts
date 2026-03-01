/**
 * RPC: listAcledEvents -- Port from api/acled-conflict.js
 *
 * Proxies the ACLED API for battles, explosions, and violence against
 * civilians events within a configurable time range and optional country
 * filter.  Returns empty array on upstream failure (graceful degradation).
 */

import type {
  ServerContext,
  ListAcledEventsRequest,
  ListAcledEventsResponse,
  AcledConflictEvent,
} from '../../../../src/generated/server/worldmonitor/conflict/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import { fetchAcledCached } from '../../../_shared/acled';

const REDIS_CACHE_KEY = 'conflict:acled:v1';
const REDIS_CACHE_TTL = 900; // 15 min — ACLED rate-limited

const fallbackAcledCache = new Map<string, { data: ListAcledEventsResponse; ts: number }>();

async function fetchAcledConflicts(req: ListAcledEventsRequest): Promise<AcledConflictEvent[]> {
  try {
    const now = Date.now();
    const startMs = req.start ?? (now - 30 * 24 * 60 * 60 * 1000);
    const endMs = req.end ?? now;
    const startDate = new Date(startMs).toISOString().split('T')[0]!;
    const endDate = new Date(endMs).toISOString().split('T')[0]!;

    const rawEvents = await fetchAcledCached({
      eventTypes: 'Battles|Explosions/Remote violence|Violence against civilians',
      startDate,
      endDate,
      country: req.country || undefined,
    });

    return rawEvents
      .filter((e) => {
        const lat = parseFloat(e.latitude || '');
        const lon = parseFloat(e.longitude || '');
        return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
      })
      .map((e): AcledConflictEvent => ({
        id: `acled-${e.event_id_cnty}`,
        eventType: e.event_type || '',
        country: e.country || '',
        location: {
          latitude: parseFloat(e.latitude || '0'),
          longitude: parseFloat(e.longitude || '0'),
        },
        occurredAt: new Date(e.event_date || '').getTime(),
        fatalities: parseInt(e.fatalities || '', 10) || 0,
        actors: [e.actor1, e.actor2].filter(Boolean) as string[],
        source: e.source || '',
        admin1: e.admin1 || '',
      }));
  } catch {
    return [];
  }
}

export async function listAcledEvents(
  _ctx: ServerContext,
  req: ListAcledEventsRequest,
): Promise<ListAcledEventsResponse> {
  const cacheKey = `${REDIS_CACHE_KEY}:${req.country || 'all'}:${req.start || 0}:${req.end || 0}`;
  try {
    const result = await cachedFetchJson<ListAcledEventsResponse>(
      cacheKey,
      REDIS_CACHE_TTL,
      async () => {
        const events = await fetchAcledConflicts(req);
        return events.length > 0 ? { events, pagination: undefined } : null;
      },
    );
    if (result) {
      if (fallbackAcledCache.size > 50) fallbackAcledCache.clear();
      fallbackAcledCache.set(cacheKey, { data: result, ts: Date.now() });
    }
    return result || fallbackAcledCache.get(cacheKey)?.data || { events: [], pagination: undefined };
  } catch {
    return fallbackAcledCache.get(cacheKey)?.data || { events: [], pagination: undefined };
  }
}
