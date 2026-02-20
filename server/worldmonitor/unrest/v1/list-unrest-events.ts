/**
 * ListUnrestEvents RPC -- merges ACLED and GDELT data into deduplicated,
 * severity-classified, sorted unrest events.
 */

declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  ListUnrestEventsRequest,
  ListUnrestEventsResponse,
  UnrestEvent,
  UnrestSourceType,
  ConfidenceLevel,
} from '../../../../src/generated/server/worldmonitor/unrest/v1/service_server';

import {
  ACLED_API_URL,
  GDELT_GEO_URL,
  mapAcledEventType,
  classifySeverity,
  classifyGdeltSeverity,
  classifyGdeltEventType,
  deduplicateEvents,
  sortBySeverityAndRecency,
} from './_shared';

// ---------- ACLED Fetch (ported from api/acled.js + src/services/protests.ts) ----------

async function fetchAcledProtests(req: ListUnrestEventsRequest): Promise<UnrestEvent[]> {
  try {
    const token = process.env.ACLED_ACCESS_TOKEN;
    if (!token) return []; // Graceful degradation when unconfigured

    const now = Date.now();
    const startMs = req.timeRange?.start ?? (now - 30 * 24 * 60 * 60 * 1000);
    const endMs = req.timeRange?.end ?? now;
    const startDate = new Date(startMs).toISOString().split('T')[0];
    const endDate = new Date(endMs).toISOString().split('T')[0];

    const params = new URLSearchParams({
      event_type: 'Protests',
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
      .map((e: any): UnrestEvent => {
        const fatalities = parseInt(e.fatalities, 10) || 0;
        return {
          id: `acled-${e.event_id_cnty}`,
          title: e.notes?.slice(0, 200) || `${e.sub_event_type} in ${e.location}`,
          summary: typeof e.notes === 'string' ? e.notes.substring(0, 500) : '',
          eventType: mapAcledEventType(e.event_type, e.sub_event_type),
          city: e.location || '',
          country: e.country || '',
          region: e.admin1 || '',
          location: {
            latitude: parseFloat(e.latitude),
            longitude: parseFloat(e.longitude),
          },
          occurredAt: new Date(e.event_date).getTime(),
          severity: classifySeverity(fatalities, e.event_type),
          fatalities,
          sources: [e.source].filter(Boolean),
          sourceType: 'UNREST_SOURCE_TYPE_ACLED' as UnrestSourceType,
          tags: e.tags?.split(';').map((t: string) => t.trim()).filter(Boolean) ?? [],
          actors: [e.actor1, e.actor2].filter(Boolean),
          confidence: 'CONFIDENCE_LEVEL_HIGH' as ConfidenceLevel,
        };
      });
  } catch {
    return [];
  }
}

// ---------- GDELT Fetch (ported from api/gdelt-geo.js + src/services/protests.ts) ----------

async function fetchGdeltEvents(): Promise<UnrestEvent[]> {
  try {
    const params = new URLSearchParams({
      query: 'protest',
      format: 'geojson',
      maxrecords: '250',
      timespan: '7d',
    });

    const response = await fetch(`${GDELT_GEO_URL}?${params}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return [];

    const data = await response.json();
    const features: unknown[] = data?.features || [];
    const seenLocations = new Set<string>();
    const events: UnrestEvent[] = [];

    for (const feature of features as any[]) {
      const name: string = feature.properties?.name || '';
      if (!name || seenLocations.has(name)) continue;

      const count: number = feature.properties?.count || 1;
      if (count < 5) continue; // Filter noise

      const coords = feature.geometry?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) continue;

      const [lon, lat] = coords; // GeoJSON order: [lon, lat]
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        lat < -90 ||
        lat > 90 ||
        lon < -180 ||
        lon > 180
      )
        continue;

      seenLocations.add(name);
      const country = name.split(',').pop()?.trim() || name;

      events.push({
        id: `gdelt-${lat.toFixed(2)}-${lon.toFixed(2)}-${Date.now()}`,
        title: `${name} (${count} reports)`,
        summary: '',
        eventType: classifyGdeltEventType(name),
        city: name.split(',')[0]?.trim() || '',
        country,
        region: '',
        location: { latitude: lat, longitude: lon },
        occurredAt: Date.now(),
        severity: classifyGdeltSeverity(count, name),
        fatalities: 0,
        sources: ['GDELT'],
        sourceType: 'UNREST_SOURCE_TYPE_GDELT' as UnrestSourceType,
        tags: [],
        actors: [],
        confidence: (count > 20
          ? 'CONFIDENCE_LEVEL_HIGH'
          : 'CONFIDENCE_LEVEL_MEDIUM') as ConfidenceLevel,
      });
    }

    return events;
  } catch {
    return [];
  }
}

// ---------- RPC Implementation ----------

export async function listUnrestEvents(
  _ctx: ServerContext,
  req: ListUnrestEventsRequest,
): Promise<ListUnrestEventsResponse> {
  try {
    const [acledEvents, gdeltEvents] = await Promise.all([
      fetchAcledProtests(req),
      fetchGdeltEvents(),
    ]);
    const merged = deduplicateEvents([...acledEvents, ...gdeltEvents]);
    const sorted = sortBySeverityAndRecency(merged);
    return { events: sorted, clusters: [], pagination: undefined };
  } catch {
    return { events: [], clusters: [], pagination: undefined };
  }
}
