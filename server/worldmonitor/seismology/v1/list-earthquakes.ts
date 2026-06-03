/**
 * ListEarthquakes RPC -- proxies the USGS earthquake GeoJSON API.
 *
 * Prefers Railway-seeded Redis data when fresh; falls back to direct
 * USGS fetch via cachedFetchJson.
 */

import type {
  SeismologyServiceHandler,
  ServerContext,
  ListEarthquakesRequest,
  ListEarthquakesResponse,
} from '../../../../src/generated/server/worldmonitor/seismology/v1/service_server';

import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';

const USGS_FEED_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_month.geojson';
const CACHE_KEY = 'seismology:earthquakes:v1';
const CACHE_TTL = 1800; // 30 minutes
const SEED_FRESHNESS_MS = 45 * 60 * 1000; // 45 minutes

type EarthquakeCache = { earthquakes: ListEarthquakesResponse['earthquakes'] };

async function trySeededData(): Promise<EarthquakeCache | null> {
  try {
    const [seedData, seedMeta] = await Promise.all([
      getCachedJson(CACHE_KEY, true) as Promise<EarthquakeCache | null>,
      getCachedJson('seed-meta:seismology:earthquakes', true) as Promise<{ fetchedAt?: number } | null>,
    ]);

    if (!seedData?.earthquakes?.length) return null;

    const fetchedAt = seedMeta?.fetchedAt ?? 0;
    const isFresh = Date.now() - fetchedAt < SEED_FRESHNESS_MS;

    if (isFresh) return seedData;

    if (!process.env.SEED_FALLBACK_EARTHQUAKES) return seedData;

    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch + parse the USGS earthquake feed. Shared by the live handler (on Redis
 * cache miss) and the Vercel refresh cron (api/seismology/v1/refresh.ts), which
 * writes the result to Redis directly so bootstrap stays fresh without the
 * GitHub Actions seed job.
 */
export async function fetchFreshEarthquakes(): Promise<{ earthquakes: ListEarthquakesResponse['earthquakes'] }> {
  const response = await fetch(USGS_FEED_URL, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`USGS API error: ${response.status}`);
  }

  const geojson: any = await response.json();
  const features: any[] = geojson.features || [];

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

  return { earthquakes };
}

export const listEarthquakes: SeismologyServiceHandler['listEarthquakes'] = async (
  _ctx: ServerContext,
  req: ListEarthquakesRequest,
): Promise<ListEarthquakesResponse> => {
  const pageSize = req.pageSize || 2500;

  try {
    const seeded = await trySeededData();
    if (seeded) {
      const earthquakes = seeded.earthquakes || [];
      return { earthquakes: earthquakes.slice(0, pageSize), pagination: undefined };
    }

    const cached = await cachedFetchJson<EarthquakeCache>(CACHE_KEY, CACHE_TTL, async () => {
      const { earthquakes } = await fetchFreshEarthquakes();
      return earthquakes.length > 0 ? { earthquakes } : null;
    });

    const earthquakes = cached?.earthquakes || [];
    return { earthquakes: earthquakes.slice(0, pageSize), pagination: undefined };
  } catch {
    return { earthquakes: [], pagination: undefined };
  }
};
