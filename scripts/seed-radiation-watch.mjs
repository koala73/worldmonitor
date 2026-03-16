#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'radiation:observations:v1';
const CACHE_TTL = 7200;
const EPA_TIMEOUT_MS = 20_000;
const BASELINE_WINDOW_SIZE = 168;
const BASELINE_MIN_SAMPLES = 48;

const EPA_SITES = [
  { state: 'AK', slug: 'ANCHORAGE', name: 'Anchorage', country: 'United States', lat: 61.2181, lon: -149.9003 },
  { state: 'CA', slug: 'SAN%20FRANCISCO', name: 'San Francisco', country: 'United States', lat: 37.7749, lon: -122.4194 },
  { state: 'DC', slug: 'WASHINGTON', name: 'Washington, DC', country: 'United States', lat: 38.9072, lon: -77.0369 },
  { state: 'HI', slug: 'HONOLULU', name: 'Honolulu', country: 'United States', lat: 21.3099, lon: -157.8581 },
  { state: 'IL', slug: 'CHICAGO', name: 'Chicago', country: 'United States', lat: 41.8781, lon: -87.6298 },
  { state: 'MA', slug: 'BOSTON', name: 'Boston', country: 'United States', lat: 42.3601, lon: -71.0589 },
  { state: 'NY', slug: 'ALBANY', name: 'Albany', country: 'United States', lat: 42.6526, lon: -73.7562 },
  { state: 'PA', slug: 'PHILADELPHIA', name: 'Philadelphia', country: 'United States', lat: 39.9526, lon: -75.1652 },
  { state: 'TX', slug: 'HOUSTON', name: 'Houston', country: 'United States', lat: 29.7604, lon: -95.3698 },
  { state: 'WA', slug: 'SEATTLE', name: 'Seattle', country: 'United States', lat: 47.6062, lon: -122.3321 },
];

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function parseRadNetTimestamp(raw) {
  const match = String(raw || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, month, day, year, hour, minute, second] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
}

function classifyFreshness(observedAt) {
  const ageMs = Date.now() - observedAt;
  if (ageMs <= 6 * 60 * 60 * 1000) return 'RADIATION_FRESHNESS_LIVE';
  if (ageMs <= 14 * 24 * 60 * 60 * 1000) return 'RADIATION_FRESHNESS_RECENT';
  return 'RADIATION_FRESHNESS_HISTORICAL';
}

function classifySeverity(delta, zScore, freshness) {
  if (freshness === 'RADIATION_FRESHNESS_HISTORICAL') return 'RADIATION_SEVERITY_NORMAL';
  if (delta >= 15 || zScore >= 3) return 'RADIATION_SEVERITY_SPIKE';
  if (delta >= 8 || zScore >= 2) return 'RADIATION_SEVERITY_ELEVATED';
  return 'RADIATION_SEVERITY_NORMAL';
}

function severityRank(value) {
  switch (value) {
    case 'RADIATION_SEVERITY_SPIKE': return 0;
    case 'RADIATION_SEVERITY_ELEVATED': return 1;
    default: return 2;
  }
}

function freshnessRank(value) {
  switch (value) {
    case 'RADIATION_FRESHNESS_LIVE': return 0;
    case 'RADIATION_FRESHNESS_RECENT': return 1;
    default: return 2;
  }
}

function average(values) {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function stdDev(values, mean) {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1);
  return Math.sqrt(Math.max(variance, 0));
}

function parseApprovedReadings(csv) {
  const lines = String(csv || '').trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const readings = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const columns = line.split(',');
    if (columns.length < 3) continue;
    const status = columns[columns.length - 1]?.trim().toUpperCase();
    if (status !== 'APPROVED') continue;
    const observedAt = parseRadNetTimestamp(columns[1] ?? '');
    const value = Number(columns[2] ?? '');
    if (!observedAt || !Number.isFinite(value)) continue;
    readings.push({ observedAt, value });
  }

  return readings.sort((a, b) => a.observedAt - b.observedAt);
}

function toObservation(site, readings) {
  if (readings.length < 2) return null;

  const latest = readings[readings.length - 1];
  const freshness = classifyFreshness(latest.observedAt);
  const baselineReadings = readings.slice(-1 - BASELINE_WINDOW_SIZE, -1);
  const baselineValues = baselineReadings.map((reading) => reading.value);
  const baselineValue = baselineValues.length > 0 ? average(baselineValues) : latest.value;
  const sigma = baselineValues.length >= BASELINE_MIN_SAMPLES ? stdDev(baselineValues, baselineValue) : 0;
  const delta = latest.value - baselineValue;
  const zScore = sigma > 0 ? delta / sigma : 0;
  const severity = classifySeverity(delta, zScore, freshness);

  return {
    id: `epa:${site.state}:${site.slug}:${latest.observedAt}`,
    source: 'RADIATION_SOURCE_EPA_RADNET',
    locationName: site.name,
    country: site.country,
    location: {
      latitude: site.lat,
      longitude: site.lon,
    },
    value: round(latest.value, 1),
    unit: 'nSv/h',
    observedAt: latest.observedAt,
    freshness,
    baselineValue: round(baselineValue, 1),
    delta: round(delta, 1),
    zScore: round(zScore, 2),
    severity,
  };
}

async function fetchSiteObservation(site, year) {
  const url = `https://radnet.epa.gov/cdx-radnet-rest/api/rest/csv/${year}/fixed/${site.state}/${site.slug}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(EPA_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`EPA RadNet ${response.status} for ${site.name}`);
  const csv = await response.text();
  return toObservation(site, parseApprovedReadings(csv));
}

async function fetchRadiationWatch() {
  const currentYear = new Date().getUTCFullYear();
  const results = await Promise.allSettled(
    EPA_SITES.map((site) => fetchSiteObservation(site, currentYear)),
  );

  const observations = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      if (result.value) observations.push(result.value);
    } else {
      console.log(`  [RADIATION] ${result.reason?.message ?? result.reason}`);
    }
  }

  observations.sort((a, b) => {
    const severityDelta = severityRank(a.severity) - severityRank(b.severity);
    if (severityDelta !== 0) return severityDelta;
    const freshnessDelta = freshnessRank(a.freshness) - freshnessRank(b.freshness);
    if (freshnessDelta !== 0) return freshnessDelta;
    return b.observedAt - a.observedAt;
  });

  return {
    observations,
    fetchedAt: Date.now(),
    epaCount: observations.length,
    safecastCount: 0,
    anomalyCount: observations.filter((item) => item.severity !== 'RADIATION_SEVERITY_NORMAL').length,
    elevatedCount: observations.filter((item) => item.severity === 'RADIATION_SEVERITY_ELEVATED').length,
    spikeCount: observations.filter((item) => item.severity === 'RADIATION_SEVERITY_SPIKE').length,
  };
}

function validate(data) {
  return Array.isArray(data?.observations) && data.observations.length > 0;
}

runSeed('radiation', 'observations', CANONICAL_KEY, fetchRadiationWatch, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'epa-radnet-baseline-v1',
}).catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
