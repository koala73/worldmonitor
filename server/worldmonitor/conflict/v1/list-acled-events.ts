/**
 * RPC: listAcledEvents -- Port from api/acled-conflict.js
 *
 * Proxies the ACLED API for battles, explosions, and violence against
 * civilians events within a configurable time range and optional country
 * filter.  Returns empty array on upstream failure (graceful degradation).
 */

declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  ListAcledEventsRequest,
  ListAcledEventsResponse,
  AcledConflictEvent,
} from '../../../../src/generated/server/worldmonitor/conflict/v1/service_server';

const ACLED_API_URL = 'https://acleddata.com/api/acled/read';

async function fetchAcledConflicts(req: ListAcledEventsRequest): Promise<AcledConflictEvent[]> {
  try {
    const token = process.env.ACLED_ACCESS_TOKEN;
    if (!token) return []; // Graceful degradation when unconfigured

    const now = Date.now();
    const startMs = req.timeRange?.start ?? (now - 30 * 24 * 60 * 60 * 1000);
    const endMs = req.timeRange?.end ?? now;
    const startDate = new Date(startMs).toISOString().split('T')[0];
    const endDate = new Date(endMs).toISOString().split('T')[0];

    const params = new URLSearchParams({
      event_type: 'Battles|Explosions/Remote violence|Violence against civilians',
      event_date: `${startDate}|${endDate}`,
      event_date_where: 'BETWEEN',
      limit: '500',
      _format: 'json',
    });

    if (req.country) {
      params.set('country', req.country);
    }

    const response = await fetch(`${ACLED_API_URL}?${params}`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) return [];

    const rawData = await response.json();
    const events: unknown[] = Array.isArray(rawData?.data) ? rawData.data : [];

    return events
      .filter((e: any) => {
        const lat = parseFloat(e.latitude);
        const lon = parseFloat(e.longitude);
        return (
          Number.isFinite(lat) &&
          Number.isFinite(lon) &&
          lat >= -90 &&
          lat <= 90 &&
          lon >= -180 &&
          lon <= 180
        );
      })
      .map((e: any): AcledConflictEvent => ({
        id: `acled-${e.event_id_cnty}`,
        eventType: e.event_type || '',
        country: e.country || '',
        location: {
          latitude: parseFloat(e.latitude),
          longitude: parseFloat(e.longitude),
        },
        occurredAt: new Date(e.event_date).getTime(),
        fatalities: parseInt(e.fatalities, 10) || 0,
        actors: [e.actor1, e.actor2].filter(Boolean),
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
    const events = await fetchAcledConflicts(req);
    return { events, pagination: undefined };
  } catch {
    return { events: [], pagination: undefined };
  }
}
