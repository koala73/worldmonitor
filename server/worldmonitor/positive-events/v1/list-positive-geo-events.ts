/**
 * ListPositiveGeoEvents RPC -- fetches geocoded positive news events
 * from GDELT GEO API using positive topic queries.
 */

import type {
  ServerContext,
  ListPositiveGeoEventsRequest,
  ListPositiveGeoEventsResponse,
  PositiveGeoEvent,
} from '../../../../src/generated/server/worldmonitor/positive_events/v1/service_server';

import { classifyNewsItem } from '../../../../src/services/positive-classifier';
import { markNoCacheResponse } from '../../../_shared/response-headers';

const GDELT_GEO_URL = 'https://api.gdeltproject.org/api/v2/geo/geo';

// Compound positive queries combining topics from POSITIVE_GDELT_TOPICS pattern
const POSITIVE_QUERIES = [
  '(breakthrough OR discovery OR "renewable energy")',
  '(conservation OR "poverty decline" OR "humanitarian aid")',
  '("good news" OR volunteer OR donation OR charity)',
];

async function fetchGdeltGeoPositive(query: string): Promise<PositiveGeoEvent[]> {
  const params = new URLSearchParams({
    query,
    format: 'geojson',
    timespan: '24h',
    maxrecords: '75',
  });

  const response = await fetch(`${GDELT_GEO_URL}?${params}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) return [];

  const data = await response.json();
  const features: unknown[] = data?.features || [];
  const seenLocations = new Set<string>();
  const events: PositiveGeoEvent[] = [];

  for (const feature of features as any[]) {
    const name: string = feature.properties?.name || '';
    if (!name || seenLocations.has(name)) continue;
    // GDELT returns error messages as fake features — skip them
    if (name.startsWith('ERROR:') || name.includes('unknown error')) continue;

    const count: number = feature.properties?.count || 1;
    if (count < 3) continue; // Noise filter

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
    ) continue;

    seenLocations.add(name);

    const category = classifyNewsItem('GDELT', name);

    events.push({
      latitude: lat,
      longitude: lon,
      name,
      category,
      count,
      timestamp: Date.now(),
    });
  }

  return events;
}

export async function listPositiveGeoEvents(
  ctx: ServerContext,
  _req: ListPositiveGeoEventsRequest,
): Promise<ListPositiveGeoEventsResponse> {
  try {
    const allEvents: PositiveGeoEvent[] = [];
    const seenNames = new Set<string>();
    let anyQuerySucceeded = false;

    for (let i = 0; i < POSITIVE_QUERIES.length; i++) {
      if (i > 0) {
        await new Promise(r => setTimeout(r, 500));
      }

      try {
        const events = await fetchGdeltGeoPositive(POSITIVE_QUERIES[i]);
        anyQuerySucceeded = true;
        for (const event of events) {
          if (!seenNames.has(event.name)) {
            seenNames.add(event.name);
            allEvents.push(event);
          }
        }
      } catch {
        // Individual query failure is non-fatal
      }
    }

    if (!anyQuerySucceeded) markNoCacheResponse(ctx.request);
    return { events: allEvents };
  } catch {
    markNoCacheResponse(ctx.request);
    return { events: [] };
  }
}
