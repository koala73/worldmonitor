/**
 * National Avalanche Center (NAC) forecast data
 * Zones list: https://api.avalanche.org/v2/public/products/forecast-zones/list
 * Forecast:   https://api.avalanche.org/v2/public/products/avalanche-forecast?zone_id={id}
 */

export type AvalancheDanger = 0 | 1 | 2 | 3 | 4 | 5;
// 0=No Rating, 1=Low, 2=Moderate, 3=Considerable, 4=High, 5=Extreme

export interface AvalancheForecast {
  id: string;
  zoneName: string;
  zoneId: number;
  state: string;
  lat: number;
  lon: number;
  danger: AvalancheDanger; // max danger across elevations
  dangerAlpine: AvalancheDanger;
  dangerTreeline: AvalancheDanger;
  dangerBelowTreeline: AvalancheDanger;
  avalancheProblems: string[]; // e.g. ["Wind Slab", "Persistent Slab"]
  headline: string;
  bottomLine: string;
  validDate: Date;
  expiryDate: Date;
  url: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

export interface AvalancheReport {
  forecasts: AvalancheForecast[];
  maxDanger: AvalancheDanger;
  fetchedAt: Date;
}

const ZONES_URL = 'https://api.avalanche.org/v2/public/products/forecast-zones/list';
const FORECAST_BASE_URL = 'https://api.avalanche.org/v2/public/products/avalanche-forecast';
const MAX_ZONES = 30;
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

let cache: { report: AvalancheReport; fetchedAt: number } | null = null;

interface RawZone {
  id?: number;
  zone_id?: number;
  name?: string;
  state?: string;
  center?: { lat?: number; lon?: number; longitude?: number };
  url?: string;
}

interface RawDangerRating {
  danger_rating?: { value?: number | string };
}

interface RawDangerEntry {
  valid_day?: string;
  upper?: number | RawDangerRating;
  middle?: number | RawDangerRating;
  lower?: number | RawDangerRating;
  alpine?: number | RawDangerRating;
  near_treeline?: number | RawDangerRating;
  below_treeline?: number | RawDangerRating;
}

interface RawProblem {
  name?: string;
  avalanche_problem_id?: number;
}

interface RawForecast {
  id?: number | string;
  forecast_zone?: { id?: number; name?: string; state?: string; url?: string } | Array<{ id?: number; name?: string; state?: string; url?: string }>;
  danger?: RawDangerEntry[];
  forecast_avalanche_problems?: RawProblem[];
  avalanche_problems?: RawProblem[];
  forecast_summary?: string;
  bottom_line?: string;
  hazard_discussion?: string;
  published_time?: string;
  expires_time?: string;
  valid_time?: string;
  expiry_time?: string;
}

function extractDangerValue(v: number | RawDangerRating | undefined): AvalancheDanger {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number') return clampDanger(v);
  if (typeof v === 'object' && v.danger_rating) {
    const val = v.danger_rating.value;
    if (typeof val === 'number') return clampDanger(val);
    if (typeof val === 'string') return clampDanger(parseInt(val, 10));
  }
  return 0;
}

function clampDanger(n: number): AvalancheDanger {
  if (isNaN(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 5) return 5;
  return n as AvalancheDanger;
}

function parseDangerFromArray(dangerArr: RawDangerEntry[]): {
  alpine: AvalancheDanger;
  treeline: AvalancheDanger;
  belowTreeline: AvalancheDanger;
} {
  // Prefer "current" day entry; fallback to first entry
  const current = dangerArr.find(e => e.valid_day === 'current') ?? dangerArr[0];
  if (!current) return { alpine: 0, treeline: 0, belowTreeline: 0 };

  // Try upper/middle/lower first, then alpine/near_treeline/below_treeline
  const alpine = extractDangerValue(current.upper ?? current.alpine);
  const treeline = extractDangerValue(current.middle ?? current.near_treeline);
  const belowTreeline = extractDangerValue(current.lower ?? current.below_treeline);

  return { alpine, treeline, belowTreeline };
}

function dangerToSeverity(danger: AvalancheDanger): AvalancheForecast['severity'] {
  if (danger >= 4) return 'critical';
  if (danger === 3) return 'high';
  if (danger === 2) return 'medium';
  return 'low';
}

async function fetchZoneList(): Promise<RawZone[]> {
  try {
    const res = await fetch(ZONES_URL, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return [];
    const json = await res.json() as { zones?: RawZone[] } | RawZone[];
    if (Array.isArray(json)) return json;
    if (json && typeof json === 'object' && Array.isArray((json as { zones?: RawZone[] }).zones)) {
      return (json as { zones: RawZone[] }).zones;
    }
    return [];
  } catch {
    return [];
  }
}

async function fetchForecastForZone(zoneId: number): Promise<RawForecast | null> {
  try {
    const url = `${FORECAST_BASE_URL}?zone_id=${zoneId}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const json = await res.json() as RawForecast | RawForecast[];
    if (Array.isArray(json)) return json[0] ?? null;
    return json ?? null;
  } catch {
    return null;
  }
}

function buildForecast(zone: RawZone, raw: RawForecast): AvalancheForecast | null {
  const zoneId = zone.id ?? zone.zone_id ?? 0;
  const zoneName = zone.name ?? 'Unknown Zone';
  const state = zone.state ?? '';
  const lat = zone.center?.lat ?? 0;
  const lon = zone.center?.lon ?? zone.center?.longitude ?? 0;
  const zoneUrl = zone.url ?? '';

  const dangerArr = raw.danger ?? [];
  const { alpine, treeline, belowTreeline } = parseDangerFromArray(dangerArr);
  const maxDanger = Math.max(alpine, treeline, belowTreeline) as AvalancheDanger;

  // Only include zones with Moderate+ danger (>= 2)
  if (maxDanger < 2) return null;

  const problems = (raw.forecast_avalanche_problems ?? raw.avalanche_problems ?? [])
    .map(p => p.name ?? '')
    .filter(n => n.length > 0);

  const headline = raw.forecast_summary ?? '';
  const bottomLine = raw.bottom_line ?? raw.hazard_discussion ?? '';

  const validDate = raw.published_time ?? raw.valid_time
    ? new Date(raw.published_time ?? raw.valid_time ?? '')
    : new Date();
  const expiryDate = raw.expires_time ?? raw.expiry_time
    ? new Date(raw.expires_time ?? raw.expiry_time ?? '')
    : new Date(Date.now() + 24 * 60 * 60 * 1000);

  return {
    id: `avy-${zoneId}`,
    zoneName,
    zoneId,
    state,
    lat,
    lon,
    danger: maxDanger,
    dangerAlpine: alpine,
    dangerTreeline: treeline,
    dangerBelowTreeline: belowTreeline,
    avalancheProblems: problems,
    headline,
    bottomLine,
    validDate: validDate instanceof Date && !isNaN(validDate.getTime()) ? validDate : new Date(),
    expiryDate: expiryDate instanceof Date && !isNaN(expiryDate.getTime()) ? expiryDate : new Date(Date.now() + 24 * 60 * 60 * 1000),
    url: zoneUrl,
    severity: dangerToSeverity(maxDanger),
  };
}

export async function fetchAvalancheHazard(): Promise<AvalancheReport> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.report;
  }

  try {
    const zones = await fetchZoneList();
    const limitedZones = zones.slice(0, MAX_ZONES);

    const forecastResults = await Promise.allSettled(
      limitedZones.map(zone => fetchForecastForZone(zone.id ?? zone.zone_id ?? 0))
    );

    const forecasts: AvalancheForecast[] = [];
    for (let i = 0; i < forecastResults.length; i++) {
      const result = forecastResults[i];
      if (!result || result.status !== 'fulfilled') continue;
      if (!result.value) continue;
      const zone = limitedZones[i];
      if (!zone) continue;
      const built = buildForecast(zone, result.value);
      if (built) forecasts.push(built);
    }

    // Sort: highest danger first
    forecasts.sort((a, b) => b.danger - a.danger);

    let maxDanger: AvalancheDanger = 0;
    for (const f of forecasts) {
      if (f.danger > maxDanger) maxDanger = f.danger;
    }

    const report: AvalancheReport = {
      forecasts,
      maxDanger,
      fetchedAt: new Date(),
    };

    cache = { report, fetchedAt: Date.now() };
    return report;
  } catch {
    return cache?.report ?? emptyAvalancheReport();
  }
}

function emptyAvalancheReport(): AvalancheReport {
  return {
    forecasts: [],
    maxDanger: 0,
    fetchedAt: new Date(),
  };
}

export function avalancheDangerLabel(danger: AvalancheDanger): string {
  const labels: Record<AvalancheDanger, string> = {
    0: 'No Rating',
    1: 'Low',
    2: 'Moderate',
    3: 'Considerable',
    4: 'High',
    5: 'Extreme',
  };
  return labels[danger] ?? 'Unknown';
}

export function avalancheSeverityClass(severity: string): string {
  return (
    {
      critical: 'eq-row eq-major',
      high: 'eq-row eq-strong',
      medium: 'eq-row eq-moderate',
      low: 'eq-row',
    }[severity] ?? 'eq-row'
  );
}
