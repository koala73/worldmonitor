#!/usr/bin/env node

import {
  acquireLockSafely,
  CHROME_UA,
  extendExistingTtl,
  getRedisCredentials,
  loadEnvFile,
  logSeedResult,
  releaseLock,
  verifySeedKey,
  withRetry,
} from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

export const HEALTH_AIR_QUALITY_KEY = 'health:air-quality:v1';
export const CLIMATE_AIR_QUALITY_KEY = 'climate:air-quality:v1';
export const CACHE_TTL = 10800; // 3h — 3× the 1h cron cadence (gold standard: TTL ≥ 3× interval)
export const AIR_QUALITY_WINDOW_MS = 2 * 60 * 60 * 1000;
export const OPENAQ_META_KEY = 'seed-meta:health:air-quality';
export const CLIMATE_META_KEY = 'seed-meta:climate:air-quality';
export const OPENAQ_SOURCE_VERSION = 'openaq-v3-pm25-waqi-optional-v2';

const OPENAQ_LOCATIONS_URL = 'https://api.openaq.org/v3/locations';
const OPENAQ_PM25_LATEST_URL = 'https://api.openaq.org/v3/parameters/2/latest';
const OPENAQ_PAGE_LIMIT = 1000;
const OPENAQ_MAX_PAGES = 20;
// Worst case: 2 OpenAQ calls × 20 pages × (30s timeout × 3 attempts) ≈ 3600s
const AIR_QUALITY_LOCK_TTL_MS = 3_600_000;

// The product only exposes four buckets, so EPA's sensitive/unhealthy/very-unhealthy
// bands are collapsed into a single "unhealthy" level.
const EPA_PM25_BREAKPOINTS = [
  { cLow: 0.0, cHigh: 12.0, iLow: 0, iHigh: 50 },
  { cLow: 12.1, cHigh: 35.4, iLow: 51, iHigh: 100 },
  { cLow: 35.5, cHigh: 55.4, iLow: 101, iHigh: 150 },
  { cLow: 55.5, cHigh: 150.4, iLow: 151, iHigh: 200 },
  { cLow: 150.5, cHigh: 250.4, iLow: 201, iHigh: 300 },
  { cLow: 250.5, cHigh: 350.4, iLow: 301, iHigh: 400 },
  { cLow: 350.5, cHigh: 500.4, iLow: 401, iHigh: 500 },
];

const WAQI_WORLD_TILES = [
  '-55,-180,0,-60',
  '-55,-60,0,60',
  '-55,60,0,180',
  '0,-180,55,-60',
  '0,-60,55,60',
  '0,60,55,180',
];

class SeedConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SeedConfigurationError';
    this.code = 'SEED_CONFIGURATION_ERROR';
    this.retryable = false;
  }
}

function toFiniteNumber(value) {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeCountryCode(value) {
  const code = trimString(value).toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : '';
}

function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundTo(value, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function truncatePm25(value) {
  return Math.floor(value * 10) / 10;
}

export function computeUsAqiFromPm25(pm25) {
  const numeric = toFiniteNumber(pm25);
  if (numeric == null || numeric < 0) return 0;
  const concentration = Math.min(truncatePm25(numeric), 500.4);
  const breakpoint = EPA_PM25_BREAKPOINTS.find(({ cHigh }) => concentration <= cHigh) ?? EPA_PM25_BREAKPOINTS.at(-1);
  const ratio = (breakpoint.iHigh - breakpoint.iLow) / (breakpoint.cHigh - breakpoint.cLow);
  return Math.max(0, Math.min(500, Math.round((ratio * (concentration - breakpoint.cLow)) + breakpoint.iLow)));
}

export function classifyRiskLevel(aqi) {
  const numeric = Math.max(0, Math.min(500, Math.round(toFiniteNumber(aqi) ?? 0)));
  if (numeric <= 50) return 'good';
  if (numeric <= 100) return 'moderate';
  if (numeric <= 300) return 'unhealthy';
  return 'hazardous';
}

function isFreshMeasurement(measuredAt, nowMs = Date.now()) {
  return Number.isFinite(measuredAt) && measuredAt >= (nowMs - AIR_QUALITY_WINDOW_MS) && measuredAt <= (nowMs + 5 * 60 * 1000);
}

function pickLocationName(location) {
  return trimString(location?.locality)
    || trimString(location?.city)
    || trimString(location?.name)
    || normalizeCountryCode(location?.country?.code)
    || 'Unknown';
}

function pickCoordinates(primary, fallback) {
  const lat = toFiniteNumber(primary?.latitude ?? primary?.lat) ?? toFiniteNumber(fallback?.latitude ?? fallback?.lat);
  const lng = toFiniteNumber(primary?.longitude ?? primary?.lng) ?? toFiniteNumber(fallback?.longitude ?? fallback?.lng);
  if (lat == null || lng == null) return null;
  return { lat: roundTo(lat, 4), lng: roundTo(lng, 4) };
}

export function buildOpenAqLocationIndex(locations = []) {
  const index = new Map();
  for (const location of locations) {
    const id = toFiniteNumber(location?.id);
    if (id == null) continue;
    index.set(id, {
      city: pickLocationName(location),
      countryCode: normalizeCountryCode(location?.country?.code),
      coordinates: pickCoordinates(location?.coordinates),
    });
  }
  return index;
}

function buildLocationMetadata(result, locationIndex) {
  const locationId = toFiniteNumber(
    result?.locationsId
      ?? result?.locationId
      ?? result?.location?.id,
  );
  const indexed = locationId != null ? locationIndex.get(locationId) : null;
  const inlineLocation = result?.location ?? null;
  const city = indexed?.city || pickLocationName(inlineLocation);
  const countryCode = indexed?.countryCode || normalizeCountryCode(inlineLocation?.country?.code);
  const coordinates = pickCoordinates(result?.coordinates, indexed?.coordinates ?? inlineLocation?.coordinates);
  if (!city || !coordinates) return null;
  return { locationId: locationId ?? null, city, countryCode, coordinates };
}

export function buildOpenAqStations(locations = [], latestMeasurements = [], nowMs = Date.now()) {
  const locationIndex = buildOpenAqLocationIndex(locations);
  const latestByLocation = new Map();

  for (const result of latestMeasurements) {
    const pm25 = toFiniteNumber(result?.value);
    if (pm25 == null || pm25 < 0) continue;

    const measuredAt = toEpochMs(result?.datetime?.utc ?? result?.datetime?.local ?? result?.date?.utc ?? result?.date?.local);
    if (!isFreshMeasurement(measuredAt, nowMs)) continue;

    const metadata = buildLocationMetadata(result, locationIndex);
    if (!metadata) continue;

    const pollutant = trimString(result?.parameter?.name) || trimString(result?.parameter) || 'pm25';
    const normalizedPm25 = roundTo(pm25, 1);
    const aqi = computeUsAqiFromPm25(normalizedPm25);
    const station = {
      city: metadata.city,
      countryCode: metadata.countryCode,
      lat: metadata.coordinates.lat,
      lng: metadata.coordinates.lng,
      pm25: normalizedPm25,
      aqi,
      riskLevel: classifyRiskLevel(aqi),
      pollutant,
      measuredAt,
      source: 'OpenAQ',
    };
    const dedupeKey = metadata.locationId ?? `${station.city}:${station.lat}:${station.lng}`;
    const previous = latestByLocation.get(dedupeKey);
    if (!previous || station.measuredAt > previous.measuredAt || (station.measuredAt === previous.measuredAt && station.pm25 > previous.pm25)) {
      latestByLocation.set(dedupeKey, station);
    }
  }

  return [...latestByLocation.values()].sort((left, right) => right.aqi - left.aqi || right.measuredAt - left.measuredAt);
}

function extractCountryCodeFromName(name) {
  const match = trimString(name).match(/\b([A-Z]{2})\b$/);
  return match ? normalizeCountryCode(match[1]) : '';
}

export function buildWaqiStations(entries = [], nowMs = Date.now()) {
  const stations = [];
  for (const entry of entries) {
    const pm25 = toFiniteNumber(entry?.iaqi?.pm25?.v ?? entry?.pm25);
    const lat = toFiniteNumber(entry?.lat);
    const lng = toFiniteNumber(entry?.lon);
    const aqi = toFiniteNumber(entry?.aqi);
    const stationName = trimString(entry?.station?.name);
    const measuredAt = toEpochMs(entry?.station?.time);
    if (pm25 == null || lat == null || lng == null || aqi == null || !stationName || !isFreshMeasurement(measuredAt, nowMs)) continue;

    stations.push({
      city: stationName.split(',')[0]?.trim() || stationName,
      countryCode: extractCountryCodeFromName(stationName),
      lat: roundTo(lat, 4),
      lng: roundTo(lng, 4),
      pm25: roundTo(pm25, 1),
      aqi: Math.max(0, Math.min(500, Math.round(aqi))),
      riskLevel: classifyRiskLevel(aqi),
      pollutant: trimString(entry?.dominentpol) || 'pm25',
      measuredAt,
      source: 'WAQI',
    });
  }
  return stations;
}

function isNormalizedAirQualityStation(station) {
  return Boolean(
    trimString(station?.city)
    && toFiniteNumber(station?.lat) != null
    && toFiniteNumber(station?.lng) != null
    && toFiniteNumber(station?.aqi) != null
    && toEpochMs(station?.measuredAt) != null,
  );
}

function normalizeSupplementalStations({ waqiStations = [], waqiEntries = [], nowMs = Date.now() }) {
  const normalizedStations = Array.isArray(waqiStations)
    ? waqiStations.filter(isNormalizedAirQualityStation)
    : [];

  if (!Array.isArray(waqiEntries) || waqiEntries.length === 0) {
    return normalizedStations;
  }

  // `buildAirQualityPayload()` now accepts pre-normalized `waqiStations`.
  // Keep `waqiEntries` as a backward-compatible alias for raw WAQI API payloads.
  const legacyStations = waqiEntries.some(isNormalizedAirQualityStation)
    ? waqiEntries.filter(isNormalizedAirQualityStation)
    : buildWaqiStations(waqiEntries, nowMs);

  return [...normalizedStations, ...legacyStations];
}

function stationIdentity(station) {
  return [
    trimString(station.city).toLowerCase(),
    normalizeCountryCode(station.countryCode).toLowerCase(),
    roundTo(station.lat, 2),
    roundTo(station.lng, 2),
  ].join('|');
}

export function mergeAirQualityStations(primaryStations = [], secondaryStations = []) {
  const merged = new Map();
  for (const station of primaryStations) {
    if (!isNormalizedAirQualityStation(station)) continue;
    merged.set(stationIdentity(station), station);
  }
  for (const station of secondaryStations) {
    if (!isNormalizedAirQualityStation(station)) continue;
    const key = stationIdentity(station);
    if (!merged.has(key)) merged.set(key, station);
  }
  return [...merged.values()].sort((left, right) => right.aqi - left.aqi || right.measuredAt - left.measuredAt);
}

function toOutputStation(station) {
  return {
    city: station.city,
    country_code: station.countryCode,
    lat: station.lat,
    lng: station.lng,
    pm25: station.pm25,
    aqi: station.aqi,
    risk_level: station.riskLevel,
    pollutant: station.pollutant,
    measured_at: station.measuredAt,
    source: station.source,
  };
}

export function buildOpenAqHeaders(apiKey = process.env.OPENAQ_API_KEY) {
  const trimmedKey = trimString(apiKey);
  if (!trimmedKey) {
    throw new SeedConfigurationError('Missing OPENAQ_API_KEY — OpenAQ v3 requests now require X-API-Key');
  }
  return {
    Accept: 'application/json',
    'User-Agent': CHROME_UA,
    'X-API-Key': trimmedKey,
  };
}

function isConfigurationError(error) {
  return error instanceof SeedConfigurationError || error?.code === 'SEED_CONFIGURATION_ERROR';
}

async function fetchJson(url, label, headers = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': CHROME_UA,
      ...headers,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${label}: HTTP ${response.status} ${body.slice(0, 200)}`.trim());
  }
  return response.json();
}

function buildUrl(baseUrl, params) {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function fetchOpenAqLocationsPage(page) {
  const headers = buildOpenAqHeaders();
  const url = buildUrl(OPENAQ_LOCATIONS_URL, {
    limit: OPENAQ_PAGE_LIMIT,
    page,
    parameters_id: 2,
    sort_order: 'desc',
  });
  return await withRetry(() => fetchJson(url, `OpenAQ locations page ${page}`, headers), 2, 1_000);
}

async function fetchOpenAqLatestPage(page) {
  const headers = buildOpenAqHeaders();
  const url = buildUrl(OPENAQ_PM25_LATEST_URL, {
    limit: OPENAQ_PAGE_LIMIT,
    page,
  });
  return withRetry(() => fetchJson(url, `OpenAQ latest page ${page}`, headers), 2, 1_000);
}

async function fetchPagedResults(fetchPage, label) {
  const results = [];
  let expectedFound = 0;

  for (let page = 1; page <= OPENAQ_MAX_PAGES; page++) {
    const payload = await fetchPage(page);
    const pageResults = Array.isArray(payload?.results) ? payload.results : [];
    results.push(...pageResults);

    const found = toFiniteNumber(payload?.meta?.found);
    const effectiveLimit = toFiniteNumber(payload?.meta?.limit) ?? OPENAQ_PAGE_LIMIT;
    if (found != null && found > 0) expectedFound = found;

    if (pageResults.length < effectiveLimit) break;
    if (expectedFound > 0 && results.length >= expectedFound) break;
  }

  if (results.length === 0) {
    throw new Error(`${label}: no results returned`);
  }

  return results;
}

async function fetchWaqiStations(nowMs) {
  const apiKey = trimString(process.env.WAQI_API_KEY);
  if (!apiKey) {
    console.log('  [AIR] WAQI_API_KEY missing; skipping WAQI supplement');
    return [];
  }

  const entries = [];
  for (const bbox of WAQI_WORLD_TILES) {
    const url = buildUrl('https://api.waqi.info/map/bounds/', { latlng: bbox, token: apiKey });
    try {
      const payload = await withRetry(() => fetchJson(url, `WAQI ${bbox}`), 1, 1_000);
      if (payload?.status === 'ok' && Array.isArray(payload.data)) {
        entries.push(...payload.data);
      }
    } catch (error) {
      console.warn(`  [AIR] WAQI tile ${bbox} failed: ${error?.message ?? error}`);
    }
  }

  return buildWaqiStations(entries, nowMs);
}

export function buildAirQualityPayload({
  locations = [],
  latestMeasurements = [],
  waqiStations = [],
  waqiEntries = [],
  nowMs = Date.now(),
} = {}) {
  const openAqStations = buildOpenAqStations(locations, latestMeasurements, nowMs);
  const supplementalStations = normalizeSupplementalStations({ waqiStations, waqiEntries, nowMs });
  const mergedStations = mergeAirQualityStations(openAqStations, supplementalStations);
  return {
    stations: mergedStations.map(toOutputStation),
    fetchedAt: nowMs,
  };
}

export async function fetchAirQualityPayload(nowMs = Date.now()) {
  const [locations, latestMeasurements, waqiStations] = await Promise.all([
    fetchPagedResults(fetchOpenAqLocationsPage, 'OpenAQ locations'),
    fetchPagedResults(fetchOpenAqLatestPage, 'OpenAQ latest'),
    fetchWaqiStations(nowMs).catch((error) => {
      console.warn(`  [AIR] WAQI supplement failed: ${error?.message ?? error}`);
      return [];
    }),
  ]);

  const payload = buildAirQualityPayload({
    locations,
    latestMeasurements,
    waqiStations,
    nowMs,
  });

  if (!payload.stations.length) {
    throw new Error('No fresh PM2.5 stations found in the last 2 hours');
  }

  return payload;
}

export function validateAirQualityPayload(payload) {
  return Array.isArray(payload?.stations) && payload.stations.length > 0;
}

export function buildMirrorWriteCommands(payload, ttlSeconds, fetchedAt = Date.now(), sourceVersion = OPENAQ_SOURCE_VERSION) {
  const payloadJson = JSON.stringify(payload);
  const recordCount = payload?.stations?.length ?? 0;
  const metaTtl = 86400 * 7;
  const healthMeta = JSON.stringify({ fetchedAt, recordCount, sourceVersion });
  const climateMeta = JSON.stringify({ fetchedAt, recordCount, sourceVersion });
  return [
    ['SET', HEALTH_AIR_QUALITY_KEY, payloadJson, 'EX', String(ttlSeconds)],
    ['SET', CLIMATE_AIR_QUALITY_KEY, payloadJson, 'EX', String(ttlSeconds)],
    ['SET', OPENAQ_META_KEY, healthMeta, 'EX', String(metaTtl)],
    ['SET', CLIMATE_META_KEY, climateMeta, 'EX', String(metaTtl)],
  ];
}

async function redisPipeline(commands) {
  const { url, token } = getRedisCredentials();
  const response = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Redis pipeline failed: HTTP ${response.status} — ${body.slice(0, 200)}`);
  }
  return response.json();
}

async function publishMirroredPayload(payload) {
  const fetchedAt = Date.now();
  const commands = buildMirrorWriteCommands(payload, CACHE_TTL, fetchedAt, OPENAQ_SOURCE_VERSION);
  await redisPipeline(commands);
  return {
    fetchedAt,
    payloadBytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
    recordCount: payload?.stations?.length ?? 0,
  };
}

async function verifyMirroredKeys() {
  const [healthPayload, climatePayload] = await Promise.all([
    verifySeedKey(HEALTH_AIR_QUALITY_KEY),
    verifySeedKey(CLIMATE_AIR_QUALITY_KEY),
  ]);
  return Boolean(healthPayload && climatePayload);
}

async function fetchAirQualityPayloadWithRetry(maxRetries = 2, delayMs = 1_000) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetchAirQualityPayload();
    } catch (error) {
      lastError = error;
      if (isConfigurationError(error) || attempt >= maxRetries) break;
      const wait = delayMs * 2 ** attempt;
      const cause = error?.cause ? ` (cause: ${error.cause.message || error.cause.code || error.cause})` : '';
      console.warn(`  Retry ${attempt + 1}/${maxRetries} in ${wait}ms: ${error?.message ?? error}${cause}`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw lastError;
}

async function main() {
  const domain = 'health';
  const resource = 'air-quality';
  const startMs = Date.now();
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  console.log(`=== ${domain}:${resource} Seed ===`);
  console.log(`  Run ID:  ${runId}`);
  console.log(`  Keys:    ${HEALTH_AIR_QUALITY_KEY}, ${CLIMATE_AIR_QUALITY_KEY}`);

  // Each OpenAQ branch can walk up to 20 pages sequentially with per-request timeouts.
  // Keep the lock well above the realistic worst-case runtime to avoid overlapping cron runs.
  const lockResult = await acquireLockSafely(`${domain}:${resource}`, runId, AIR_QUALITY_LOCK_TTL_MS, {
    label: `${domain}:${resource}`,
  });
  if (lockResult.skipped) process.exit(0);
  if (!lockResult.locked) {
    console.log('  SKIPPED: another seed run in progress');
    process.exit(0);
  }

  let payload;
  try {
    payload = await fetchAirQualityPayloadWithRetry();
  } catch (error) {
    await releaseLock(`${domain}:${resource}`, runId);
    const durationMs = Date.now() - startMs;
    const cause = error?.cause ? ` (cause: ${error.cause.message || error.cause.code || error.cause})` : '';
    console.error(`  FETCH FAILED: ${error?.message ?? error}${cause}`);
    await extendExistingTtl([
      HEALTH_AIR_QUALITY_KEY,
      CLIMATE_AIR_QUALITY_KEY,
      OPENAQ_META_KEY,
      CLIMATE_META_KEY,
    ], CACHE_TTL).catch(() => {});
    if (isConfigurationError(error)) {
      console.log(`\n=== Fatal configuration error (${Math.round(durationMs)}ms) ===`);
      process.exit(1);
    }
    console.log(`\n=== Failed gracefully (${Math.round(durationMs)}ms) ===`);
    process.exit(0);
  }

  if (!validateAirQualityPayload(payload)) {
    await releaseLock(`${domain}:${resource}`, runId);
    await extendExistingTtl([
      HEALTH_AIR_QUALITY_KEY,
      CLIMATE_AIR_QUALITY_KEY,
      OPENAQ_META_KEY,
      CLIMATE_META_KEY,
    ], CACHE_TTL).catch(() => {});
    console.log('  SKIPPED: validation failed (empty data)');
    process.exit(0);
  }

  try {
    const publishResult = await publishMirroredPayload(payload);
    const durationMs = Date.now() - startMs;
    logSeedResult(domain, publishResult.recordCount, durationMs, {
      payloadBytes: publishResult.payloadBytes,
      mirroredKeys: 2,
    });

    const verified = await verifyMirroredKeys().catch(() => false);
    if (verified) {
      console.log('  Verified: both Redis keys present');
    } else {
      console.warn(`  WARNING: verification read returned null for one or more mirror keys (${HEALTH_AIR_QUALITY_KEY}, ${CLIMATE_AIR_QUALITY_KEY})`);
    }

    console.log(`\n=== Done (${Math.round(durationMs)}ms) ===`);
    await releaseLock(`${domain}:${resource}`, runId);
    process.exit(0);
  } catch (error) {
    await releaseLock(`${domain}:${resource}`, runId);
    throw error;
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ''));
if (isMain) {
  main().catch((error) => {
    const cause = error?.cause ? ` (cause: ${error.cause.message || error.cause.code || error.cause})` : '';
    console.error('FATAL:', `${error?.message ?? error}${cause}`);
    process.exit(1);
  });
}
