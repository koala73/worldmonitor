import { cellToLatLng } from 'h3-js';
import { getApiBaseUrl } from '@/services/runtime';

export interface GpsJamHex {
  h3: string;
  lat: number;
  lon: number;
  level: 'medium' | 'high';
  pct: number;
  good: number;
  bad: number;
  total: number;
}

export interface GpsJamData {
  date: string;
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
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

export async function fetchGpsInterference(): Promise<GpsJamData | null> {
  const now = Date.now();
  if (cachedData && now - cachedAt < CACHE_TTL) return cachedData;

  try {
    const base = getApiBaseUrl();
    const resp = await fetch(`${base}/api/gpsjam`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) return cachedData;

    const raw = await resp.json() as {
      date: string;
      fetchedAt: string;
      source: string;
      stats: { totalHexes: number; highCount: number; mediumCount: number };
      hexes: Array<{ h3: string; pct: number; good: number; bad: number; total: number; level: string }>;
    };

    // Convert H3 hex IDs to lat/lon
    const hexes: GpsJamHex[] = [];
    for (const h of raw.hexes) {
      try {
        const [lat, lon] = cellToLatLng(h.h3);
        hexes.push({
          h3: h.h3,
          lat: Math.round(lat * 1e5) / 1e5,
          lon: Math.round(lon * 1e5) / 1e5,
          level: h.level as 'medium' | 'high',
          pct: h.pct,
          good: h.good,
          bad: h.bad,
          total: h.total,
        });
      } catch {
        // skip invalid hex
      }
    }

    cachedData = {
      date: raw.date,
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
