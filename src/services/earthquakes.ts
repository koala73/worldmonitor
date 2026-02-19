import type { Earthquake } from '@/types';
import { API_URLS } from '@/config';
import { createCircuitBreaker, fetchWithCache } from '@/utils';
import { getPersistentCache, setPersistentCache } from './persistent-cache';

interface USGSFeature {
  id: string;
  properties: {
    place: string;
    mag: number;
    time: number;
    url: string;
  };
  geometry: {
    coordinates: [number, number, number];
  };
}

interface USGSResponse {
  features: USGSFeature[];
}

const OVERLAY_CACHE_KEY = 'map-overlay:earthquakes';
const breaker = createCircuitBreaker<Earthquake[]>({ name: 'USGS Earthquakes' });

async function getFallbackEarthquakes(): Promise<Earthquake[]> {
  const entry = await getPersistentCache<Array<Omit<Earthquake, 'time'> & { time: string }>>(OVERLAY_CACHE_KEY);
  if (!entry?.data) return [];
  return entry.data.map(item => ({ ...item, time: new Date(item.time) }));
}

export async function fetchEarthquakes(): Promise<Earthquake[]> {
  const live = await breaker.execute(async () => {
    const data = await fetchWithCache<USGSResponse>(API_URLS.earthquakes, { ttl: 60_000 });
    return data.features.map((feature) => ({
      id: feature.id,
      place: feature.properties.place || 'Unknown',
      magnitude: feature.properties.mag,
      lon: feature.geometry.coordinates[0],
      lat: feature.geometry.coordinates[1],
      depth: feature.geometry.coordinates[2],
      time: new Date(feature.properties.time),
      url: feature.properties.url,
    }));
  }, []);

  if (live.length > 0) {
    void setPersistentCache(
      OVERLAY_CACHE_KEY,
      live.map(item => ({ ...item, time: item.time.toISOString() }))
    );
    return live;
  }

  return getFallbackEarthquakes();
}

export function getEarthquakesStatus(): string {
  return breaker.getStatus();
}

export function getEarthquakesDataState() {
  return breaker.getDataState();
}
