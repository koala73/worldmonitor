import { toApiUrl } from '@/services/runtime';

export interface GpsJamHex {
  h3: string;
  lat: number;
  lon: number;
  level: 'medium' | 'high';
  npAvg: number;
  sampleCount: number;
  aircraftCount: number;
}

export interface GpsJamData {
  fetchedAt: string;
  source: string;
  stats: {
    totalHexes: number;
    highCount: number;
    mediumCount: number;
  };
  hexes: GpsJamHex[];
}

let cachedData: GpsJamData | null = null;
let cachedAt = 0;
const CACHE_TTL = 5 * 60 * 1000;

export async function fetchGpsInterference(): Promise<GpsJamData | null> {
  const now = Date.now();
  if (cachedData && now - cachedAt < CACHE_TTL) return cachedData;

  try {
    const resp = await fetch(toApiUrl('/api/gpsjam'), {
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) return cachedData;

    const raw = await resp.json() as GpsJamData;

    const hexes: GpsJamHex[] = (raw.hexes ?? []).map(h => ({
      h3: h.h3,
      lat: h.lat,
      lon: h.lon,
      level: h.level as 'medium' | 'high',
      npAvg: Number.isFinite(h.npAvg) ? h.npAvg : 0,
      sampleCount: Number.isFinite(h.sampleCount) ? h.sampleCount : 0,
      aircraftCount: Number.isFinite(h.aircraftCount) ? h.aircraftCount : 0,
    }));

    cachedData = {
      fetchedAt: raw.fetchedAt,
      source: raw.source,
      stats: raw.stats,
      hexes,
    };
    cachedAt = now;
    return cachedData;
  } catch {
    return cachedData;
  }
}

export function getGpsInterferenceByRegion(data: GpsJamData): Record<string, GpsJamHex[]> {
  const regions: Record<string, GpsJamHex[]> = {};
  for (const hex of data.hexes) {
    const region = classifyRegion(hex.lat, hex.lon);
    if (!regions[region]) regions[region] = [];
    regions[region].push(hex);
  }
  return regions;
}

function classifyRegion(lat: number, lon: number): string {
  if (lat >= 29 && lat <= 42 && lon >= 43 && lon <= 63) return 'iran-iraq';
  if (lat >= 31 && lat <= 37 && lon >= 35 && lon <= 43) return 'levant';
  if (lat >= 28 && lat <= 34 && lon >= 29 && lon <= 36) return 'israel-sinai';
  if (lat >= 44 && lat <= 53 && lon >= 22 && lon <= 41) return 'ukraine-russia';
  if (lat >= 54 && lat <= 70 && lon >= 27 && lon <= 60) return 'russia-north';
  if (lat >= 36 && lat <= 42 && lon >= 26 && lon <= 45) return 'turkey-caucasus';
  if (lat >= 32 && lat <= 38 && lon >= 63 && lon <= 75) return 'afghanistan-pakistan';
  if (lat >= 10 && lat <= 20 && lon >= 42 && lon <= 55) return 'yemen-horn';
  if (lat >= 50 && lat <= 72 && lon >= -10 && lon <= 25) return 'northern-europe';
  if (lat >= 35 && lat <= 50 && lon >= -10 && lon <= 25) return 'western-europe';
  if (lat >= 25 && lat <= 50 && lon >= -125 && lon <= -65) return 'north-america';
  return 'other';
}
