#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'radiation:observations:v1';
const CACHE_TTL = 7200;
const EPA_TIMEOUT_MS = 20_000;
const SAFECAST_TIMEOUT_MS = 20_000;
const BASELINE_WINDOW_SIZE = 168;
const BASELINE_MIN_SAMPLES = 48;
const SAFECAST_BASELINE_WINDOW_SIZE = 96;
const SAFECAST_MIN_SAMPLES = 24;
const SAFECAST_DISTANCE_KM = 120;
const SAFECAST_LOOKBACK_DAYS = 400;
const SAFECAST_CPM_PER_USV_H = 350;

const EPA_SITES = [
  { anchorId: 'us-anchorage', state: 'AK', slug: 'ANCHORAGE', name: 'Anchorage', country: 'United States', lat: 61.2181, lon: -149.9003 },
  { anchorId: 'us-san-francisco', state: 'CA', slug: 'SAN%20FRANCISCO', name: 'San Francisco', country: 'United States', lat: 37.7749, lon: -122.4194 },
  { anchorId: 'us-washington-dc', state: 'DC', slug: 'WASHINGTON', name: 'Washington, DC', country: 'United States', lat: 38.9072, lon: -77.0369 },
  { anchorId: 'us-honolulu', state: 'HI', slug: 'HONOLULU', name: 'Honolulu', country: 'United States', lat: 21.3099, lon: -157.8581 },
  { anchorId: 'us-chicago', state: 'IL', slug: 'CHICAGO', name: 'Chicago', country: 'United States', lat: 41.8781, lon: -87.6298 },
  { anchorId: 'us-boston', state: 'MA', slug: 'BOSTON', name: 'Boston', country: 'United States', lat: 42.3601, lon: -71.0589 },
  { anchorId: 'us-albany', state: 'NY', slug: 'ALBANY', name: 'Albany', country: 'United States', lat: 42.6526, lon: -73.7562 },
  { anchorId: 'us-philadelphia', state: 'PA', slug: 'PHILADELPHIA', name: 'Philadelphia', country: 'United States', lat: 39.9526, lon: -75.1652 },
  { anchorId: 'us-houston', state: 'TX', slug: 'HOUSTON', name: 'Houston', country: 'United States', lat: 29.7604, lon: -95.3698 },
  { anchorId: 'us-seattle', state: 'WA', slug: 'SEATTLE', name: 'Seattle', country: 'United States', lat: 47.6062, lon: -122.3321 },
];

const SAFECAST_SITES = [
  ...EPA_SITES.map(({ anchorId, name, country, lat, lon }) => ({ anchorId, name, country, lat, lon })),
  { anchorId: 'jp-tokyo', name: 'Tokyo', country: 'Japan', lat: 35.6895, lon: 139.6917 },
  { anchorId: 'jp-fukushima', name: 'Fukushima', country: 'Japan', lat: 37.7608, lon: 140.4747 },
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
    case 'RADIATION_SEVERITY_SPIKE': return 3;
    case 'RADIATION_SEVERITY_ELEVATED': return 2;
    default: return 1;
  }
}

function freshnessRank(value) {
  switch (value) {
    case 'RADIATION_FRESHNESS_LIVE': return 3;
    case 'RADIATION_FRESHNESS_RECENT': return 2;
    default: return 1;
  }
}

function confidenceRank(value) {
  switch (value) {
    case 'RADIATION_CONFIDENCE_HIGH': return 3;
    case 'RADIATION_CONFIDENCE_MEDIUM': return 2;
    default: return 1;
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

function downgradeConfidence(value) {
  if (value === 'RADIATION_CONFIDENCE_HIGH') return 'RADIATION_CONFIDENCE_MEDIUM';
  return 'RADIATION_CONFIDENCE_LOW';
}

function normalizeUnit(value, unit) {
  const normalizedUnit = String(unit || '').trim().replace('μ', 'u').replace('µ', 'u');
  if (!Number.isFinite(value)) return null;
  if (normalizedUnit === 'nSv/h') {
    return { value, unit: 'nSv/h', convertedFromCpm: false, directUnit: true };
  }
  if (normalizedUnit === 'uSv/h') {
    return { value: value * 1000, unit: 'nSv/h', convertedFromCpm: false, directUnit: true };
  }
  if (normalizedUnit === 'cpm') {
    return {
      value: (value / SAFECAST_CPM_PER_USV_H) * 1000,
      unit: 'nSv/h',
      convertedFromCpm: true,
      directUnit: false,
    };
  }
  return null;
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

function buildBaseObservation({
  id,
  anchorId,
  source,
  locationName,
  country,
  lat,
  lon,
  value,
  unit,
  observedAt,
  freshness,
  baselineValue,
  delta,
  zScore,
  severity,
  baselineSamples,
  convertedFromCpm,
  directUnit,
}) {
  return {
    id,
    anchorId,
    source,
    locationName,
    country,
    location: {
      latitude: lat,
      longitude: lon,
    },
    value: round(value, 1),
    unit,
    observedAt,
    freshness,
    baselineValue: round(baselineValue, 1),
    delta: round(delta, 1),
    zScore: round(zScore, 2),
    severity,
    contributingSources: [source],
    confidence: 'RADIATION_CONFIDENCE_LOW',
    corroborated: false,
    conflictingSources: false,
    convertedFromCpm,
    sourceCount: 1,
    _baselineSamples: baselineSamples,
    _directUnit: directUnit,
  };
}

function toEpaObservation(site, readings) {
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

  return buildBaseObservation({
    id: `epa:${site.state}:${site.slug}:${latest.observedAt}`,
    anchorId: site.anchorId,
    source: 'RADIATION_SOURCE_EPA_RADNET',
    locationName: site.name,
    country: site.country,
    lat: site.lat,
    lon: site.lon,
    value: latest.value,
    unit: 'nSv/h',
    observedAt: latest.observedAt,
    freshness,
    baselineValue,
    delta,
    zScore,
    severity,
    baselineSamples: baselineValues.length,
    convertedFromCpm: false,
    directUnit: true,
  });
}

function toSafecastObservation(site, measurements) {
  if (measurements.length < 2) return null;

  const latest = measurements[measurements.length - 1];
  const freshness = classifyFreshness(latest.observedAt);
  const baselineReadings = measurements.slice(-1 - SAFECAST_BASELINE_WINDOW_SIZE, -1);
  const baselineValues = baselineReadings.map((reading) => reading.value);
  const baselineValue = baselineValues.length > 0 ? average(baselineValues) : latest.value;
  const sigma = baselineValues.length >= SAFECAST_MIN_SAMPLES ? stdDev(baselineValues, baselineValue) : 0;
  const delta = latest.value - baselineValue;
  const zScore = sigma > 0 ? delta / sigma : 0;
  const severity = classifySeverity(delta, zScore, freshness);

  return buildBaseObservation({
    id: `safecast:${site.anchorId}:${latest.id ?? latest.observedAt}`,
    anchorId: site.anchorId,
    source: 'RADIATION_SOURCE_SAFECAST',
    locationName: latest.locationName || site.name,
    country: site.country,
    lat: latest.lat,
    lon: latest.lon,
    value: latest.value,
    unit: latest.unit,
    observedAt: latest.observedAt,
    freshness,
    baselineValue,
    delta,
    zScore,
    severity,
    baselineSamples: baselineValues.length,
    convertedFromCpm: latest.convertedFromCpm,
    directUnit: latest.directUnit,
  });
}

function baseConfidence(observation) {
  if (observation.freshness === 'RADIATION_FRESHNESS_HISTORICAL') return 'RADIATION_CONFIDENCE_LOW';
  if (observation.convertedFromCpm) return 'RADIATION_CONFIDENCE_LOW';
  if (observation._baselineSamples >= BASELINE_MIN_SAMPLES) return 'RADIATION_CONFIDENCE_MEDIUM';
  if (observation._directUnit && observation._baselineSamples >= SAFECAST_MIN_SAMPLES) return 'RADIATION_CONFIDENCE_MEDIUM';
  return 'RADIATION_CONFIDENCE_LOW';
}

function observationPriority(observation) {
  return (
    severityRank(observation.severity) * 10000 +
    freshnessRank(observation.freshness) * 1000 +
    (observation._directUnit ? 200 : 0) +
    Math.min(observation._baselineSamples || 0, 199)
  );
}

function supportsSameSignal(primary, secondary) {
  if (primary.severity === 'RADIATION_SEVERITY_NORMAL' && secondary.severity === 'RADIATION_SEVERITY_NORMAL') {
    return Math.abs(primary.value - secondary.value) <= 15;
  }
  if (primary.severity !== 'RADIATION_SEVERITY_NORMAL' && secondary.severity !== 'RADIATION_SEVERITY_NORMAL') {
    const sameDirection = Math.sign(primary.delta || 0.1) === Math.sign(secondary.delta || 0.1);
    return sameDirection && Math.abs(primary.delta - secondary.delta) <= 20;
  }
  return false;
}

function materiallyConflicts(primary, secondary) {
  if (primary.severity === 'RADIATION_SEVERITY_NORMAL' && secondary.severity === 'RADIATION_SEVERITY_NORMAL') {
    return false;
  }
  if (primary.severity === 'RADIATION_SEVERITY_NORMAL' || secondary.severity === 'RADIATION_SEVERITY_NORMAL') {
    return true;
  }
  const oppositeDirection = Math.sign(primary.delta || 0.1) !== Math.sign(secondary.delta || 0.1);
  return oppositeDirection || Math.abs(primary.delta - secondary.delta) > 30;
}

function finalizeObservationGroup(group) {
  const sorted = [...group].sort((a, b) => {
    const priorityDelta = observationPriority(b) - observationPriority(a);
    if (priorityDelta !== 0) return priorityDelta;
    return b.observedAt - a.observedAt;
  });
  const primary = sorted[0];
  if (!primary) {
    throw new Error('Cannot finalize empty radiation observation group');
  }
  const distinctSources = [...new Set(sorted.map((observation) => observation.source))];
  const alternateSources = sorted.filter((observation) => observation.source !== primary.source);
  const corroborated = alternateSources.some((observation) => supportsSameSignal(primary, observation));
  const conflictingSources = alternateSources.some((observation) => materiallyConflicts(primary, observation));

  let confidence = baseConfidence(primary);
  if (corroborated && distinctSources.length >= 2) confidence = 'RADIATION_CONFIDENCE_HIGH';
  if (conflictingSources) confidence = downgradeConfidence(confidence);

  return {
    id: primary.id,
    source: primary.source,
    locationName: primary.locationName,
    country: primary.country,
    location: primary.location,
    value: primary.value,
    unit: primary.unit,
    observedAt: primary.observedAt,
    freshness: primary.freshness,
    baselineValue: primary.baselineValue,
    delta: primary.delta,
    zScore: primary.zScore,
    severity: primary.severity,
    contributingSources: distinctSources,
    confidence,
    corroborated,
    conflictingSources,
    convertedFromCpm: sorted.some((observation) => observation.convertedFromCpm),
    sourceCount: distinctSources.length,
  };
}

function sortFinalObservations(a, b) {
  const severityDelta = severityRank(b.severity) - severityRank(a.severity);
  if (severityDelta !== 0) return severityDelta;
  const confidenceDelta = confidenceRank(b.confidence) - confidenceRank(a.confidence);
  if (confidenceDelta !== 0) return confidenceDelta;
  if (a.corroborated !== b.corroborated) return a.corroborated ? -1 : 1;
  const freshnessDelta = freshnessRank(b.freshness) - freshnessRank(a.freshness);
  if (freshnessDelta !== 0) return freshnessDelta;
  return b.observedAt - a.observedAt;
}

function summarizeObservations(observations) {
  const sorted = [...observations].sort(sortFinalObservations);
  return {
    observations: sorted,
    fetchedAt: Date.now(),
    epaCount: sorted.filter((item) => item.contributingSources.includes('RADIATION_SOURCE_EPA_RADNET')).length,
    safecastCount: sorted.filter((item) => item.contributingSources.includes('RADIATION_SOURCE_SAFECAST')).length,
    anomalyCount: sorted.filter((item) => item.severity !== 'RADIATION_SEVERITY_NORMAL').length,
    elevatedCount: sorted.filter((item) => item.severity === 'RADIATION_SEVERITY_ELEVATED').length,
    spikeCount: sorted.filter((item) => item.severity === 'RADIATION_SEVERITY_SPIKE').length,
    corroboratedCount: sorted.filter((item) => item.corroborated).length,
    lowConfidenceCount: sorted.filter((item) => item.confidence === 'RADIATION_CONFIDENCE_LOW').length,
    conflictingCount: sorted.filter((item) => item.conflictingSources).length,
    convertedFromCpmCount: sorted.filter((item) => item.convertedFromCpm).length,
  };
}

async function fetchEpaObservation(site, year) {
  const url = `https://radnet.epa.gov/cdx-radnet-rest/api/rest/csv/${year}/fixed/${site.state}/${site.slug}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(EPA_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`EPA RadNet ${response.status} for ${site.name}`);
  const csv = await response.text();
  return toEpaObservation(site, parseApprovedReadings(csv));
}

async function fetchSafecastObservation(site, capturedAfter) {
  const params = new URLSearchParams({
    distance: String(SAFECAST_DISTANCE_KM),
    latitude: String(site.lat),
    longitude: String(site.lon),
    captured_after: capturedAfter,
  });
  const response = await fetch(`https://api.safecast.org/measurements.json?${params.toString()}`, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(SAFECAST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Safecast ${response.status} for ${site.name}`);

  const measurements = await response.json();
  const normalized = (Array.isArray(measurements) ? measurements : [])
    .map((measurement) => {
      const numericValue = Number(measurement?.value);
      const normalizedUnit = normalizeUnit(numericValue, measurement?.unit);
      const observedAt = measurement?.captured_at ? Date.parse(measurement.captured_at) : NaN;
      const lat = Number(measurement?.latitude);
      const lon = Number(measurement?.longitude);

      if (!normalizedUnit || !Number.isFinite(observedAt) || !Number.isFinite(lat) || !Number.isFinite(lon)) {
        return null;
      }

      return {
        id: measurement?.id ?? null,
        locationName: typeof measurement?.location_name === 'string' ? measurement.location_name.trim() : '',
        observedAt,
        lat,
        lon,
        value: normalizedUnit.value,
        unit: normalizedUnit.unit,
        convertedFromCpm: normalizedUnit.convertedFromCpm,
        directUnit: normalizedUnit.directUnit,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.observedAt - b.observedAt);

  return toSafecastObservation(site, normalized);
}

async function fetchRadiationWatch() {
  const currentYear = new Date().getUTCFullYear();
  const capturedAfter = new Date(Date.now() - SAFECAST_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const results = await Promise.allSettled([
    ...EPA_SITES.map((site) => fetchEpaObservation(site, currentYear)),
    ...SAFECAST_SITES.map((site) => fetchSafecastObservation(site, capturedAfter)),
  ]);

  const grouped = new Map();
  for (const result of results) {
    if (result.status !== 'fulfilled') {
      console.log(`  [RADIATION] ${result.reason?.message ?? result.reason}`);
      continue;
    }
    if (!result.value) continue;

    const group = grouped.get(result.value.anchorId) || [];
    group.push(result.value);
    grouped.set(result.value.anchorId, group);
  }

  const observations = [...grouped.values()].map((group) => finalizeObservationGroup(group));
  return summarizeObservations(observations);
}

function validate(data) {
  return Array.isArray(data?.observations) && data.observations.length > 0;
}

runSeed('radiation', 'observations', CANONICAL_KEY, fetchRadiationWatch, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'epa-radnet-safecast-merge-v1',
  recordCount: (data) => data?.observations?.length ?? 0,
}).catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
