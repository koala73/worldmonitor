/**
 * USGS WaterWatch — Real-time stream gauge flood stage monitoring
 * Public API — no authentication required, CORS-enabled
 * https://waterwatch.usgs.gov/webservices/floodstage?format=json
 *
 * Returns gauges currently at or above flood stage across the US.
 */

export interface FloodGauge {
  id: string;
  siteNo: string;
  siteName: string;
  state: string;
  lat: number;
  lon: number;
  currentStage: number;     // feet
  floodStage: number;       // feet
  moderateFloodStage: number | null;
  majorFloodStage: number | null;
  floodCategory: 'major' | 'moderate' | 'minor' | 'action';
  url: string;
}

interface WaterWatchSite {
  site_no: string;
  station_nm: string;
  state_cd: string;
  dec_lat_va: number | string;
  dec_long_va: number | string;
  flood_stage: number | string;
  moderate_flood_stage?: number | string | null;
  major_flood_stage?: number | string | null;
  current_stage: number | string;
  flood_stage_status: string; // 'major', 'moderate', 'minor', 'action', 'no_flood'
}

interface WaterWatchResponse {
  sites?: WaterWatchSite[];
  site?: WaterWatchSite[];
}

const WATERWATCH_API = 'https://waterwatch.usgs.gov/webservices/floodstage?format=json';
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
let cache: { gauges: FloodGauge[]; fetchedAt: number } | null = null;

function toNumber(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function mapCategory(status: string): FloodGauge['floodCategory'] | null {
  const s = (status ?? '').toLowerCase();
  if (s.includes('major')) return 'major';
  if (s.includes('moderate')) return 'moderate';
  if (s.includes('minor')) return 'minor';
  if (s.includes('action')) return 'action';
  return null;
}

export async function fetchFloodGauges(): Promise<FloodGauge[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.gauges;

  try {
    const res = await fetch(WATERWATCH_API, {
      signal: AbortSignal.timeout(12_000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return cache?.gauges ?? [];

    const data: WaterWatchResponse = await res.json();
    const sites = data.sites ?? data.site ?? [];

    const gauges: FloodGauge[] = [];
    for (const s of sites) {
      const category = mapCategory(s.flood_stage_status);
      if (!category) continue; // skip non-flooding gauges

      const lat = toNumber(s.dec_lat_va);
      const lon = toNumber(s.dec_long_va);
      const currentStage = toNumber(s.current_stage);
      const floodStage = toNumber(s.flood_stage);

      if (lat === null || lon === null || currentStage === null || floodStage === null) continue;

      gauges.push({
        id: `flood-${s.site_no}`,
        siteNo: s.site_no,
        siteName: s.station_nm,
        state: s.state_cd,
        lat,
        lon,
        currentStage,
        floodStage,
        moderateFloodStage: toNumber(s.moderate_flood_stage ?? null),
        majorFloodStage: toNumber(s.major_flood_stage ?? null),
        floodCategory: category,
        url: `https://waterdata.usgs.gov/nwis/uv?site_no=${s.site_no}`,
      });
    }

    // Sort worst-first
    const order: Record<FloodGauge['floodCategory'], number> = { major: 0, moderate: 1, minor: 2, action: 3 };
    gauges.sort((a, b) => order[a.floodCategory] - order[b.floodCategory]);

    cache = { gauges, fetchedAt: Date.now() };
    return gauges;
  } catch {
    return cache?.gauges ?? [];
  }
}

export function floodCategoryClass(category: FloodGauge['floodCategory']): string {
  return {
    major: 'eq-row eq-major',
    moderate: 'eq-row eq-strong',
    minor: 'eq-row eq-moderate',
    action: 'eq-row',
  }[category] ?? 'eq-row';
}
