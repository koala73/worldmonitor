/**
 * ListEarthquakes RPC -- proxies the USGS earthquake GeoJSON API.
 *
 * Fetches M4.5+ earthquakes from the last 24 hours and transforms the USGS
 * GeoJSON features into proto-shaped Earthquake objects.
 */

import type {
  SeismologyServiceHandler,
  ServerContext,
  ListEarthquakesRequest,
  ListEarthquakesResponse,
} from '../../../../src/generated/server/worldmonitor/seismology/v1/service_server';

import { getCachedJson, setCachedJson } from '../../../_shared/redis';

const USGS_FEED_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson';
const CACHE_KEY = 'seismology:earthquakes:v1';
const CACHE_TTL = 300; // 5 minutes

export const listEarthquakes: SeismologyServiceHandler['listEarthquakes'] = async (
  _ctx: ServerContext,
  req: ListEarthquakesRequest,
): Promise<ListEarthquakesResponse> => {
  // Check Redis cache first (H-4 fix)
  const cached = (await getCachedJson(CACHE_KEY)) as ListEarthquakesResponse | null;
  if (cached) return cached;

  const response = await fetch(USGS_FEED_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`USGS API error: ${response.status}`);
  }

  const geojson: any = await response.json();
  const features: any[] = geojson.features || [];

  // Null-safe property access (H-5 fix)
  const earthquakes = features
    .filter((f: any) => f?.properties && f?.geometry?.coordinates)
    .map((f: any) => ({
      id: (f.id as string) || '',
      place: (f.properties?.place as string) || '',
      magnitude: (f.properties?.mag as number) ?? 0,
      depthKm: (f.geometry?.coordinates?.[2] as number) ?? 0,
      location: {
        latitude: (f.geometry?.coordinates?.[1] as number) ?? 0,
        longitude: (f.geometry?.coordinates?.[0] as number) ?? 0,
      },
      occurredAt: f.properties?.time ?? 0,
      sourceUrl: (f.properties?.url as string) || '',
    }));

  const pageSize = _req.pagination?.pageSize || 500;
  const result: ListEarthquakesResponse = { earthquakes: earthquakes.slice(0, pageSize), pagination: undefined };
  await setCachedJson(CACHE_KEY, result, CACHE_TTL);
  return result;
};
