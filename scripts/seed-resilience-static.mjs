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
import {
  COUNTRY_ALIAS_MAP,
  createCountryResolvers,
  isIso2,
  isIso3,
  normalizeCountryToken,
  resolveIso2,
} from './_country-resolver.mjs';

export { createCountryResolvers, resolveIso2 } from './_country-resolver.mjs';

loadEnvFile(import.meta.url);

export const RESILIENCE_STATIC_INDEX_KEY = 'resilience:static:index:v1';
export const RESILIENCE_STATIC_META_KEY = 'seed-meta:resilience:static';
export const RESILIENCE_STATIC_PREFIX = 'resilience:static:';
export const RESILIENCE_STATIC_TTL_SECONDS = 400 * 24 * 60 * 60;
export const RESILIENCE_STATIC_SOURCE_VERSION = 'resilience-static-v1';
export const RESILIENCE_STATIC_WINDOW_CRON = '0 */4 1-3 10 *';

const LOCK_DOMAIN = 'resilience:static';
const LOCK_TTL_MS = 2 * 60 * 60 * 1000;
const TOTAL_DATASET_SLOTS = 8;
const COUNTRY_DATASET_FIELDS = ['wgi', 'infrastructure', 'gpi', 'rsf', 'who', 'fao', 'aquastat', 'iea'];
const WGI_INDICATORS = ['VA.EST', 'PV.EST', 'GE.EST', 'RQ.EST', 'RL.EST', 'CC.EST'];
const INFRASTRUCTURE_INDICATORS = ['EG.ELC.ACCS.ZS', 'IS.ROD.PAVE.ZS'];
const WHO_INDICATORS = {
  hospitalBeds: 'WHS6_102',
  uhcIndex: 'UHC_INDEX_REPORTED',
  // WHS4_100 from the issue body no longer resolves; WHO currently exposes MCV1 coverage on WHS8_110.
  measlesCoverage: process.env.RESILIENCE_WHO_MEASLES_INDICATOR || 'WHS8_110',
};
const WORLD_BANK_BASE = 'https://api.worldbank.org/v2';
const WHO_BASE = 'https://ghoapi.azureedge.net/api';
const RSF_RANKING_URL = 'https://rsf.org/en/ranking';
const EUROSTAT_ENERGY_URL = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/nrg_ind_id?freq=A';
const WB_ENERGY_IMPORT_INDICATOR = 'EG.IMP.CONS.ZS';
const COUNTRY_RESOLVERS = createCountryResolvers();

export function countryRedisKey(iso2) {
  return `${RESILIENCE_STATIC_PREFIX}${iso2}`;
}

function nowSeedYear(now = new Date()) {
  return now.getUTCFullYear();
}

export function shouldSkipSeedYear(meta, seedYear = nowSeedYear()) {
  return Boolean(
    meta
    && meta.status === 'ok'
    && Number(meta.seedYear) === seedYear
    && Number.isFinite(Number(meta.recordCount))
    && Number(meta.recordCount) > 0,
  );
}

function safeNum(value) {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function coalesceYear(...values) {
  const numeric = values.map(v => safeNum(v)).filter(v => v != null);
  return numeric.length ? Math.max(...numeric) : null;
}

function roundMetric(value, digits = 3) {
  const numeric = safeNum(value);
  if (numeric == null) return null;
  const factor = 10 ** digits;
  return Math.round(numeric * factor) / factor;
}

async function fetchText(url, { accept = 'text/plain, text/html, application/json', timeoutMs = 30_000 } = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: accept,
      'User-Agent': CHROME_UA,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return {
    text: await response.text(),
    contentType: response.headers.get('content-type') || '',
  };
}

async function fetchJson(url, { timeoutMs = 30_000, accept = 'application/json' } = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: accept,
      'User-Agent': CHROME_UA,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function parseWorldBankPayload(raw, indicatorId) {
  if (!Array.isArray(raw) || raw.length < 2 || !Array.isArray(raw[1])) {
    throw new Error(`Unexpected World Bank response shape for ${indicatorId}`);
  }
  return {
    meta: raw[0] || {},
    rows: raw[1] || [],
  };
}

async function fetchWorldBankIndicatorRows(indicatorId, extraParams = {}) {
  const rows = [];
  let page = 1;
  let totalPages = 1;

  const MAX_WB_PAGES = 100;
  while (page <= totalPages && page <= MAX_WB_PAGES) {
    const params = new URLSearchParams({
      format: 'json',
      per_page: '1000',
      page: String(page),
      ...extraParams,
    });
    const url = `${WORLD_BANK_BASE}/country/all/indicator/${encodeURIComponent(indicatorId)}?${params}`;
    const raw = await withRetry(() => fetchJson(url), 2, 750);
    const parsed = parseWorldBankPayload(raw, indicatorId);
    totalPages = Number(parsed.meta.pages || 1);
    rows.push(...parsed.rows);
    page += 1;
  }

  return rows;
}

function selectLatestWorldBankByCountry(rows) {
  const latest = new Map();
  for (const row of rows) {
    const value = safeNum(row?.value);
    if (value == null) continue;
    const year = safeNum(row?.date);
    const iso2 = resolveIso2({
      iso3: row?.countryiso3code,
      name: row?.country?.value,
    });
    if (!iso2 || year == null) continue;
    const previous = latest.get(iso2);
    if (!previous || year > previous.year) {
      latest.set(iso2, {
        value: roundMetric(value),
        year,
        name: row?.country?.value || iso2,
      });
    }
  }
  return latest;
}

function upsertDatasetRecord(target, iso2, datasetField, value) {
  if (!value) return;
  const current = target.get(iso2) || {};
  current[datasetField] = value;
  target.set(iso2, current);
}

export async function fetchWgiDataset() {
  const merged = new Map();
  const results = await Promise.allSettled(
    WGI_INDICATORS.map((indicatorId) =>
      fetchWorldBankIndicatorRows(indicatorId, { mrv: '12' })
        .then(selectLatestWorldBankByCountry)
        .then((countryMap) => ({ indicatorId, countryMap })),
    ),
  );

  let successfulIndicators = 0;
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    successfulIndicators += 1;
    for (const [iso2, entry] of result.value.countryMap.entries()) {
      const current = merged.get(iso2) || {
        source: 'worldbank-wgi',
        indicators: {},
      };
      current.indicators[result.value.indicatorId] = {
        value: entry.value,
        year: entry.year,
      };
      merged.set(iso2, current);
    }
  }

  if (successfulIndicators === 0) {
    throw new Error('World Bank WGI: all indicator fetches failed');
  }

  return merged;
}

export async function fetchInfrastructureDataset() {
  const merged = new Map();
  const results = await Promise.allSettled(
    INFRASTRUCTURE_INDICATORS.map((indicatorId) =>
      fetchWorldBankIndicatorRows(indicatorId, { mrv: '12' })
        .then(selectLatestWorldBankByCountry)
        .then((countryMap) => ({ indicatorId, countryMap })),
    ),
  );

  let successfulIndicators = 0;
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    successfulIndicators += 1;
    for (const [iso2, entry] of result.value.countryMap.entries()) {
      const current = merged.get(iso2) || {
        source: 'worldbank-infrastructure',
        indicators: {},
      };
      current.indicators[result.value.indicatorId] = {
        value: entry.value,
        year: entry.year,
      };
      merged.set(iso2, current);
    }
  }

  if (successfulIndicators === 0) {
    throw new Error('World Bank infrastructure: all indicator fetches failed');
  }

  return merged;
}

async function fetchWhoIndicatorRows(indicatorCode) {
  const rows = [];
  const params = new URLSearchParams({
    '$select': 'SpatialDim,TimeDim,NumericValue,Value',
    '$filter': "SpatialDimType eq 'COUNTRY'",
    '$top': '1000',
  });
  let nextUrl = `${WHO_BASE}/${encodeURIComponent(indicatorCode)}?${params}`;
  let pageCount = 0;
  const MAX_WHO_PAGES = 50;

  while (nextUrl && pageCount < MAX_WHO_PAGES) {
    pageCount += 1;
    const payload = await withRetry(() => fetchJson(nextUrl), 2, 750);
    if (!Array.isArray(payload?.value)) throw new Error(`Unexpected WHO response shape for ${indicatorCode}`);
    rows.push(...payload.value);
    nextUrl = payload['@odata.nextLink'] || payload['odata.nextLink'] || null;
  }
  if (nextUrl) throw new Error(`WHO ${indicatorCode}: pagination exceeded ${MAX_WHO_PAGES} pages`);

  return rows;
}

function selectLatestWhoByCountry(rows) {
  const latest = new Map();
  for (const row of rows) {
    const value = safeNum(row?.NumericValue ?? row?.Value);
    const year = safeNum(row?.TimeDim);
    const iso2 = resolveIso2({ iso3: row?.SpatialDim });
    if (!iso2 || value == null || year == null) continue;
    const previous = latest.get(iso2);
    if (!previous || year > previous.year) {
      latest.set(iso2, {
        value: roundMetric(value),
        year,
      });
    }
  }
  return latest;
}

export async function fetchWhoDataset() {
  const merged = new Map();
  const results = await Promise.allSettled(
    Object.entries(WHO_INDICATORS).map(([metricKey, indicatorCode]) =>
      fetchWhoIndicatorRows(indicatorCode)
        .then(selectLatestWhoByCountry)
        .then((countryMap) => ({ metricKey, indicatorCode, countryMap })),
    ),
  );

  let successfulIndicators = 0;
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    successfulIndicators += 1;
    for (const [iso2, entry] of result.value.countryMap.entries()) {
      const current = merged.get(iso2) || {
        source: 'who-gho',
        indicators: {},
      };
      current.indicators[result.value.metricKey] = {
        indicator: result.value.indicatorCode,
        value: entry.value,
        year: entry.year,
      };
      merged.set(iso2, current);
    }
  }

  if (successfulIndicators === 0) {
    throw new Error('WHO: all indicator fetches failed');
  }

  return merged;
}

function parseDecimal(value) {
  return safeNum(String(value || '').replace(',', '.'));
}

export function parseRsfRanking(html) {
  const byCountry = new Map();
  const rowRegex = /^\s*\|(\d+)\|([^|]+)\|([0-9]+(?:[.,][0-9]+)?)\|([^|]+)\|\s*(?:<[^>]+>)?\s*$/gm;
  for (const match of html.matchAll(rowRegex)) {
    const rank = safeNum(match[1]);
    const countryName = String(match[2] || '').trim();
    const score = parseDecimal(match[3]);
    const differential = String(match[4] || '').trim();
    const iso2 = resolveIso2({ name: countryName });
    if (!iso2 || rank == null || score == null) continue;
    byCountry.set(iso2, {
      source: 'rsf-ranking',
      rank,
      score: roundMetric(score, 2),
      differential,
      year: null,
    });
  }
  return byCountry;
}

export async function fetchRsfDataset() {
  const { text } = await withRetry(() => fetchText(RSF_RANKING_URL), 2, 750);
  const parsed = parseRsfRanking(text);
  if (parsed.size < 100) throw new Error(`RSF ranking page returned only ${parsed.size} countries (expected 180+)`);
  return parsed;
}

function reverseCategoryIndex(index = {}) {
  return Object.entries(index).reduce((acc, [label, position]) => {
    acc[position] = label;
    return acc;
  }, {});
}

function parseLatestEurostatValue(data, geoCode) {
  const dims = data?.dimension;
  const values = data?.value;
  if (!dims || !values) return null;

  const geoDim = dims.geo;
  const geoIndex = geoDim?.category?.index;
  if (!geoIndex || geoIndex[geoCode] === undefined) return null;

  const geoPos = geoIndex[geoCode];
  const timeIndexObj = dims.time?.category?.index;
  let latestYear = null;

  const dimOrder = data.id || [];
  const dimSizes = data.size || [];
  const strides = {};
  let stride = 1;
  for (let idx = dimOrder.length - 1; idx >= 0; idx -= 1) {
    strides[dimOrder[idx]] = stride;
    stride *= dimSizes[idx];
  }

  let latestValue = null;
  for (const key of Object.keys(values).sort((left, right) => Number(right) - Number(left))) {
    const rawValue = values[key];
    if (rawValue == null) continue;

    let remaining = Number(key);
    const coords = {};
    for (const dim of dimOrder) {
      const strideSize = strides[dim];
      const dimSize = dimSizes[dimOrder.indexOf(dim)];
      coords[dim] = Math.floor(remaining / strideSize) % dimSize;
      remaining %= strideSize;
    }

    if (coords.geo !== geoPos) continue;
    if (reverseCategoryIndex(dims.siec?.category?.index)[coords.siec] !== 'TOTAL') continue;

    latestValue = safeNum(rawValue);
    const matchedTime = Object.entries(timeIndexObj || {}).find(([, position]) => position === coords.time);
    latestYear = safeNum(matchedTime?.[0]);
    break;
  }

  if (latestValue == null || latestYear == null) return null;
  return {
    value: roundMetric(latestValue),
    year: latestYear,
  };
}

export function parseEurostatEnergyDataset(data) {
  const ids = Array.isArray(data?.id) ? data.id : [];
  const dimensions = data?.dimension || {};
  if (!data?.value || !ids.length) {
    throw new Error('Eurostat dataset missing dimension metadata');
  }

  const parsed = new Map();
  const geoCodes = Object.keys(dimensions.geo?.category?.index || {});

  for (const iso2 of geoCodes) {
    if (!isIso2(iso2)) continue;
    const latest = parseLatestEurostatValue(data, iso2);
    if (!latest) continue;
    parsed.set(iso2, {
      source: 'eurostat-nrg_ind_id',
      energyImportDependency: {
        value: latest.value,
        year: latest.year,
        source: 'eurostat',
      },
    });
  }

  return parsed;
}

export async function fetchEnergyDependencyDataset() {
  const [eurostatData, worldBankRows] = await Promise.all([
    withRetry(() => fetchJson(EUROSTAT_ENERGY_URL), 2, 750).catch(() => null),
    fetchWorldBankIndicatorRows(WB_ENERGY_IMPORT_INDICATOR, { mrv: '12' }).catch(() => []),
  ]);

  let merged = new Map();
  if (eurostatData) {
    try {
      merged = parseEurostatEnergyDataset(eurostatData);
    } catch {
      merged = new Map();
    }
  }
  const worldBankFallback = selectLatestWorldBankByCountry(worldBankRows);

  for (const [iso2, entry] of worldBankFallback.entries()) {
    if (merged.has(iso2)) continue;
    merged.set(iso2, {
      source: 'worldbank-energy-imports',
      energyImportDependency: {
        value: entry.value,
        year: entry.year,
        source: 'worldbank',
      },
    });
  }

  if (merged.size === 0) throw new Error('Energy dependency: both Eurostat and World Bank fallback failed');
  return merged;
}

function parseDelimitedRow(line, delimiter) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let idx = 0; idx < line.length; idx += 1) {
    const char = line[idx];
    const next = line[idx + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        idx += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function parseDelimitedText(text, delimiter) {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const headers = parseDelimitedRow(lines[0], delimiter);
  return lines.slice(1).map((line) => {
    const values = parseDelimitedRow(line, delimiter);
    return Object.fromEntries(headers.map((header, idx) => [header, values[idx] ?? '']));
  });
}

async function fetchGpiDataset() {
  const currentYear = new Date().getUTCFullYear();
  let csvText;
  let resolvedYear = currentYear;

  const urlForYear = (yr) =>
    `https://www.visionofhumanity.org/wp-content/uploads/${yr}/06/GPI_${yr}_${yr}.csv`;

  try {
    ({ text: csvText } = await withRetry(() => fetchText(urlForYear(currentYear), { accept: 'text/csv' }), 1, 750));
  } catch {
    resolvedYear = currentYear - 1;
    ({ text: csvText } = await withRetry(() => fetchText(urlForYear(resolvedYear), { accept: 'text/csv' }), 2, 750));
  }

  const rows = parseDelimitedText(csvText, ',');
  const parsed = new Map();
  for (const row of rows) {
    const iso3 = String(row.code || '').trim().toUpperCase();
    const iso2 = resolveIso2({ iso3 });
    if (!iso2) continue;
    const rank = safeNum(row.rank);
    const score = safeNum(row.index_over);
    const year = safeNum(row.year) ?? resolvedYear;
    if (rank == null || score == null) continue;
    parsed.set(iso2, {
      source: 'gpi-voh',
      rank,
      score: roundMetric(score, 3),
      year,
    });
  }
  if (parsed.size < 50) throw new Error(`GPI CSV returned only ${parsed.size} countries (expected 163+)`);
  return parsed;
}

async function fetchFsinDataset() {
  const hdxUrl =
    'https://data.humdata.org/dataset/7a7e7428-b8d7-4d2e-91d3-19100500e016/resource/2e4f7475-105b-4fae-81f7-7c32076096b6/download/ipc_global_national_wide_latest.csv';
  const { text: csvText } = await withRetry(() => fetchText(hdxUrl, { accept: 'text/csv' }), 2, 750);
  const rows = parseDelimitedText(csvText, ',');
  const parsed = new Map();
  for (const row of rows) {
    const iso3 = String(row['Country (ISO3)'] || '').trim().toUpperCase();
    const iso2 = resolveIso2({ iso3 });
    if (!iso2) continue;
    const phase3plus = safeNum(row['Phase 3+ #']);
    const phase4 = safeNum(row['Phase 4 #']);
    const phase5 = safeNum(row['Phase 5 #']);
    if (phase3plus == null && phase4 == null && phase5 == null) continue;
    const yearCandidates = Object.keys(row)
      .filter((k) => /period|date|year/i.test(k))
      .map((k) => safeNum(String(row[k]).slice(0, 4)))
      .filter((v) => v != null && v > 2000);
    const year = yearCandidates.length ? Math.max(...yearCandidates) : null;
    parsed.set(iso2, {
      source: 'hdx-ipc',
      year,
      phase3plus: phase3plus != null ? roundMetric(phase3plus, 0) : null,
      phase4: phase4 != null ? roundMetric(phase4, 0) : null,
      phase5: phase5 != null ? roundMetric(phase5, 0) : null,
    });
  }
  if (parsed.size === 0) throw new Error('HDX IPC CSV returned no usable rows');
  return parsed;
}

async function fetchAquastatDataset() {
  const aquastatUrl =
    'https://api.data.apps.fao.org/api/v2/bigquery?sql_url=https://data.apps.fao.org/catalog/dataset/945666e6-7803-4621-b8ef-cfd885a84596/resource/4a000a1b-24f0-4328-aab6-b9b525892090/download/query_en.sql&area=World&variable=4550,4192,4190&year=2021&type=country';
  const { text: csvText } = await withRetry(() => fetchText(aquastatUrl, { accept: 'text/csv' }), 2, 750);
  const rows = parseDelimitedText(csvText, ',');

  const VARIABLE_MAP = {
    '4550': 'waterStress',
    '4192': 'dependencyRatio',
    '4190': 'renewablePerCapita',
  };

  const byCountry = new Map();
  for (const row of rows) {
    const countryName = String(row.Country || '').trim();
    const iso2 = resolveIso2({ name: countryName });
    if (!iso2) continue;
    const varCode = String(row.VariableCode || row.Variable_Id || '').trim();
    const metricKey = VARIABLE_MAP[varCode];
    if (!metricKey) continue;
    const value = safeNum(row.Value);
    const year = safeNum(row.Year);
    if (value == null) continue;

    const existing = byCountry.get(iso2) || { source: 'fao-aquastat' };
    const prev = existing[metricKey];
    if (!prev || (year != null && (prev.year == null || year > prev.year))) {
      existing[metricKey] = { value: roundMetric(value), year };
    }
    byCountry.set(iso2, existing);
  }
  if (byCountry.size === 0) throw new Error('AQUASTAT CSV returned no usable rows');
  return byCountry;
}

export function finalizeCountryPayloads(datasetMaps, seedYear = nowSeedYear(), seededAt = new Date().toISOString()) {
  const merged = new Map();

  for (const [datasetField, countryMap] of Object.entries(datasetMaps)) {
    for (const [iso2, payload] of countryMap.entries()) {
      upsertDatasetRecord(merged, iso2, datasetField, payload);
    }
  }

  for (const [iso2, payload] of merged.entries()) {
    const fullPayload = {};
    let availableDatasets = 0;
    for (const field of COUNTRY_DATASET_FIELDS) {
      const value = payload[field] ?? null;
      fullPayload[field] = value;
      if (value) availableDatasets += 1;
    }
    fullPayload.coverage = {
      availableDatasets,
      totalDatasets: TOTAL_DATASET_SLOTS,
      ratio: roundMetric(availableDatasets / TOTAL_DATASET_SLOTS, 3),
    };
    fullPayload.seedYear = seedYear;
    fullPayload.seededAt = seededAt;
    merged.set(iso2, fullPayload);
  }

  return merged;
}

export function buildManifest(countryPayloads, failedDatasets, seedYear, seededAt) {
  const countries = [...countryPayloads.keys()].sort();
  return {
    countries,
    recordCount: countries.length,
    failedDatasets: [...failedDatasets].sort(),
    seedYear,
    seededAt,
    sourceVersion: RESILIENCE_STATIC_SOURCE_VERSION,
  };
}

function buildMetaPayload({ status, recordCount, seedYear, failedDatasets, message = null }) {
  return {
    fetchedAt: Date.now(),
    recordCount,
    seedYear,
    failedDatasets: [...failedDatasets].sort(),
    status,
    sourceVersion: RESILIENCE_STATIC_SOURCE_VERSION,
    message,
  };
}

export function buildFailureRefreshKeys(manifest) {
  const keys = new Set([RESILIENCE_STATIC_INDEX_KEY, RESILIENCE_STATIC_META_KEY]);
  for (const iso2 of manifest?.countries || []) {
    if (isIso2(iso2)) keys.add(countryRedisKey(iso2));
  }
  return [...keys];
}

async function redisPipeline(commands) {
  const { url, token } = getRedisCredentials();
  const response = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Redis pipeline failed: HTTP ${response.status} — ${text.slice(0, 200)}`);
  }
  return response.json();
}

async function writeJsonKey(key, value, ttlSeconds) {
  return redisPipeline([['SET', key, JSON.stringify(value), 'EX', ttlSeconds]]);
}

async function readJsonKey(key) {
  return verifySeedKey(key);
}

async function publishSuccess(countryPayloads, manifest, meta) {
  const commands = [];
  for (const [iso2, payload] of countryPayloads.entries()) {
    commands.push(['SET', countryRedisKey(iso2), JSON.stringify(payload), 'EX', RESILIENCE_STATIC_TTL_SECONDS]);
  }
  commands.push(['SET', RESILIENCE_STATIC_INDEX_KEY, JSON.stringify(manifest), 'EX', RESILIENCE_STATIC_TTL_SECONDS]);
  commands.push(['SET', RESILIENCE_STATIC_META_KEY, JSON.stringify(meta), 'EX', RESILIENCE_STATIC_TTL_SECONDS]);
  const results = await redisPipeline(commands);
  const failures = results.filter(r => r?.error || r?.result === 'ERR');
  if (failures.length > 0) {
    throw new Error(`Redis pipeline: ${failures.length}/${commands.length} commands failed`);
  }
}

async function preservePreviousSnapshotOnFailure(failedDatasets, seedYear, message) {
  const previousManifest = await readJsonKey(RESILIENCE_STATIC_INDEX_KEY);
  const previousMeta = await readJsonKey(RESILIENCE_STATIC_META_KEY);
  const recordCount = safeNum(previousManifest?.recordCount ?? previousMeta?.recordCount) ?? 0;
  const refreshKeys = buildFailureRefreshKeys(previousManifest);
  await extendExistingTtl(refreshKeys, RESILIENCE_STATIC_TTL_SECONDS);

  const failureMeta = buildMetaPayload({
    status: 'error',
    recordCount,
    seedYear,
    failedDatasets,
    message,
  });
  await writeJsonKey(RESILIENCE_STATIC_META_KEY, failureMeta, RESILIENCE_STATIC_TTL_SECONDS);
  return { previousManifest, failureMeta };
}

async function fetchAllDatasetMaps() {
  const adapters = [
    { key: 'wgi', fetcher: fetchWgiDataset },
    { key: 'infrastructure', fetcher: fetchInfrastructureDataset },
    { key: 'gpi', fetcher: fetchGpiDataset },
    { key: 'rsf', fetcher: fetchRsfDataset },
    { key: 'who', fetcher: fetchWhoDataset },
    { key: 'fao', fetcher: fetchFsinDataset },
    { key: 'aquastat', fetcher: fetchAquastatDataset },
    { key: 'iea', fetcher: fetchEnergyDependencyDataset },
  ];

  const results = await Promise.allSettled(adapters.map((adapter) => adapter.fetcher()));
  const datasetMaps = {};
  const failedDatasets = [];

  for (let idx = 0; idx < adapters.length; idx += 1) {
    const adapter = adapters[idx];
    const result = results[idx];
    if (result.status === 'fulfilled') {
      datasetMaps[adapter.key] = result.value;
    } else {
      datasetMaps[adapter.key] = new Map();
      failedDatasets.push(adapter.key);
      console.warn(`  ${adapter.key}: ${result.reason?.message || result.reason || 'unknown error'}`);
    }
  }

  return { datasetMaps, failedDatasets };
}

export async function seedResilienceStatic() {
  const seedYear = nowSeedYear();
  const existingMeta = await readJsonKey(RESILIENCE_STATIC_META_KEY).catch(() => null);
  if (shouldSkipSeedYear(existingMeta, seedYear)) {
    console.log(`  resilience-static: seedYear ${seedYear} already written, skipping`);
    return {
      skipped: true,
      seedYear,
      reason: 'already_seeded',
    };
  }

  const { datasetMaps, failedDatasets } = await fetchAllDatasetMaps();
  const seededAt = new Date().toISOString();
  const countryPayloads = finalizeCountryPayloads(datasetMaps, seedYear, seededAt);
  const manifest = buildManifest(countryPayloads, failedDatasets, seedYear, seededAt);

  if (manifest.recordCount === 0) {
    const failure = await preservePreviousSnapshotOnFailure(
      failedDatasets,
      seedYear,
      'No datasets produced usable country rows',
    );
    const error = new Error('Resilience static seed produced no country rows');
    error.failure = failure;
    throw error;
  }

  const meta = buildMetaPayload({
    status: 'ok',
    recordCount: manifest.recordCount,
    seedYear,
    failedDatasets,
  });

  await publishSuccess(countryPayloads, manifest, meta);

  return {
    skipped: false,
    manifest,
    meta,
  };
}

export async function main() {
  const startedAt = Date.now();
  const runId = `resilience-static:${startedAt}`;
  const lock = await acquireLockSafely(LOCK_DOMAIN, runId, LOCK_TTL_MS, { label: LOCK_DOMAIN });
  if (lock.skipped) return;
  if (!lock.locked) {
    console.log('  resilience-static: another seed run is already active');
    return;
  }

  try {
    const result = await seedResilienceStatic();
    logSeedResult('resilience:static', result?.manifest?.recordCount ?? 0, Date.now() - startedAt, {
      skipped: Boolean(result?.skipped),
      seedYear: result?.seedYear ?? result?.manifest?.seedYear ?? nowSeedYear(),
      failedDatasets: result?.manifest?.failedDatasets ?? [],
    });
  } finally {
    await releaseLock(LOCK_DOMAIN, runId);
  }
}

if (process.argv[1]?.endsWith('seed-resilience-static.mjs')) {
  main().catch((error) => {
    const cause = error?.cause ? ` (cause: ${error.cause.message || error.cause})` : '';
    console.error(`FATAL: ${error.message || error}${cause}`);
    process.exit(1);
  });
}
