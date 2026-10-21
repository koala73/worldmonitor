// @ts-check
// Compact audited energy-import projection for regional balance scoring.
//
// `energy:mix:v1:_all` used to carry `importShare`, but that field was an
// invalid OWID electricity-import mapping — not primary-energy import
// dependency. The audited observations live on per-country
// `resilience:static:{ISO2}` records (`iea.energyImportDependency`) from
// World Bank EG.IMP.CONS.ZS and Eurostat nrg_ind_id.
//
// Regional snapshot compute reads a single in-memory aggregate keyed by
// ENERGY_IMPORT_SOURCE_KEY. The snapshot loader hydrates that aggregate
// from the existing static country records; tests can pass the same shape
// directly. Exact source labels only — lookalikes fail closed, matching
// getEnergyImportDependencyObservedSources().

export const ENERGY_IMPORT_SOURCE_KEY = 'resilience:static:energy-import:v1';
export const RESILIENCE_STATIC_INDEX_KEY = 'resilience:static:index:v1';
export const RESILIENCE_STATIC_PREFIX = 'resilience:static:';

const AUDITED_IMPORT_SOURCES = new Set(['worldbank', 'eurostat']);

/**
 * @param {unknown} source
 * @returns {source is 'worldbank' | 'eurostat'}
 */
export function isAuditedImportSource(source) {
  return typeof source === 'string' && AUDITED_IMPORT_SOURCES.has(source);
}

/**
 * @param {string} iso2
 * @returns {string}
 */
export function countryStaticKey(iso2) {
  return `${RESILIENCE_STATIC_PREFIX}${String(iso2).trim().toUpperCase()}`;
}

/**
 * @param {unknown} record
 * @returns {{ value: number, year: number, source: 'worldbank' | 'eurostat' } | null}
 */
export function readAuditedImportObservation(record) {
  if (record == null || typeof record !== 'object') return null;
  const obj = /** @type {Record<string, unknown>} */ (record);
  const nested = (
    obj.iea
    && typeof obj.iea === 'object'
    && /** @type {Record<string, unknown>} */ (obj.iea).energyImportDependency
  ) || obj.energyImportDependency;
  const observation = (nested && typeof nested === 'object')
    ? /** @type {Record<string, unknown>} */ (nested)
    : obj;
  const value = observation.value;
  const year = observation.year;
  const source = observation.source;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (typeof year !== 'number' || !Number.isInteger(year) || year <= 0) return null;
  if (!isAuditedImportSource(source)) return null;
  return { value, year, source };
}

/**
 * @param {Iterable<[string, unknown]> | Record<string, unknown> | Map<string, unknown>} countryRecords
 * @param {{ fetchedAt?: string | number | null, seedYear?: number | null }} [meta]
 * @returns {{
 *   countries: Record<string, { value: number, year: number, source: 'worldbank' | 'eurostat' }>,
 *   count: number,
 *   fetchedAt: string | number | null,
 *   seedYear: number | null,
 *   source: string,
 *   status: 'ok',
 * }}
 */
export function buildEnergyImportAggregate(countryRecords, meta = {}) {
  /** @type {Iterable<[string, unknown]>} */
  let entries;
  if (countryRecords instanceof Map) {
    entries = countryRecords.entries();
  } else if (Array.isArray(countryRecords)) {
    entries = countryRecords;
  } else if (countryRecords && typeof countryRecords === 'object') {
    entries = Object.entries(countryRecords);
  } else {
    entries = [];
  }

  /** @type {Record<string, { value: number, year: number, source: 'worldbank' | 'eurostat' }>} */
  const countries = {};
  for (const [rawIso, record] of entries) {
    const iso2 = String(rawIso || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(iso2)) continue;
    const observation = readAuditedImportObservation(record);
    if (!observation) continue;
    countries[iso2] = observation;
  }

  return {
    countries,
    count: Object.keys(countries).length,
    fetchedAt: meta.fetchedAt ?? null,
    seedYear: meta.seedYear ?? null,
    source: 'resilience-static-iea',
    status: 'ok',
  };
}

/**
 * @param {unknown} indexPayload
 * @returns {string[]}
 */
export function listStaticCountryKeys(indexPayload) {
  const countries = (
    indexPayload
    && typeof indexPayload === 'object'
    && Array.isArray(/** @type {Record<string, unknown>} */ (indexPayload).countries)
  )
    ? /** @type {unknown[]} */ (/** @type {Record<string, unknown>} */ (indexPayload).countries)
    : [];
  const keys = [];
  for (const raw of countries) {
    const iso2 = String(raw || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(iso2)) continue;
    keys.push(countryStaticKey(iso2));
  }
  return keys;
}

/**
 * @param {unknown} payload
 * @param {string} dataset
 * @returns {boolean}
 */
function reportsFailedDataset(payload, dataset) {
  if (payload === null || typeof payload !== 'object') return false;
  const failedDatasets = /** @type {Record<string, unknown>} */ (payload).failedDatasets;
  return Array.isArray(failedDatasets) && failedDatasets.includes(dataset);
}

/**
 * Attach ENERGY_IMPORT_SOURCE_KEY from already-fetched static country records.
 * Leaves a caller-supplied aggregate in place so unit tests can inject one.
 *
 * @param {Record<string, any>} sources
 * @param {(keys: string[]) => Promise<Record<string, unknown>>} readKeys
 * @param {unknown} [sourceMeta]
 * @returns {Promise<Record<string, any>>}
 */
export async function hydrateEnergyImportAggregate(sources, readKeys, sourceMeta = null) {
  if (sources[ENERGY_IMPORT_SOURCE_KEY] && typeof sources[ENERGY_IMPORT_SOURCE_KEY] === 'object') {
    return sources;
  }
  const index = sources[RESILIENCE_STATIC_INDEX_KEY];
  if (reportsFailedDataset(index, 'iea') || reportsFailedDataset(sourceMeta, 'iea')) {
    throw new Error('Energy-import hydration rejected failed resilience-static IEA dataset');
  }
  const keys = listStaticCountryKeys(index);
  const payloads = keys.length ? await readKeys(keys) : {};
  /** @type {Record<string, unknown>} */
  const countryRecords = {};
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(payloads, key)) {
      throw new Error(`Energy-import hydration missing Redis payload: ${key}`);
    }
    const payload = payloads[key];
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error(`Energy-import hydration received invalid Redis payload: ${key}`);
    }
    const iso2 = key.startsWith(RESILIENCE_STATIC_PREFIX)
      ? key.slice(RESILIENCE_STATIC_PREFIX.length)
      : key;
    if (/^[A-Z]{2}$/.test(iso2)) countryRecords[iso2] = payload;
  }
  sources[ENERGY_IMPORT_SOURCE_KEY] = buildEnergyImportAggregate(countryRecords, {
    fetchedAt: typeof index?.seededAt === 'string' || typeof index?.seededAt === 'number'
      ? index.seededAt
      : null,
    seedYear: typeof index?.seedYear === 'number' ? index.seedYear : null,
  });
  return sources;
}
