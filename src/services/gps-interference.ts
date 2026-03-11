import { getApiBaseUrl } from '@/services/runtime';
import { IntelligenceServiceClient } from '@/generated/client/worldmonitor/intelligence/v1/service_client';

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

const client = new IntelligenceServiceClient(getApiBaseUrl());

export async function fetchGpsInterference(): Promise<GpsJamData | null> {
  const now = Date.now();
  if (cachedData && now - cachedAt < CACHE_TTL) return cachedData;

  try {
    const resp = await client.listGpsInterference({ region: '' });


    const hexes: GpsJamHex[] = (resp.hexes ?? []).map(h => ({
      h3: h.h3,
      lat: h.lat,
      lon: h.lon,
      level: h.level === 'INTERFERENCE_LEVEL_HIGH' ? 'high' : 'medium',
      npAvg: Number.isFinite(h.npAvg) ? h.npAvg : 0,
      sampleCount: Number.isFinite(h.sampleCount) ? h.sampleCount : 0,
      aircraftCount: Number.isFinite(h.aircraftCount) ? h.aircraftCount : 0,
    }));

    cachedData = {
      fetchedAt: resp.fetchedAt ? new Date(resp.fetchedAt).toISOString() : new Date().toISOString(),
      source: resp.source || 'gpsjam.org',
      stats: {
        totalHexes: resp.stats?.totalHexes || 0,
        highCount: resp.stats?.highCount || 0,
        mediumCount: resp.stats?.mediumCount || 0,
      },
      hexes,
    };
    cachedAt = now;
    return cachedData;
  } catch (err) {
    console.error('[GPS Jam] RPC error:', err);
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
