#!/usr/bin/env node
/**
 * seed-climate-anomalies.mjs
 *
 * Computes climate anomalies by comparing current 7-day means against
 * WMO 30-year climatological normals (1991-2020) for the current calendar month.
 *
 * The previous approach of comparing against the previous 23 days of the same
 * 30-day window was climatologically wrong — a sustained heat wave during a
 * uniformly hot month would not appear anomalous because the baseline was
 * equally hot.
 */

import { loadEnvFile, CHROME_UA, runSeed, getRedisCredentials } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'climate:anomalies:v1';
const CACHE_TTL = 10800; // 3h
const ZONE_NORMALS_KEY = 'climate:zone-normals:v1';

// Geopolitical zones (original 15)
const ZONES = [
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

// Climate-specific zones (7 new zones)
const CLIMATE_ZONES = [
  { name: 'Arctic', lat: 70.0, lon: 0.0 },
  { name: 'Greenland', lat: 72.0, lon: -42.0 },
  { name: 'WestAntarctic', lat: -78.0, lon: -100.0 },
  { name: 'TibetanPlateau', lat: 31.0, lon: 91.0 },
  { name: 'CongoBasin', lat: -1.0, lon: 24.0 },
  { name: 'CoralTriangle', lat: -5.0, lon: 128.0 },
  { name: 'NorthAtlantic', lat: 55.0, lon: -30.0 },
];

const ALL_ZONES = [...ZONES, ...CLIMATE_ZONES];

function avg(arr) {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

function classifySeverity(tempDelta, precipDelta) {
  const absTemp = Math.abs(tempDelta);
  const absPrecip = Math.abs(precipDelta);
  if (absTemp >= 5 || absPrecip >= 80) return 'ANOMALY_SEVERITY_EXTREME';
  if (absTemp >= 3 || absPrecip >= 40) return 'ANOMALY_SEVERITY_MODERATE';
  return 'ANOMALY_SEVERITY_NORMAL';
}

function classifyType(tempDelta, precipDelta) {
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

/**
 * Fetch zone normals from Redis cache.
 * Returns a map of zone name -> { tempMean, precipMean } for the current month.
 */
async function fetchZoneNormalsFromRedis() {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(`${url}/get/${encodeURIComponent(ZONE_NORMALS_KEY)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) {
    console.log('[CLIMATE] Zone normals not in cache — normals seeder may not have run yet');
    return null;
  }

  const data = await resp.json();
  if (!data.result) return null;

  try {
    const parsed = JSON.parse(data.result);
    return parsed.zones || null;
  } catch {
    return null;
  }
}

/**
 * Fetch current conditions for a zone and compare against WMO normals.
 */
async function fetchZone(zone, normals, startDate, endDate) {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${zone.lat}&longitude=${zone.lon}&start_date=${startDate}&end_date=${endDate}&daily=temperature_2m_mean,precipitation_sum&timezone=UTC`;

  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`Open-Meteo ${resp.status} for ${zone.name}`);

  const data = await resp.json();

  const rawTemps = data.daily?.temperature_2m_mean ?? [];
  const rawPrecips = data.daily?.precipitation_sum ?? [];
  const temps = [];
  const precips = [];
  for (let i = 0; i < rawTemps.length; i++) {
    if (rawTemps[i] != null && rawPrecips[i] != null) {
      temps.push(rawTemps[i]);
      precips.push(rawPrecips[i]);
    }
  }

  if (temps.length < 7) return null;

  // Use last 7 days as current period
  const recentTemps = temps.slice(-7);
  const recentPrecips = precips.slice(-7);

  const currentTempMean = avg(recentTemps);
  const currentPrecipMean = avg(recentPrecips);

  // Find the normal for this zone and current month
  const currentMonth = new Date().getMonth() + 1; // 1-12
  const zoneNormal = normals?.find((n) => n.zone === zone.name);

  if (!zoneNormal) {
    // Fallback: compute from previous 30 days if normals not available
    // (This is the old behavior for backwards compatibility during transition)
    const baselineTemps = temps.slice(0, -7);
    const baselinePrecips = precips.slice(0, -7);

    if (baselineTemps.length < 7) return null;

    const baselineTempMean = avg(baselineTemps);
    const baselinePrecipMean = avg(baselinePrecips);

    const tempDelta = Math.round((currentTempMean - baselineTempMean) * 10) / 10;
    const precipDelta = Math.round((currentPrecipMean - baselinePrecipMean) * 10) / 10;

    return {
      zone: zone.name,
      location: { latitude: zone.lat, longitude: zone.lon },
      tempDelta,
      precipDelta,
      severity: classifySeverity(tempDelta, precipDelta),
      type: classifyType(tempDelta, precipDelta),
      period: `${startDate} to ${endDate}`,
      baselineSource: 'rolling-30d-fallback',
    };
  }

  // Use WMO normal for current month
  const monthNormal = zoneNormal.normals?.find((n) => n.month === currentMonth);

  if (!monthNormal) {
    console.log(`[CLIMATE] ${zone.name}: No normal for month ${currentMonth}`);
    return null;
  }

  const tempDelta = Math.round((currentTempMean - monthNormal.tempMean) * 10) / 10;
  const precipDelta = Math.round((currentPrecipMean - monthNormal.precipMean) * 10) / 10;

  return {
    zone: zone.name,
    location: { latitude: zone.lat, longitude: zone.lon },
    tempDelta,
    precipDelta,
    severity: classifySeverity(tempDelta, precipDelta),
    type: classifyType(tempDelta, precipDelta),
    period: `${startDate} to ${endDate}`,
    baselineSource: 'wmo-30y-normals',
    baseline: {
      tempMean: monthNormal.tempMean,
      precipMean: monthNormal.precipMean,
      month: monthNormal.monthName,
      period: zoneNormal.period,
    },
  };
}

async function fetchClimateAnomalies() {
  const endDate = new Date().toISOString().slice(0, 10);

  // Try to fetch WMO normals from Redis
  const normals = await fetchZoneNormalsFromRedis();
  const hasNormals = normals && normals.length > 0;

  if (hasNormals) {
    console.log(`[CLIMATE] Using WMO 30-year normals for ${normals.length} zones`);
  } else {
    console.log('[CLIMATE] Normals not available — using 30-day rolling fallback');
  }

  // If normals are available, fetch 7 days of data for current period comparison
  // If normals are NOT available, fetch 30 days so the fallback can split into baseline + current
  const daysToFetch = hasNormals ? 7 : 30;
  const startDate = new Date(Date.now() - daysToFetch * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const anomalies = [];
  let failures = 0;
  for (const zone of ALL_ZONES) {
    try {
      const result = await fetchZone(zone, normals, startDate, endDate);
      if (result != null) anomalies.push(result);
    } catch (err) {
      console.log(`  [CLIMATE] ${err?.message ?? err}`);
      failures++;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  const MIN_ZONES = Math.ceil(ALL_ZONES.length * 2 / 3);
  if (anomalies.length < MIN_ZONES) {
    throw new Error(`Only ${anomalies.length}/${ALL_ZONES.length} zones returned data (${failures} errors) — skipping write to preserve previous Redis data`);
  }

  return { anomalies, pagination: undefined };
}

function validate(data) {
  return Array.isArray(data?.anomalies) && data.anomalies.length >= Math.ceil(ALL_ZONES.length * 2 / 3);
}

runSeed('climate', 'anomalies', CANONICAL_KEY, fetchClimateAnomalies, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'open-meteo-archive-wmo-normals',
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
