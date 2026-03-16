import type {
  ListRadiationObservationsRequest,
  ListRadiationObservationsResponse,
  RadiationFreshness,
  RadiationObservation,
  RadiationSeverity,
  RadiationServiceHandler,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/radiation/v1/service_server';

import { CHROME_UA } from '../../../_shared/constants';
import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'radiation:observations:v1';
const LIVE_FALLBACK_CACHE_KEY = 'radiation:observations:live:v1';
const REDIS_CACHE_TTL = 15 * 60;
const SEED_FRESHNESS_MS = 90 * 60 * 1000;
const DEFAULT_MAX_ITEMS = 18;
const MAX_ITEMS_LIMIT = 25;
const EPA_TIMEOUT_MS = 20_000;
const BASELINE_WINDOW_SIZE = 168; // Last 7 days of hourly readings
const BASELINE_MIN_SAMPLES = 48;

type EpaSite = {
  state: string;
  slug: string;
  name: string;
  country: string;
  lat: number;
  lon: number;
};

type SafecastSite = {
  name: string;
  country: string;
  lat: number;
  lon: number;
};

type SafecastMeasurement = {
  id?: number;
  value?: number;
  unit?: string;
  location_name?: string | null;
  captured_at?: string;
  latitude?: number;
  longitude?: number;
};

type RadNetReading = {
  observedAt: number;
  value: number;
};

const EPA_SITES: EpaSite[] = [
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

// Safecast remains in the contract, but its public API is not yet reliable via
// the runtime fetch path used by this service. Phase 1 ships EPA coverage first.
const SAFECAST_SITES: SafecastSite[] = [];

function clampMaxItems(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_ITEMS;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_ITEMS_LIMIT);
}

function classifyFreshness(observedAt: number): RadiationFreshness {
  const ageMs = Date.now() - observedAt;
  if (ageMs <= 6 * 60 * 60 * 1000) return 'RADIATION_FRESHNESS_LIVE';
  if (ageMs <= 14 * 24 * 60 * 60 * 1000) return 'RADIATION_FRESHNESS_RECENT';
  return 'RADIATION_FRESHNESS_HISTORICAL';
}

function classifySeverity(
  delta: number,
  zScore: number,
  freshness: RadiationFreshness,
): RadiationSeverity {
  if (freshness === 'RADIATION_FRESHNESS_HISTORICAL') {
    return 'RADIATION_SEVERITY_NORMAL';
  }
  if (delta >= 15 || zScore >= 3) return 'RADIATION_SEVERITY_SPIKE';
  if (delta >= 8 || zScore >= 2) return 'RADIATION_SEVERITY_ELEVATED';
  return 'RADIATION_SEVERITY_NORMAL';
}

function severityRank(value: RadiationSeverity): number {
  switch (value) {
    case 'RADIATION_SEVERITY_SPIKE':
      return 0;
    case 'RADIATION_SEVERITY_ELEVATED':
      return 1;
    default:
      return 2;
  }
}

function freshnessRank(value: RadiationFreshness): number {
  switch (value) {
    case 'RADIATION_FRESHNESS_LIVE':
      return 0;
    case 'RADIATION_FRESHNESS_RECENT':
      return 1;
    default:
      return 2;
  }
}

function parseRadNetTimestamp(raw: string): number | null {
  const match = raw.trim().match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
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

function normalizeUnit(value: number, unit: string): { value: number; unit: string } | null {
  const normalizedUnit = unit.trim().replace('μ', 'u');
  if (normalizedUnit === 'nSv/h') return { value, unit: 'nSv/h' };
  if (normalizedUnit === 'uSv/h') return { value: value * 1000, unit: 'nSv/h' };
  return null;
}

function parseApprovedRadNetReadings(csv: string): RadNetReading[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const readings: RadNetReading[] = [];

  for (let i = lines.length - 1; i >= 1; i -= 1) {
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

function average(values: number[]): number {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function stdDev(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1);
  return Math.sqrt(Math.max(variance, 0));
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function buildRadNetObservation(
  site: EpaSite,
  readings: RadNetReading[],
): RadiationObservation | null {
  if (readings.length < 2) return null;

  const latest = readings[readings.length - 1];
  if (!latest) return null;

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

function summarizeObservations(
  observations: RadiationObservation[],
  fetchedAt: number,
  maxItems: number,
): ListRadiationObservationsResponse {
  const sorted = [...observations].sort((a, b) => {
    const severityDelta = severityRank(a.severity) - severityRank(b.severity);
    if (severityDelta !== 0) return severityDelta;
    const freshnessDelta = freshnessRank(a.freshness) - freshnessRank(b.freshness);
    if (freshnessDelta !== 0) return freshnessDelta;
    return b.observedAt - a.observedAt;
  });

  return {
    observations: sorted.slice(0, maxItems),
    fetchedAt,
    epaCount: observations.filter((item) => item.source === 'RADIATION_SOURCE_EPA_RADNET').length,
    safecastCount: observations.filter((item) => item.source === 'RADIATION_SOURCE_SAFECAST').length,
    anomalyCount: observations.filter((item) => item.severity !== 'RADIATION_SEVERITY_NORMAL').length,
    elevatedCount: observations.filter((item) => item.severity === 'RADIATION_SEVERITY_ELEVATED').length,
    spikeCount: observations.filter((item) => item.severity === 'RADIATION_SEVERITY_SPIKE').length,
  };
}

function trimSeededResponse(
  data: ListRadiationObservationsResponse,
  maxItems: number,
): ListRadiationObservationsResponse {
  return {
    ...data,
    observations: (data.observations ?? []).slice(0, maxItems),
  };
}

async function trySeededData(maxItems: number): Promise<ListRadiationObservationsResponse | null> {
  try {
    const [seedData, seedMeta] = await Promise.all([
      getCachedJson(REDIS_CACHE_KEY, true) as Promise<ListRadiationObservationsResponse | null>,
      getCachedJson('seed-meta:radiation:observations', true) as Promise<{ fetchedAt?: number } | null>,
    ]);

    if (!seedData?.observations?.length) return null;

    const fetchedAt = seedMeta?.fetchedAt ?? 0;
    const isFresh = Date.now() - fetchedAt < SEED_FRESHNESS_MS;
    if (isFresh || !process.env.SEED_FALLBACK_RADIATION) {
      return trimSeededResponse(seedData, maxItems);
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchEpaObservation(site: EpaSite, year: number): Promise<RadiationObservation | null> {
  const url = `https://radnet.epa.gov/cdx-radnet-rest/api/rest/csv/${year}/fixed/${site.state}/${site.slug}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(EPA_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`EPA RadNet ${response.status} for ${site.name}`);
  }

  const csv = await response.text();
  const readings = parseApprovedRadNetReadings(csv);
  return buildRadNetObservation(site, readings);
}

async function fetchSafecastObservation(site: SafecastSite, capturedAfter: string): Promise<RadiationObservation | null> {
  const params = new URLSearchParams({
    distance: '120',
    latitude: String(site.lat),
    longitude: String(site.lon),
    captured_after: capturedAfter,
  });
  const url = `https://api.safecast.org/measurements.json?${params.toString()}`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Safecast ${response.status} for ${site.name}`);
  }

  const measurements = await response.json() as SafecastMeasurement[];
  const latest = (measurements ?? [])
    .map((measurement) => {
      const numericValue = Number(measurement.value);
      const normalized = Number.isFinite(numericValue) && measurement.unit
        ? normalizeUnit(numericValue, measurement.unit)
        : null;
      const observedAt = measurement.captured_at ? Date.parse(measurement.captured_at) : NaN;
      const latitude = Number(measurement.latitude);
      const longitude = Number(measurement.longitude);

      if (!normalized || !Number.isFinite(observedAt) || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return null;
      }

      return {
        measurement,
        normalized,
        observedAt,
        latitude,
        longitude,
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((a, b) => b.observedAt - a.observedAt)[0];

  if (!latest) return null;

  return {
    id: `safecast:${latest.measurement.id ?? `${site.name}:${latest.observedAt}`}`,
    source: 'RADIATION_SOURCE_SAFECAST',
    locationName: latest.measurement.location_name?.trim() || site.name,
    country: site.country,
    location: {
      latitude: latest.latitude,
      longitude: latest.longitude,
    },
    value: latest.normalized.value,
    unit: latest.normalized.unit,
    observedAt: latest.observedAt,
    freshness: classifyFreshness(latest.observedAt),
    baselineValue: latest.normalized.value,
    delta: 0,
    zScore: 0,
    severity: 'RADIATION_SEVERITY_NORMAL',
  };
}

async function collectObservations(maxItems: number): Promise<ListRadiationObservationsResponse> {
  const currentYear = new Date().getUTCFullYear();

  const results = await Promise.allSettled([
    ...EPA_SITES.map((site) => fetchEpaObservation(site, currentYear)),
    ...SAFECAST_SITES.map((site) => fetchSafecastObservation(site, '2025-01-01')),
  ]);

  const observations: RadiationObservation[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      if (result.value) observations.push(result.value);
      continue;
    }
    console.error('[RADIATION]', result.reason?.message ?? result.reason);
  }

  return summarizeObservations(observations, Date.now(), maxItems);
}

export const listRadiationObservations: RadiationServiceHandler['listRadiationObservations'] = async (
  _ctx: ServerContext,
  req: ListRadiationObservationsRequest,
): Promise<ListRadiationObservationsResponse> => {
  const maxItems = clampMaxItems(req.maxItems);
  try {
    const seeded = await trySeededData(maxItems);
    if (seeded) return seeded;

    return await cachedFetchJson<ListRadiationObservationsResponse>(
      `${LIVE_FALLBACK_CACHE_KEY}:${maxItems}`,
      REDIS_CACHE_TTL,
      async () => collectObservations(maxItems),
    ) ?? {
      observations: [],
      fetchedAt: Date.now(),
      epaCount: 0,
      safecastCount: 0,
      anomalyCount: 0,
      elevatedCount: 0,
      spikeCount: 0,
    };
  } catch {
    return {
      observations: [],
      fetchedAt: Date.now(),
      epaCount: 0,
      safecastCount: 0,
      anomalyCount: 0,
      elevatedCount: 0,
      spikeCount: 0,
    };
  }
};
