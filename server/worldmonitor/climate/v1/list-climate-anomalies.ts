/**
 * ListClimateAnomalies RPC -- fetches 15 monitored zones from the Open-Meteo
 * Archive API, computes 30-day baseline comparisons (last 7 days vs preceding
 * baseline), classifies severity and type, and returns proto-shaped
 * ClimateAnomaly objects.
 *
 * Zones with fewer than 14 valid data points are skipped.
 */

import type {
  ClimateServiceHandler,
  ServerContext,
  ListClimateAnomaliesRequest,
  ListClimateAnomaliesResponse,
  AnomalySeverity,
  AnomalyType,
  ClimateAnomaly,
} from '../../../../src/generated/server/worldmonitor/climate/v1/service_server';

import { CHROME_UA } from '../../../_shared/constants';
import { getCachedJson, setCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'climate:anomalies:v1';
const REDIS_CACHE_TTL = 10800; // 3h — Open-Meteo Archive uses ERA5 reanalysis with 2-7 day lag

/** The 15 monitored zones matching the legacy api/climate-anomalies.js list. */
const ZONES: { name: string; lat: number; lon: number }[] = [
  { name: 'Ukraine', lat: 48.4, lon: 31.2 },
  { name: 'Middle East', lat: 33.0, lon: 44.0 },
  { name: 'Sahel', lat: 14.0, lon: 0.0 },
  { name: 'Horn of Africa', lat: 8.0, lon: 42.0 },
  { name: 'South Asia', lat: 25.0, lon: 78.0 },
  { name: 'California', lat: 36.8, lon: -119.4 },
  { name: 'Amazon', lat: -3.4, lon: -60.0 },
  { name: 'Australia', lat: -25.0, lon: 134.0 },
  { name: 'Mediterranean', lat: 38.0, lon: 20.0 },
  { name: 'Taiwan Strait', lat: 24.0, lon: 120.0 },
  { name: 'Myanmar', lat: 19.8, lon: 96.7 },
  { name: 'Central Africa', lat: 4.0, lon: 22.0 },
  { name: 'Southern Africa', lat: -25.0, lon: 28.0 },
  { name: 'Central Asia', lat: 42.0, lon: 65.0 },
  { name: 'Caribbean', lat: 19.0, lon: -72.0 },
];

/**
 * Classify anomaly severity based on temperature and precipitation deltas.
 * Matches legacy thresholds exactly.
 */
function classifySeverity(
  tempDelta: number,
  precipDelta: number,
): AnomalySeverity {
  const absTemp = Math.abs(tempDelta);
  const absPrecip = Math.abs(precipDelta);
  if (absTemp >= 5 || absPrecip >= 80) return 'ANOMALY_SEVERITY_EXTREME';
  if (absTemp >= 3 || absPrecip >= 40) return 'ANOMALY_SEVERITY_MODERATE';
  return 'ANOMALY_SEVERITY_NORMAL';
}

/**
 * Classify anomaly type based on temperature and precipitation deltas.
 * Matches legacy thresholds exactly.
 */
function classifyType(tempDelta: number, precipDelta: number): AnomalyType {
  const absTemp = Math.abs(tempDelta);
  const absPrecip = Math.abs(precipDelta);
  if (absTemp >= absPrecip / 20) {
    if (tempDelta > 0 && precipDelta < -20) return 'ANOMALY_TYPE_MIXED';
    if (tempDelta > 3) return 'ANOMALY_TYPE_WARM';
    if (tempDelta < -3) return 'ANOMALY_TYPE_COLD';
  }
  if (precipDelta > 40) return 'ANOMALY_TYPE_WET';
  if (precipDelta < -40) return 'ANOMALY_TYPE_DRY';
  if (tempDelta > 0) return 'ANOMALY_TYPE_WARM';
  return 'ANOMALY_TYPE_COLD';
}

/** Compute arithmetic mean of a number array. */
function avg(arr: number[]): number {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

/**
 * Fetch climate data for a single zone from the Open-Meteo Archive API,
 * compute baseline comparison, and return a ClimateAnomaly or null.
 */
async function fetchZone(
  zone: { name: string; lat: number; lon: number },
  startDate: string,
  endDate: string,
): Promise<ClimateAnomaly | null> {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${zone.lat}&longitude=${zone.lon}&start_date=${startDate}&end_date=${endDate}&daily=temperature_2m_mean,precipitation_sum&timezone=UTC`;

  const response = await fetch(url, { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    throw new Error(`Open-Meteo ${response.status} for ${zone.name}`);
  }

  const data: any = await response.json();

  // Filter nulls: only keep indices where both temp and precip are non-null
  const rawTemps: (number | null)[] = data.daily?.temperature_2m_mean ?? [];
  const rawPrecips: (number | null)[] = data.daily?.precipitation_sum ?? [];
  const temps: number[] = [];
  const precips: number[] = [];
  for (let i = 0; i < rawTemps.length; i++) {
    if (rawTemps[i] != null && rawPrecips[i] != null) {
      temps.push(rawTemps[i]!);
      precips.push(rawPrecips[i]!);
    }
  }

  // Minimum data check: need at least 14 valid paired data points
  if (temps.length < 14) return null;

  // Split into recent (last 7) and baseline (everything before)
  const recentTemps = temps.slice(-7);
  const baselineTemps = temps.slice(0, -7);
  const recentPrecips = precips.slice(-7);
  const baselinePrecips = precips.slice(0, -7);

  // Compute deltas rounded to 1 decimal place
  const tempDelta = Math.round((avg(recentTemps) - avg(baselineTemps)) * 10) / 10;
  const precipDelta =
    Math.round((avg(recentPrecips) - avg(baselinePrecips)) * 10) / 10;

  return {
    zone: zone.name,
    location: { latitude: zone.lat, longitude: zone.lon },
    tempDelta,
    precipDelta,
    severity: classifySeverity(tempDelta, precipDelta),
    type: classifyType(tempDelta, precipDelta),
    period: `${startDate} to ${endDate}`,
  };
}

export const listClimateAnomalies: ClimateServiceHandler['listClimateAnomalies'] = async (
  _ctx: ServerContext,
  _req: ListClimateAnomaliesRequest,
): Promise<ListClimateAnomaliesResponse> => {
  // Redis shared cache
  const cached = (await getCachedJson(REDIS_CACHE_KEY)) as ListClimateAnomaliesResponse | null;
  if (cached?.anomalies?.length) return cached;

  // Compute 30-day date range
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  // Fetch all 15 zones in parallel
  const results = await Promise.allSettled(
    ZONES.map((zone) => fetchZone(zone, startDate, endDate)),
  );

  // Collect fulfilled non-null results, log errors
  const anomalies: ClimateAnomaly[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      if (result.value != null) {
        anomalies.push(result.value);
      }
    } else {
      console.error('[CLIMATE]', result.reason?.message ?? result.reason);
    }
  }

  const result: ListClimateAnomaliesResponse = { anomalies, pagination: undefined };
  if (anomalies.length > 0) {
    setCachedJson(REDIS_CACHE_KEY, result, REDIS_CACHE_TTL).catch(() => {});
  }
  return result;
};
