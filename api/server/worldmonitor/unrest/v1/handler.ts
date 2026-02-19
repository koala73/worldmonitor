/**
 * Unrest service handler -- implements the generated UnrestServiceHandler
 * interface by proxying the ACLED API for protest events and enriching
 * with GDELT GEO data.
 *
 * Consolidates three legacy data flows:
 *   - api/acled.js (ACLED proxy with Bearer auth)
 *   - api/gdelt-geo.js (GDELT GEO proxy)
 *   - src/services/protests.ts (client-side merge/deduplicate/classify)
 *
 * Returns ready-to-use deduplicated, severity-classified, sorted events.
 * Graceful degradation: returns empty on missing token or upstream failure.
 */

declare const process: { env: Record<string, string | undefined> };

import type {
  UnrestServiceHandler,
  ServerContext,
  ListUnrestEventsRequest,
  ListUnrestEventsResponse,
  UnrestEvent,
  UnrestEventType,
  UnrestSourceType,
  SeverityLevel,
  ConfidenceLevel,
} from '../../../../../src/generated/server/worldmonitor/unrest/v1/service_server';

const ACLED_API_URL = 'https://acleddata.com/api/acled/read';
const GDELT_GEO_URL = 'https://api.gdeltproject.org/api/v2/geo/geo';

// ---------- ACLED Event Type Mapping (ported from src/services/protests.ts lines 39-46) ----------

function mapAcledEventType(eventType: string, subEventType: string): UnrestEventType {
  const lower = (eventType + ' ' + subEventType).toLowerCase();
  if (lower.includes('riot') || lower.includes('mob violence'))
    return 'UNREST_EVENT_TYPE_RIOT';
  if (lower.includes('strike'))
    return 'UNREST_EVENT_TYPE_STRIKE';
  if (lower.includes('demonstration'))
    return 'UNREST_EVENT_TYPE_DEMONSTRATION';
  if (lower.includes('protest'))
    return 'UNREST_EVENT_TYPE_PROTEST';
  return 'UNREST_EVENT_TYPE_CIVIL_UNREST';
}

// ---------- Severity Classification (ported from src/services/protests.ts lines 49-53) ----------

function classifySeverity(fatalities: number, eventType: string): SeverityLevel {
  if (fatalities > 0 || eventType.toLowerCase().includes('riot'))
    return 'SEVERITY_LEVEL_HIGH';
  if (eventType.toLowerCase().includes('protest'))
    return 'SEVERITY_LEVEL_MEDIUM';
  return 'SEVERITY_LEVEL_LOW';
}

// ---------- GDELT Classifiers ----------

function classifyGdeltSeverity(count: number, name: string): SeverityLevel {
  const lowerName = name.toLowerCase();
  if (count > 100 || lowerName.includes('riot') || lowerName.includes('clash'))
    return 'SEVERITY_LEVEL_HIGH';
  if (count < 25)
    return 'SEVERITY_LEVEL_LOW';
  return 'SEVERITY_LEVEL_MEDIUM';
}

function classifyGdeltEventType(name: string): UnrestEventType {
  const lowerName = name.toLowerCase();
  if (lowerName.includes('riot')) return 'UNREST_EVENT_TYPE_RIOT';
  if (lowerName.includes('strike')) return 'UNREST_EVENT_TYPE_STRIKE';
  if (lowerName.includes('demonstration')) return 'UNREST_EVENT_TYPE_DEMONSTRATION';
  return 'UNREST_EVENT_TYPE_PROTEST';
}

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

// ---------- Deduplication (ported from src/services/protests.ts lines 226-258) ----------

function deduplicateEvents(events: UnrestEvent[]): UnrestEvent[] {
  const unique = new Map<string, UnrestEvent>();

  for (const event of events) {
    const lat = event.location?.latitude ?? 0;
    const lon = event.location?.longitude ?? 0;
    const latKey = Math.round(lat * 2) / 2;
    const lonKey = Math.round(lon * 2) / 2;
    const dateKey = new Date(event.occurredAt).toISOString().split('T')[0];
    const key = `${latKey}:${lonKey}:${dateKey}`;

    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, event);
    } else {
      // Merge: prefer ACLED (higher confidence), combine sources
      if (
        event.sourceType === 'UNREST_SOURCE_TYPE_ACLED' &&
        existing.sourceType !== 'UNREST_SOURCE_TYPE_ACLED'
      ) {
        event.sources = [...new Set([...event.sources, ...existing.sources])];
        unique.set(key, event);
      } else if (existing.sourceType === 'UNREST_SOURCE_TYPE_ACLED') {
        existing.sources = [...new Set([...existing.sources, ...event.sources])];
      } else {
        // Both GDELT: combine sources, upgrade confidence if 2+ sources
        existing.sources = [...new Set([...existing.sources, ...event.sources])];
        if (existing.sources.length >= 2) {
          existing.confidence = 'CONFIDENCE_LEVEL_HIGH';
        }
      }
    }
  }

  return Array.from(unique.values());
}

// ---------- Sort (ported from src/services/protests.ts lines 262-273) ----------

function sortBySeverityAndRecency(events: UnrestEvent[]): UnrestEvent[] {
  const severityOrder: Record<string, number> = {
    SEVERITY_LEVEL_HIGH: 0,
    SEVERITY_LEVEL_MEDIUM: 1,
    SEVERITY_LEVEL_LOW: 2,
    SEVERITY_LEVEL_UNSPECIFIED: 3,
  };

  return events.sort((a, b) => {
    const sevDiff =
      (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3);
    if (sevDiff !== 0) return sevDiff;
    return b.occurredAt - a.occurredAt;
  });
}

// ---------- Handler ----------

export const unrestHandler: UnrestServiceHandler = {
  async listUnrestEvents(
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
  },
};
