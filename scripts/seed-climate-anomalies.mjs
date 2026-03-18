#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'climate:anomalies:v1';
const CACHE_TTL = 10800; // 3h

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

async function fetchZone(zone, startDate, endDate) {
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

  if (temps.length < 14) return null;

  const recentTemps = temps.slice(-7);
  const baselineTemps = temps.slice(0, -7);
  const recentPrecips = precips.slice(-7);
  const baselinePrecips = precips.slice(0, -7);

  const tempDelta = Math.round((avg(recentTemps) - avg(baselineTemps)) * 10) / 10;
  const precipDelta = Math.round((avg(recentPrecips) - avg(baselinePrecips)) * 10) / 10;

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

async function fetchClimateAnomalies() {
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const results = await Promise.allSettled(
    ZONES.map((zone) => fetchZone(zone, startDate, endDate)),
  );

  const anomalies = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      if (r.value != null) anomalies.push(r.value);
    } else {
      console.log(`  [CLIMATE] ${r.reason?.message ?? r.reason}`);
    }
  }

  return { anomalies, pagination: undefined };
}

function validate(data) {
  return Array.isArray(data?.anomalies);
}

runSeed('climate', 'anomalies', CANONICAL_KEY, fetchClimateAnomalies, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'open-meteo-archive-30d',
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
