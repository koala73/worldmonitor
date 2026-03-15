/**
 * Global tropical cyclone / hurricane / typhoon monitoring
 *
 * Sources:
 *  - NHC (National Hurricane Center): Atlantic + East/Central Pacific basins
 *    https://www.nhc.noaa.gov/CurrentStorms.json  — real-time active storms
 *  - JTWC (Joint Typhoon Warning Center): West Pacific, Indian Ocean, Southern Hemisphere
 *    Parsed from JTWC RSS advisory at https://www.metoc.navy.mil/jtwc/products/
 *    (proxied via rss-proxy because metoc.navy.mil blocks CORS)
 *
 * Both are public government data — no API key required.
 */

export type TcBasin =
  | 'atlantic'
  | 'east_pacific'
  | 'central_pacific'
  | 'west_pacific'
  | 'north_indian'
  | 'south_indian'
  | 'south_pacific';

export type TcCategory =
  | 'tropical_depression'
  | 'tropical_storm'
  | 'category_1'
  | 'category_2'
  | 'category_3'
  | 'category_4'
  | 'category_5'
  | 'unknown';

export interface TropicalCyclone {
  id: string;
  name: string;
  basin: TcBasin;
  category: TcCategory;
  windKts: number | null;      // maximum sustained winds in knots
  pressureMb: number | null;   // minimum central pressure
  lat: number;
  lon: number;
  movement: string;            // e.g. "NNW at 12 mph"
  headline: string;
  advisoryTime: Date;
  advisoryUrl: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

// --- NHC current storms JSON ----
const NHC_STORMS_URL = 'https://www.nhc.noaa.gov/CurrentStorms.json';

// --- JTWC RSS via proxy (covers West Pacific, Indian Ocean, Southern Hemisphere) ---
const JTWC_RSS = 'https://www.metoc.navy.mil/jtwc/rss/jtwc.rss';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — cyclones are fast-moving
let cache: { storms: TropicalCyclone[]; fetchedAt: number } | null = null;

function categoryFromWind(windKts: number): TcCategory {
  if (windKts < 34) return 'tropical_depression';
  if (windKts < 64) return 'tropical_storm';
  if (windKts < 83) return 'category_1';
  if (windKts < 96) return 'category_2';
  if (windKts < 113) return 'category_3';
  if (windKts < 137) return 'category_4';
  return 'category_5';
}

function categoryFromSaffirSimpson(cat: TcCategory): TropicalCyclone['severity'] {
  switch (cat) {
    case 'category_5':
    case 'category_4': return 'critical';
    case 'category_3':
    case 'category_2': return 'high';
    case 'category_1':
    case 'tropical_storm': return 'medium';
    default: return 'low';
  }
}

interface NhcStorm {
  id: string;
  name: string;
  wallet: string;        // advisory package identifier
  atcf: string;         // ATCF storm ID (e.g. AL012024)
  dateTime: string;
  lat: string;
  lon: string;
  intensity: string;    // wind speed in knots
  pressure: string;     // central pressure in mb
  headline: string;
  movement: string;
  type: string;         // e.g. "HU", "TS", "TD"
}

interface NhcResponse {
  activeStorms?: NhcStorm[];
}

function basinFromAtcf(atcf: string): TcBasin {
  const prefix = atcf.slice(0, 2).toUpperCase();
  switch (prefix) {
    case 'AL': return 'atlantic';
    case 'EP': return 'east_pacific';
    case 'CP': return 'central_pacific';
    case 'WP': return 'west_pacific';
    case 'IO': return 'north_indian';
    case 'SH': return 'south_pacific';
    case 'SI': return 'south_indian';
    default: return 'atlantic';
  }
}

async function fetchNhcStorms(): Promise<TropicalCyclone[]> {
  try {
    const res = await fetch(NHC_STORMS_URL, {
      signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const data: NhcResponse = await res.json();
    const storms = data.activeStorms ?? [];

    return storms.map(s => {
      const windKts = parseInt(s.intensity, 10) || null;
      const category = windKts !== null ? categoryFromWind(windKts) : 'unknown';
      const lat = parseFloat(s.lat) || 0;
      const lon = parseFloat(s.lon) || 0;
      return {
        id: `nhc-${s.atcf ?? s.id}`,
        name: s.name ?? 'Unknown',
        basin: basinFromAtcf(s.atcf ?? ''),
        category,
        windKts,
        pressureMb: parseInt(s.pressure, 10) || null,
        lat,
        lon,
        movement: s.movement ?? '',
        headline: s.headline ?? '',
        advisoryTime: s.dateTime ? new Date(s.dateTime) : new Date(),
        advisoryUrl: `https://www.nhc.noaa.gov/text/${s.wallet}.shtml`,
        severity: categoryFromSaffirSimpson(category),
      };
    });
  } catch {
    return [];
  }
}

async function fetchJtwcStorms(): Promise<TropicalCyclone[]> {
  try {
    const proxyUrl = `/api/rss-proxy?url=${encodeURIComponent(JTWC_RSS)}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return [];

    const text = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) return [];

    const items = doc.querySelectorAll('item');
    const storms: TropicalCyclone[] = [];

    for (const item of Array.from(items)) {
      const title = item.querySelector('title')?.textContent?.trim() ?? '';
      const description = item.querySelector('description')?.textContent?.trim() ?? '';
      const link = item.querySelector('link')?.textContent?.trim() ?? '';
      const pubDateStr = item.querySelector('pubDate')?.textContent?.trim() ?? '';

      // JTWC titles like: "Tropical Storm 01W Advisory 001"
      const windMatch = description.match(/(\d+)\s*KT/i);
      const latMatch = description.match(/(\d+\.\d+)[NS]/i);
      const lonMatch = description.match(/(\d+\.\d+)[EW]/i);
      const latNeg = /S\b/.test(description.match(/\d+\.\d+([NS])/i)?.[0] ?? '' );
      const lonNeg = /W\b/.test(description.match(/\d+\.\d+([EW])/i)?.[0] ?? '' );

      const windKts = windMatch?.[1] ? parseInt(windMatch[1], 10) : null;
      const lat = latMatch?.[1] ? (parseFloat(latMatch[1]) * (latNeg ? -1 : 1)) : 0;
      const lon = lonMatch?.[1] ? (parseFloat(lonMatch[1]) * (lonNeg ? -1 : 1)) : 0;
      const category = windKts !== null ? categoryFromWind(windKts) : 'unknown';

      // Determine basin from lon/lat
      let basin: TcBasin = 'west_pacific';
      if (lat < 0 && lon > 30 && lon < 90) basin = 'south_indian';
      else if (lat < 0) basin = 'south_pacific';
      else if (lon > 40 && lon < 100) basin = 'north_indian';

      storms.push({
        id: `jtwc-${title.replace(/\s+/g, '-').toLowerCase().slice(0, 30)}`,
        name: title.split(' Advisory')[0]?.trim() ?? title,
        basin,
        category,
        windKts,
        pressureMb: null,
        lat,
        lon,
        movement: '',
        headline: description.slice(0, 200),
        advisoryTime: pubDateStr ? new Date(pubDateStr) : new Date(),
        advisoryUrl: link,
        severity: categoryFromSaffirSimpson(category),
      });
    }

    return storms;
  } catch {
    return [];
  }
}

export async function fetchTropicalCyclones(): Promise<TropicalCyclone[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.storms;

  const [nhcResult, jtwcResult] = await Promise.allSettled([
    fetchNhcStorms(),
    fetchJtwcStorms(),
  ]);

  const storms: TropicalCyclone[] = [
    ...(nhcResult.status === 'fulfilled' ? nhcResult.value : []),
    ...(jtwcResult.status === 'fulfilled' ? jtwcResult.value : []),
  ];

  // Sort most intense first
  const severityOrder: Record<TropicalCyclone['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3 };
  storms.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  cache = { storms, fetchedAt: Date.now() };
  return storms;
}

export function tcSeverityClass(severity: TropicalCyclone['severity']): string {
  return {
    critical: 'eq-row eq-major',
    high: 'eq-row eq-strong',
    medium: 'eq-row eq-moderate',
    low: 'eq-row',
  }[severity] ?? 'eq-row';
}

export function tcCategoryLabel(category: TcCategory): string {
  return {
    tropical_depression: 'TD',
    tropical_storm: 'TS',
    category_1: 'Cat 1',
    category_2: 'Cat 2',
    category_3: 'Cat 3',
    category_4: 'Cat 4',
    category_5: 'Cat 5',
    unknown: '?',
  }[category] ?? '?';
}
