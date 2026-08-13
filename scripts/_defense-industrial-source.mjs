import { createRequire } from 'node:module';
import Papa from 'papaparse';
import { CHROME_UA, sleep, withRetry } from './_seed-utils.mjs';

const require = createRequire(import.meta.url);
const ISO3_TO_ISO2 = require('./shared/iso3-to-iso2.json');
const { countryNameToIso2 } = require('./shared/country-name-to-iso2.cjs');

export const WB_DEFENSE_INDICATORS = Object.freeze([
  { key: 'expenditurePctGdp', id: 'MS.MIL.XPND.GD.ZS' },
  { key: 'expenditureUsd', id: 'MS.MIL.XPND.CD' },
  { key: 'personnel', id: 'MS.MIL.TOTL.P1' },
  { key: 'armsExportsTiv', id: 'MS.MIL.XPRT.KD' },
  { key: 'armsImportsTiv', id: 'MS.MIL.MPRT.KD' },
]);

const DEFAULT_SIPRI_BASE_URL = 'https://atbackend.sipri.org/api/p';
const SOURCE = 'SIPRI Arms Transfers Database';
export const DEFENSE_INDUSTRIAL_TTL_SECONDS = 30 * 24 * 3600;
export const MIN_COMPLETE_SIPRI_IMPORTER_COUNT = 25;

function round4(value) {
  return Math.round(value * 10_000) / 10_000;
}

export function mapSipriEntityToIso2(name) {
  const value = String(name || '').trim();
  if (!value || /unknown/i.test(value) || /\*$/.test(value)) return null;
  return countryNameToIso2(value);
}

function csvRows(text) {
  const parsed = Papa.parse(String(text || '').replace(/^\uFEFF/, ''), {
    dynamicTyping: false,
    skipEmptyLines: 'greedy',
    transform: (value) => value.trim(),
  });
  if (parsed.errors.length > 0) {
    throw new Error(`SIPRI CSV parse failed: ${parsed.errors[0]?.message || 'unknown error'}`);
  }
  return parsed.data;
}

function numericCell(value) {
  const cleaned = String(value || '').replace(/[% ,]/g, '').trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseSipriSupplierCsv(csv, { importerIso2, windowStartYear, windowEndYear }) {
  const rows = csvRows(csv);
  const headerIndex = rows.findIndex((row) => row[0] === 'Supplier');
  if (headerIndex < 0) throw new Error('SIPRI CSV is missing the Supplier header');
  const header = rows[headerIndex];
  const windowLabel = `${windowStartYear}-${windowEndYear}`;
  const totalIndex = header.indexOf(windowLabel);
  if (totalIndex < 0) throw new Error(`SIPRI CSV is missing ${windowLabel}`);

  const mapped = [];
  const allSuppliers = new Map();
  const unmapped = [];
  for (const row of rows.slice(headerIndex + 1)) {
    const supplierName = row[0] || '';
    if (!supplierName || /^total exports to /i.test(supplierName)) continue;
    const tiv = numericCell(row[totalIndex]);
    if (!(tiv > 0)) continue;
    const supplierIso2 = mapSipriEntityToIso2(supplierName);
    const concentrationKey = supplierIso2 || `unmapped:${supplierName.trim().toLowerCase()}`;
    allSuppliers.set(concentrationKey, (allSuppliers.get(concentrationKey) || 0) + tiv);
    if (!supplierIso2) {
      unmapped.push(supplierName);
      continue;
    }
    mapped.push({ supplierIso2, tiv });
  }

  const bySupplier = new Map();
  for (const entry of mapped) {
    bySupplier.set(entry.supplierIso2, (bySupplier.get(entry.supplierIso2) || 0) + entry.tiv);
  }
  // Keep unmapped positive rows in the denominator. Renormalizing only the
  // mapped rows would overstate both published supplier shares and HHI.
  const totalTiv = [...allSuppliers.values()].reduce((sum, value) => sum + value, 0);
  const suppliers = totalTiv > 0
    ? [...bySupplier.entries()]
      .map(([supplierIso2, tiv]) => ({ supplierIso2, tivShare: round4(tiv / totalTiv) }))
      .sort((a, b) => b.tivShare - a.tivShare)
    : [];
  const supplierHhi = totalTiv > 0
    ? round4([...allSuppliers.values()].reduce((sum, tiv) => sum + (tiv / totalTiv) ** 2, 0))
    : 0;
  const mappedTiv = [...bySupplier.values()].reduce((sum, value) => sum + value, 0);

  return {
    importerIso2,
    suppliers,
    supplierHhi,
    window: { startYear: windowStartYear, endYear: windowEndYear },
    source: SOURCE,
    unmappedCount: unmapped.length,
    unmappedEntities: [...new Set(unmapped)].slice(0, 25),
    mappingCoverage: totalTiv > 0 ? round4(mappedTiv / totalTiv) : 0,
  };
}

export function parseWbIndicatorPage(raw, indicatorId) {
  if (!Array.isArray(raw) || !Array.isArray(raw[1])) {
    throw new Error(`Unexpected World Bank response for ${indicatorId}`);
  }
  const observations = new Map();
  for (const entry of raw[1]) {
    const iso2 = ISO3_TO_ISO2[String(entry?.countryiso3code || '').toUpperCase()];
    const year = Number(entry?.date);
    const value = Number(entry?.value);
    if (!iso2 || !Number.isInteger(year) || !Number.isFinite(value) || entry?.value == null) continue;
    if (!observations.has(iso2)) observations.set(iso2, []);
    observations.get(iso2).push({ year, value });
  }
  const parsed = {};
  for (const [iso2, values] of observations) {
    values.sort((a, b) => b.year - a.year);
    const latest = values[0];
    const previous = values.find((entry) => entry.year < latest.year);
    parsed[iso2] = {
      value: latest.value,
      year: latest.year,
      ...(previous ? { previousValue: previous.value, previousYear: previous.year } : {}),
      source: 'World Bank',
    };
  }
  return parsed;
}

async function fetchJson(url, init, fetchFn) {
  return withRetry(async () => {
    const response = await fetchFn(url, {
      ...init,
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json', ...(init?.headers || {}) },
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) {
      const error = new Error(`${new URL(url).hostname} HTTP ${response.status}`);
      if (response.status >= 400 && response.status < 500 && response.status !== 429) error.nonRetryable = true;
      const retryAfter = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterMs = retryAfter * 1000;
      throw error;
    }
    return response.json();
  }, 2, 1_000);
}

export async function fetchWorldBankDefense({ fetchFn = fetch, nowYear = new Date().getUTCFullYear() } = {}) {
  const dateRange = `${nowYear - 8}:${nowYear}`;
  const entries = await Promise.all(WB_DEFENSE_INDICATORS.map(async (indicator) => {
    const url = `https://api.worldbank.org/v2/country/all/indicator/${indicator.id}?format=json&date=${dateRange}&per_page=20000`;
    const raw = await fetchJson(url, undefined, fetchFn);
    return [indicator.key, parseWbIndicatorPage(raw, indicator.id)];
  }));
  return Object.fromEntries(entries);
}

function mergeWorldBankIndicators(indicatorData) {
  const countries = {};
  for (const { key } of WB_DEFENSE_INDICATORS) {
    for (const [iso2, metric] of Object.entries(indicatorData[key] || {})) {
      if (!countries[iso2]) countries[iso2] = { iso2 };
      countries[iso2][key] = metric;
    }
  }
  return countries;
}

function sipriFilters(importerId, startYear, endYear) {
  return {
    filters: [
      { field: 'Year range 1', oldField: '', condition: 'contains', value1: String(startYear), value2: String(endYear), listData: [] },
      { field: 'Recipient', oldField: '', condition: 'contains', value1: '', value2: '', listData: [importerId] },
      { field: 'orderbyseller', oldField: '', condition: '', value1: '', value2: '', listData: [] },
      { field: 'summarize-by', oldField: '', condition: '', value1: 'country', value2: '', listData: [] },
      { field: 'DeliveryType', oldField: '', condition: '', value1: 'delivered', value2: '', listData: [] },
      { field: 'Status', oldField: '', condition: '', value1: '0', value2: '', listData: [] },
    ],
    logic: 'AND',
  };
}

export async function fetchSipriSupplierDependencies({
  fetchFn = fetch,
  baseUrl = process.env.SIPRI_ARMS_API_BASE_URL || DEFAULT_SIPRI_BASE_URL,
  concurrency = 4,
  delayMs = 150,
  logger = console,
} = {}) {
  const [maxYearValue, catalog] = await Promise.all([
    fetchJson(`${baseUrl}/trades/getMaxYear`, undefined, fetchFn),
    fetchJson(`${baseUrl}/countries/getAllCountriesTrimmed`, undefined, fetchFn),
  ]);
  const maxYear = Number(maxYearValue);
  if (!Number.isInteger(maxYear)) throw new Error('SIPRI getMaxYear returned an invalid year');
  const startYear = maxYear - 4;
  if (!Array.isArray(catalog)) throw new Error('SIPRI country catalog is invalid');
  const resolvedCatalog = catalog.map((entry) => ({ ...entry, iso2: mapSipriEntityToIso2(entry?.Name) }));
  const unmappedCatalog = resolvedCatalog.filter((entry) => !entry.iso2);
  if (unmappedCatalog.length > 0) {
    const preview = unmappedCatalog.slice(0, 25)
      .map((entry) => String(entry?.Name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80))
      .join(', ');
    logger.warn(`  SIPRI importer entities unmapped (${unmappedCatalog.length}/${catalog.length}): ${preview}`);
  }
  const importers = resolvedCatalog
    .filter((entry) => entry.iso2 && Number.isInteger(entry.EntityId));
  if (importers.length < 150) {
    throw new Error(`SIPRI country catalog mapped only ${importers.length} importers; refusing a complete refresh`);
  }
  const importerByIso2 = new Map();
  for (const importer of importers) {
    const prior = importerByIso2.get(importer.iso2);
    if (prior && prior.EntityId !== importer.EntityId) {
      throw new Error(`SIPRI importer mapping collision for ${importer.iso2}: ${prior.Name} and ${importer.Name}`);
    }
    importerByIso2.set(importer.iso2, importer);
  }
  const uniqueImporters = [...importerByIso2.values()];
  const output = {};
  const unmapped = new Map();
  const failedImporters = [];
  let cursor = 0;

  async function worker() {
    while (cursor < uniqueImporters.length) {
      const importer = uniqueImporters[cursor++];
      try {
        const body = sipriFilters(importer.EntityId, startYear, maxYear);
        const json = await fetchJson(`${baseUrl}/trades/import-export-csv/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }, fetchFn);
        const encoded = String(json?.bytes || '');
        if (encoded.length > 32 * 1024 * 1024) throw new Error('SIPRI CSV exceeds the 24 MiB decoded limit');
        const csv = Buffer.from(encoded, 'base64').toString('utf8');
        const parsed = parseSipriSupplierCsv(csv, {
          importerIso2: importer.iso2,
          windowStartYear: startYear,
          windowEndYear: maxYear,
        });
        if (parsed.suppliers.length > 0) output[importer.iso2] = parsed;
        for (const entity of parsed.unmappedEntities) unmapped.set(entity, (unmapped.get(entity) || 0) + 1);
      } catch (error) {
        failedImporters.push({
          iso2: importer.iso2,
          message: String(error?.message || error).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160),
        });
      }
      if (delayMs > 0) await sleep(delayMs);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, 8)) }, () => worker()));
  if (unmapped.size > 0) {
    const preview = [...unmapped.entries()].slice(0, 25)
      .map(([name, count]) => `${String(name).replace(/[\u0000-\u001f\u007f]/g, ' ')} (${count})`)
      .join(', ');
    logger.warn(`  SIPRI unmapped supplier entities skipped (${unmapped.size} unique): ${preview}`);
  }
  if (failedImporters.length > 0) {
    const preview = failedImporters.slice(0, 25)
      .map((entry) => `${entry.iso2} (${entry.message})`)
      .join(', ');
    logger.warn(`  SIPRI importer requests failed (${failedImporters.length}): ${preview}`);
  }
  return { importers: output, failedImporters, windowEndYear: maxYear };
}

export async function buildWorldBankIndustrialSnapshot({
  fetchWorldBank = fetchWorldBankDefense,
  now = () => new Date(),
} = {}) {
  const indicatorData = await fetchWorldBank();
  const countries = mergeWorldBankIndicators(indicatorData);
  return {
    countries,
    stage: { status: 'ok', countryCount: Object.keys(countries).length },
    fetchedAt: now().toISOString(),
  };
}

export async function buildSipriSupplierSnapshot({
  fetchSipri = fetchSipriSupplierDependencies,
  previousSnapshot = {},
  minimumCompleteImporterCount = MIN_COMPLETE_SIPRI_IMPORTER_COUNT,
  now = () => new Date(),
} = {}) {
  const result = await fetchSipri();
  // Preserve compatibility for injected test fetchers that return the importer
  // map directly, while production returns stage diagnostics alongside it.
  const fetched = result?.importers || result || {};
  const failures = Array.isArray(result?.failedImporters) ? result.failedImporters : [];
  const fetchedAt = now().toISOString();
  const fetchedImporterCount = Object.keys(fetched).length;
  if (failures.length === 0 && fetchedImporterCount < minimumCompleteImporterCount) {
    throw new Error(
      `SIPRI complete refresh returned only ${fetchedImporterCount} positive importer rows; `
      + `minimum is ${minimumCompleteImporterCount}`,
    );
  }

  const importers = Object.fromEntries(Object.entries(fetched).map(([iso2, dependency]) => [
    iso2,
    { ...dependency, fetchedAt, retained: false },
  ]));
  let preservedImporterCount = 0;
  for (const failure of failures) {
    const previous = previousSnapshot?.importers?.[failure.iso2];
    if (!previous) continue;
    importers[failure.iso2] = {
      ...previous,
      fetchedAt: previous.fetchedAt || previousSnapshot.fetchedAt || '',
      retained: true,
    };
    preservedImporterCount += 1;
  }

  return {
    importers,
    stage: {
      status: failures.length > 0 ? 'partial' : 'ok',
      importerCount: fetchedImporterCount,
      failedImporterCount: failures.length,
      preservedImporterCount,
      windowEndYear: Number(result?.windowEndYear) || 0,
    },
    fetchedAt,
  };
}

export function buildArmsSupplierCompletion(data) {
  return data?.stage?.status === 'ok'
    ? { completedAt: data.fetchedAt, windowEndYear: data.stage.windowEndYear }
    : {};
}
