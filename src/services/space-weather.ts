// NOAA Space Weather Prediction Center — free, CORS-enabled, no API key required
// Docs: https://services.swpc.noaa.gov/
import { getApiBaseUrl } from '@/services/runtime';

export interface SpaceWeatherData {
  kpIndex: number | null;           // 0–9 planetary geomagnetic index
  kpClass: 'quiet' | 'unsettled' | 'active' | 'minor_storm' | 'moderate_storm' | 'severe_storm';
  solarWindSpeed: number | null;    // km/s (typically 300–800)
  solarWindDensity: number | null;  // protons/cm³
  bz: number | null;                // nT — southward Bz (<0) drives geomagnetic storms
  xrayClass: string | null;         // 'A', 'B', 'C', 'M', 'X' + number
  alertMessages: SpaceWeatherAlert[];
  fetchedAt: Date;
}

export interface SpaceWeatherAlert {
  id: string;
  message: string;
  issuedAt: Date;
  severity: 'watch' | 'warning' | 'alert' | 'summary';
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cache: { data: SpaceWeatherData; fetchedAt: number } | null = null;

function kpClass(kp: number): SpaceWeatherData['kpClass'] {
  if (kp >= 7) return 'severe_storm';
  if (kp >= 6) return 'moderate_storm';
  if (kp >= 5) return 'minor_storm';
  if (kp >= 4) return 'active';
  if (kp >= 3) return 'unsettled';
  return 'quiet';
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchSpaceWeather(): Promise<SpaceWeatherData> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  const [kpRaw, solarWindRaw, xrayRaw, alertsRaw] = await Promise.allSettled([
    // Latest 1-min Kp data (3-hour index, last entry)
    fetchJson<number[][]>(`${getApiBaseUrl()}/api/space-weather-feeds`),
    // Real-time solar wind from ACE/DSCOVR
    fetchJson<Record<string, unknown>[]>(`${getApiBaseUrl()}/api/space-weather-feeds`),
    // Latest X-ray flux class
    fetchJson<number[][]>(`${getApiBaseUrl()}/api/space-weather-feeds`),
    // Active alerts and warnings
    fetchJson<{ message: string; issue_datetime: string }[]>(`${getApiBaseUrl()}/api/space-weather-feeds`),
  ]);

  // Parse Kp index
  let kpIndex: number | null = null;
  if (kpRaw.status === 'fulfilled' && Array.isArray(kpRaw.value) && kpRaw.value.length > 1) {
    const rows = kpRaw.value as number[][];
    const last = rows[rows.length - 1];
    const kpVal = last ? Number(last[1]) : Number.NaN;
    if (!isNaN(kpVal)) kpIndex = kpVal;
  }

  // Parse solar wind (Bz from mag data)
  let solarWindSpeed: number | null = null;
  let solarWindDensity: number | null = null;
  let bz: number | null = null;
  if (solarWindRaw.status === 'fulfilled' && Array.isArray(solarWindRaw.value) && solarWindRaw.value.length > 1) {
    const rows = solarWindRaw.value as unknown as [string, string, string, string, string][];
    // Skip header row (index 0), get last data row
    const last = rows[rows.length - 1];
    if (last) {
      const bzVal = Number.parseFloat(last[3] ?? '');
      if (!isNaN(bzVal)) bz = bzVal;
    }
  }

  // Fetch plasma data for speed and density separately
  const plasmaRaw = await fetchJson<[string, string, string, string][]>(
    `${getApiBaseUrl()}/api/space-weather-feeds`,
  );
  if (Array.isArray(plasmaRaw) && plasmaRaw.length > 1) {
    const last = plasmaRaw[plasmaRaw.length - 1];
    if (last) {
      const speed = Number.parseFloat(last[1] ?? '');
      const density = Number.parseFloat(last[2] ?? '');
      if (!isNaN(speed)) solarWindSpeed = speed;
      if (!isNaN(density)) solarWindDensity = density;
    }
  }

  // Parse X-ray flares
  let xrayClass: string | null = null;
  if (xrayRaw.status === 'fulfilled' && Array.isArray(xrayRaw.value) && xrayRaw.value.length > 0) {
    const flares = xrayRaw.value as { max_class?: string; class?: string }[];
    const latest = flares[0];
    xrayClass = latest?.max_class ?? latest?.class ?? null;
  }

  // Parse alerts
  const alertMessages: SpaceWeatherAlert[] = [];
  if (alertsRaw.status === 'fulfilled' && Array.isArray(alertsRaw.value)) {
    const raw = alertsRaw.value as { message: string; issue_datetime: string }[];
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // last 24h
    for (const entry of raw.slice(0, 20)) {
      const issued = new Date(entry.issue_datetime + 'Z');
      if (issued.getTime() < cutoff) continue;
      const msg = entry.message ?? '';
      const firstLine = msg.split('\n')[0]?.trim() ?? '';
      let severity: SpaceWeatherAlert['severity'] = 'summary';
      if (/\bWATCH\b/i.test(firstLine)) severity = 'watch';
      else if (/\bWARNING\b/i.test(firstLine)) severity = 'warning';
      else if (/\bALERT\b/i.test(firstLine)) severity = 'alert';
      alertMessages.push({
        id: `${entry.issue_datetime}`,
        message: firstLine,
        issuedAt: issued,
        severity,
      });
    }
  }

  const data: SpaceWeatherData = {
    kpIndex,
    kpClass: kpIndex === null ? 'quiet' : kpClass(kpIndex),
    solarWindSpeed,
    solarWindDensity,
    bz,
    xrayClass,
    alertMessages,
    fetchedAt: new Date(),
  };

  cache = { data, fetchedAt: Date.now() };
  return data;
}
