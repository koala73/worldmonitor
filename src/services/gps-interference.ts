import { toApiUrl } from '@/services/runtime';

export interface GpsJamHex {
  h3: string;
  lat: number;
  lon: number;
  level: 'medium' | 'high';
  // gpsjam.org metric (restored 2026-07): share of aircraft in the hex reporting
  // GPS interference. pct = affectedAircraft / totalAircraft * 100.
  pct: number;
  affectedAircraft: number;
  totalAircraft: number;
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

export function getCachedGpsInterference(): GpsJamData | null {
  return cachedData;
}

export async function fetchGpsInterference(): Promise<GpsJamData | null> {
  const now = Date.now();
  if (cachedData && now - cachedAt < CACHE_TTL) return cachedData;

  try {
    const resp = await fetch(toApiUrl('/api/gpsjam'), {
      credentials: 'omit',
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) return cachedData;

    const raw = await resp.json() as GpsJamData;

    const hexes: GpsJamHex[] = (raw.hexes ?? []).map(h => ({
      h3: h.h3,
      lat: h.lat,
      lon: h.lon,
      level: h.level as 'medium' | 'high',
      pct: Number.isFinite(h.pct) ? h.pct : 0,
      affectedAircraft: Number.isFinite(h.affectedAircraft) ? h.affectedAircraft : 0,
      totalAircraft: Number.isFinite(h.totalAircraft) ? h.totalAircraft : 0,
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
