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

import { getCachedJson, setCachedJson } from '../../../_shared/redis';
import { fetchAcledCached } from '../../../_shared/acled';

const REDIS_CACHE_KEY = 'conflict:acled:v1';
const REDIS_CACHE_TTL = 900; // 15 min — ACLED rate-limited

async function fetchAcledConflicts(req: ListAcledEventsRequest): Promise<AcledConflictEvent[]> {
  try {
    const now = Date.now();
    const startMs = req.timeRange?.start ?? (now - 30 * 24 * 60 * 60 * 1000);
    const endMs = req.timeRange?.end ?? now;
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
  try {
    const cacheKey = `${REDIS_CACHE_KEY}:${req.country || 'all'}:${req.timeRange?.start || 0}:${req.timeRange?.end || 0}`;
    const cached = (await getCachedJson(cacheKey)) as ListAcledEventsResponse | null;
    if (cached?.events?.length) return cached;

    const events = await fetchAcledConflicts(req);
    const result: ListAcledEventsResponse = { events, pagination: undefined };
    if (events.length > 0) {
      setCachedJson(cacheKey, result, REDIS_CACHE_TTL).catch(() => {});
    }
    return result;
  } catch {
    return { events: [], pagination: undefined };
  }
}
