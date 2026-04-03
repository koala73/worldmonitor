#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireLockSafely,
  CHROME_UA,
  extendExistingTtl,
  getRedisCredentials,
  loadEnvFile,
  loadSharedConfig,
  logSeedResult,
  releaseLock,
  verifySeedKey,
  withRetry,
} from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));

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
const GPI_SOURCE_URL = process.env.RESILIENCE_GPI_URL || 'https://www.visionofhumanity.org/global-peace-index/';
const FSIN_SOURCE_URL = process.env.RESILIENCE_FSIN_URL || 'https://www.fsinplatform.org/our-data';
const AQUASTAT_SOURCE_URL = process.env.RESILIENCE_AQUASTAT_URL || 'https://aquastat.fao.org/';

const COUNTRY_NAMES = loadSharedConfig('country-names.json');
const COUNTRIES_GEOJSON = JSON.parse(
  readFileSync(join(__dirname, '..', 'public', 'data', 'countries.geojson'), 'utf8'),
);

const COUNTRY_ALIAS_MAP = {
  'bahamas the': 'BS',
  'cape verde': 'CV',
  'congo brazzaville': 'CG',
  'congo kinshasa': 'CD',
  'congo rep': 'CG',
  'congo dem rep': 'CD',
  'czech republic': 'CZ',
  'egypt arab rep': 'EG',
  'gambia the': 'GM',
  'hong kong sar china': 'HK',
  'iran islamic rep': 'IR',
  'korea dem peoples rep': 'KP',
  'korea rep': 'KR',
  'lao pdr': 'LA',
  'macao sar china': 'MO',
  'micronesia fed sts': 'FM',
  'morocco western sahara': 'MA',
  'north macedonia': 'MK',
  'occupied palestinian territory': 'PS',
  'palestinian territories': 'PS',
  'palestine state of': 'PS',
  'russian federation': 'RU',
  'slovak republic': 'SK',
  'st kitts and nevis': 'KN',
  'st lucia': 'LC',
  'st vincent and the grenadines': 'VC',
  'syrian arab republic': 'SY',
  'the bahamas': 'BS',
  'timor leste': 'TL',
  'turkiye': 'TR',
  'u s': 'US',
  'united states of america': 'US',
  'venezuela rb': 'VE',
  'viet nam': 'VN',
  'west bank and gaza': 'PS',
  'yemen rep': 'YE',
};

function normalizeCountryToken(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’.(),/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isIso2(value) {
  return /^[A-Z]{2}$/.test(String(value || '').trim());
}

function isIso3(value) {
  return /^[A-Z]{3}$/.test(String(value || '').trim());
}

export function createCountryResolvers(countryNames = COUNTRY_NAMES, geojson = COUNTRIES_GEOJSON) {
  const nameToIso2 = new Map();
  const iso3ToIso2 = new Map();

  for (const [name, iso2] of Object.entries(countryNames)) {
    if (isIso2(iso2)) nameToIso2.set(normalizeCountryToken(name), iso2.toUpperCase());
  }

  for (const [alias, iso2] of Object.entries(COUNTRY_ALIAS_MAP)) {
    if (isIso2(iso2)) nameToIso2.set(normalizeCountryToken(alias), iso2.toUpperCase());
  }

  for (const feature of geojson?.features || []) {
    const properties = feature?.properties || {};
    const iso2 = String(properties['ISO3166-1-Alpha-2'] || '').toUpperCase();
    const iso3 = String(properties['ISO3166-1-Alpha-3'] || '').toUpperCase();
    const name = properties.name;
    if (isIso2(iso2)) {
      if (typeof name === 'string' && name.trim()) {
        nameToIso2.set(normalizeCountryToken(name), iso2);
      }
      if (isIso3(iso3)) iso3ToIso2.set(iso3, iso2);
    }
  }

  return { nameToIso2, iso3ToIso2 };
}

const COUNTRY_RESOLVERS = createCountryResolvers();

export function resolveIso2({ iso2, iso3, name }, resolvers = COUNTRY_RESOLVERS) {
  const upperIso2 = String(iso2 || '').trim().toUpperCase();
  if (isIso2(upperIso2)) return upperIso2;

  const upperIso3 = String(iso3 || '').trim().toUpperCase();
  if (isIso3(upperIso3)) {
    const mapped = resolvers.iso3ToIso2.get(upperIso3);
    if (mapped) return mapped;
  }

  const normalizedName = normalizeCountryToken(name);
  return resolvers.nameToIso2.get(normalizedName) || null;
}

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

async function fetchBinary(url, { timeoutMs = 30_000, accept = '*/*' } = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: accept,
      'User-Agent': CHROME_UA,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || '',
  };
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

  while (page <= totalPages) {
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

  while (nextUrl) {
    const payload = await withRetry(() => fetchJson(nextUrl), 2, 750);
    if (!Array.isArray(payload?.value)) throw new Error(`Unexpected WHO response shape for ${indicatorCode}`);
    rows.push(...payload.value);
    nextUrl = payload['@odata.nextLink'] || payload['odata.nextLink'] || null;
  }

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
  if (parsed.size === 0) throw new Error('RSF ranking page did not expose any country rows');
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

  const merged = eurostatData ? parseEurostatEnergyDataset(eurostatData) : new Map();
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

async function parseTabularPayload(buffer, contentType, sourceUrl) {
  const lowerType = String(contentType || '').toLowerCase();
  if (lowerType.includes('application/json') || lowerType.includes('+json')) {
    const json = JSON.parse(buffer.toString('utf8'));
    if (Array.isArray(json)) return json;
    if (Array.isArray(json?.data)) return json.data;
    if (Array.isArray(json?.rows)) return json.rows;
    throw new Error('JSON payload did not contain an array');
  }

  if (lowerType.includes('text/csv') || lowerType.includes('application/csv') || sourceUrl.endsWith('.csv')) {
    return parseDelimitedText(buffer.toString('utf8'), ',');
  }

  if (lowerType.includes('text/tab-separated-values') || sourceUrl.endsWith('.tsv')) {
    return parseDelimitedText(buffer.toString('utf8'), '\t');
  }

  if (
    lowerType.includes('spreadsheetml')
    || lowerType.includes('application/vnd.ms-excel')
    || sourceUrl.endsWith('.xlsx')
    || sourceUrl.endsWith('.xls')
  ) {
    let ExcelJS;
    try {
      ({ default: ExcelJS } = await import('exceljs'));
    } catch (error) {
      throw new Error(`Excel parsing unavailable (${error.message})`);
    }
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) return [];
    const rows = [];
    const headerRow = worksheet.getRow(1).values.slice(1).map((value) => String(value || '').trim());
    for (let rowIdx = 2; rowIdx <= worksheet.rowCount; rowIdx += 1) {
      const row = worksheet.getRow(rowIdx).values.slice(1);
      if (!row.some((cell) => String(cell ?? '').trim())) continue;
      rows.push(Object.fromEntries(headerRow.map((header, idx) => [header, row[idx] ?? ''])));
    }
    return rows;
  }

  throw new Error(`Unsupported content-type ${contentType || '(missing)'}`);
}

function pickField(row, fieldNames) {
  for (const field of fieldNames) {
    if (row[field] != null && String(row[field]).trim()) return row[field];
    const matchedKey = Object.keys(row).find((key) => normalizeCountryToken(key) === normalizeCountryToken(field));
    if (matchedKey && String(row[matchedKey]).trim()) return row[matchedKey];
  }
  return '';
}

async function fetchOptionalTabularRows(sourceUrl) {
  const { buffer, contentType } = await withRetry(() => fetchBinary(sourceUrl), 1, 750);
  return parseTabularPayload(buffer, contentType, sourceUrl);
}

async function fetchOptionalGpiDataset() {
  if (!process.env.RESILIENCE_GPI_URL) {
    throw new Error('GPI: no machine-readable source configured; set RESILIENCE_GPI_URL');
  }
  const rows = await fetchOptionalTabularRows(GPI_SOURCE_URL);
  const parsed = new Map();
  for (const row of rows) {
    const iso2 = resolveIso2({
      iso2: pickField(row, ['iso2', 'country_code']),
      iso3: pickField(row, ['iso3', 'country_iso3']),
      name: pickField(row, ['country', 'country_name', 'name']),
    });
    const rank = safeNum(pickField(row, ['rank', 'ranking']));
    const score = safeNum(pickField(row, ['score', 'gpi_score', 'overall_score']));
    const year = safeNum(pickField(row, ['year', 'edition']));
    if (!iso2 || rank == null || score == null) continue;
    parsed.set(iso2, {
      source: 'gpi-bulk',
      rank,
      score: roundMetric(score, 3),
      year,
    });
  }
  if (parsed.size === 0) throw new Error('GPI: machine-readable source returned no rows');
  return parsed;
}

async function fetchOptionalFaoDataset() {
  if (!process.env.RESILIENCE_FSIN_URL) {
    throw new Error('FSIN: bulk source blocked or unavailable; set RESILIENCE_FSIN_URL');
  }
  const rows = await fetchOptionalTabularRows(FSIN_SOURCE_URL);
  const parsed = new Map();
  for (const row of rows) {
    const iso2 = resolveIso2({
      iso2: pickField(row, ['iso2', 'country_code']),
      iso3: pickField(row, ['iso3', 'country_iso3']),
      name: pickField(row, ['country', 'country_name', 'area']),
    });
    if (!iso2) continue;
    const year = safeNum(pickField(row, ['year', 'report_year']));
    const peopleInCrisis = safeNum(pickField(row, ['people_in_crisis', 'people', 'population']));
    const phase = pickField(row, ['phase', 'ipc_phase', 'severity']);
    const source = pickField(row, ['source', 'dataset']) || 'fsin';
    if (peopleInCrisis == null && !phase) continue;
    parsed.set(iso2, {
      source: 'fsin-bulk',
      year,
      peopleInCrisis: roundMetric(peopleInCrisis, 0),
      phase: phase || null,
      dataset: source,
    });
  }
  if (parsed.size === 0) throw new Error('FSIN: machine-readable source returned no rows');
  return parsed;
}

async function fetchOptionalAquastatDataset() {
  if (!process.env.RESILIENCE_AQUASTAT_URL) {
    throw new Error('AQUASTAT: no stable machine-readable feed configured; set RESILIENCE_AQUASTAT_URL');
  }
  const rows = await fetchOptionalTabularRows(AQUASTAT_SOURCE_URL);
  const parsed = new Map();
  for (const row of rows) {
    const iso2 = resolveIso2({
      iso2: pickField(row, ['iso2', 'country_code']),
      iso3: pickField(row, ['iso3', 'country_iso3']),
      name: pickField(row, ['country', 'country_name', 'area']),
    });
    if (!iso2) continue;
    const value = safeNum(pickField(row, ['value', 'numeric_value', 'measure_value']));
    const year = safeNum(pickField(row, ['year', 'time']));
    const indicator = pickField(row, ['indicator', 'measure', 'variable']);
    if (value == null && !indicator) continue;
    parsed.set(iso2, {
      source: 'aquastat',
      year,
      indicator: indicator || null,
      value: roundMetric(value),
    });
  }
  if (parsed.size === 0) throw new Error('AQUASTAT: machine-readable source returned no rows');
  return parsed;
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
  await redisPipeline(commands);
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
    { key: 'gpi', fetcher: fetchOptionalGpiDataset },
    { key: 'rsf', fetcher: fetchRsfDataset },
    { key: 'who', fetcher: fetchWhoDataset },
    { key: 'fao', fetcher: fetchOptionalFaoDataset },
    { key: 'aquastat', fetcher: fetchOptionalAquastatDataset },
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
