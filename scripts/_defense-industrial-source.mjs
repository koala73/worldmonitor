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

// A sweep fetches the catalog in CHUNKS across ticks instead of in one pass.
//
// Measured 2026-08-18 against atbackend.sipri.org: a single importer POST takes
// mean 31.8s / p90 37.3s, not the ~10.6s this file was sized on. At concurrency
// 8 the full ~200-importer refresh therefore needs ~800s, and it cannot be made
// to fit: Railway hard-kills a cron container at 600s, so no fetch deadline and
// no bundle budget can hold it. Raising concurrency is not the escape either --
// sequential samples climbed 23.2s -> 37.3s as they accumulated, which reads as
// upstream throttling, and the importer POSTs share a host with
// seed-defense-industrial.
//
// So each tick refreshes the SLICE of importers whose data is oldest and lets
// the rest keep their previous rows. The sweep is complete when every mapped
// importer holds a row for the current window; only then does the completion
// marker advance, so a mid-sweep tick leaves seed-meta old, stays "due", and is
// picked up again on the next eligible tick. No cursor key is needed -- the
// published snapshot IS the cursor.
export const SIPRI_SWEEP_CHUNK = 56;

// Stop TAKING new importers past this, then return what completed. The outer
// fetchPhaseTimeoutMs aborts and discards the WHOLE phase, so without this a
// slow tick throws away every row it already paid for.
//
// The gap to fetchPhaseTimeoutMs (340s) is 120s, and that gap is the point: this
// budget only stops workers PICKING UP work, it cannot cancel a request already
// in flight. A live tick on 2026-08-18 took 135s for a single batch of 8 because
// two importers returned HTTP 500 and retried, so the worst in-flight chain is
// ~35s + 1s backoff + ~35s + 2s + ~35s = ~110s. A worker that grabs an importer
// one millisecond inside the budget must still land before the hard deadline.
export const SIPRI_SWEEP_SOFT_BUDGET_MS = 220_000;

// An importer row counts as current when it carries the live window AND was
// fetched inside this horizon. The value is bounded on BOTH sides and neither
// bound is obvious, so it is pinned by test rather than left to judgement:
//
//   > sweep duration (~8 days)   Rows refreshed on the first tick must still be
//                                current on the last one. A shorter horizon
//                                expires the head of the sweep before the tail
//                                lands, so `unfetched` never reaches 0, the
//                                completion marker is never written, and the
//                                section stays due forever — a livelock that
//                                looks exactly like the bug this replaced.
//   < refresh interval (14 days) When the section next comes due, EVERY row must
//                                read stale so a fresh sweep starts. A longer
//                                horizon leaves them all current, the sweep has
//                                nothing to select, and it completes instantly
//                                without fetching anything — silent staleness.
//
// Measured inputs: ~40 importers land per tick once the 220s soft budget and
// SIPRI's retry behaviour are accounted for, so 200 importers is ~5 ticks; the
// section leads 2 of every 3 rotation days, so a sweep spans ~8 days. 10 sits
// between that and the 14-day refresh interval with ~2 days of margin on each
// side. The section interval was widened 10d -> 14d to buy the upper margin --
// SIPRI publishes 5-year windows annually, so a fortnightly refresh loses
// nothing.
export const SIPRI_SWEEP_HORIZON_MS = 10 * 24 * 3600 * 1000;

/**
 * Importers still owed a refresh this sweep, oldest first.
 *
 * Deliberately derived from the published snapshot rather than a cursor key:
 * a cursor can disagree with the data (crash between write and publish, a
 * restored backup, a manual edit) and then silently skip a slice forever. This
 * cannot -- if a row is missing or stale it is selected, and if it is current
 * it is not.
 *
 * @param {Array<{iso2: string}>} candidates mapped importers from the catalog
 * @param {any} previousSnapshot last published snapshot
 * @param {number} windowEndYear the window the current sweep is filling
 * @param {number} nowMs
 */
export function selectSweepImporters(candidates, previousSnapshot, windowEndYear, nowMs = Date.now()) {
  const rows = previousSnapshot?.importers || {};
  const ageOf = (iso2) => {
    const row = rows[iso2];
    if (!row) return Number.POSITIVE_INFINITY;
    // A new window invalidates every row at once -- that is the annual re-sweep.
    if (Number(row?.window?.endYear) !== windowEndYear) return Number.POSITIVE_INFINITY;
    const at = Date.parse(row?.fetchedAt || '');
    if (!Number.isFinite(at)) return Number.POSITIVE_INFINITY;
    return nowMs - at;
  };
  // Strictly OUTSIDE the horizon. An earlier draft filtered `age > 0`, which is
  // true of every row that has ever been written: nothing was ever current,
  // `unfetched` could never reach 0, and the completion marker would never have
  // been written. The sweep would have livelocked in exactly the shape of the
  // bug it replaces.
  const pending = candidates
    .map((c) => ({ ...c, age: ageOf(c.iso2) }))
    .filter((c) => c.age > SIPRI_SWEEP_HORIZON_MS);
  // Oldest first so a repeatedly-failing importer cannot monopolise the slice:
  // once fetched its age resets and it sorts to the back.
  pending.sort((a, b) => b.age - a.age);
  return pending;
}

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
  // 8 is a POLITENESS ceiling, not a throughput dial. Do not raise it to chase
  // the deadline — the sweep above is what makes the work fit.
  //
  // History: this was 4, then 8 (#6807), each time sized on a ~10.6s per-request
  // model. Measured 2026-08-18 the real figure is mean 31.8s / p90 37.3s, so the
  // full ~200-importer pass needs ~800s at concurrency 8 and blew its 390s
  // deadline on every run — 390.9s then exit 75, which left 179s of the 570s
  // bundle budget and deferred every remaining section (they each need >=190s).
  // That is why military:arms-suppliers:complete:v1 had never been written.
  //
  // Raising concurrency does not recover it. Sequential samples climbed
  // 23.2s -> 37.3s as they accumulated, which reads as upstream throttling, and
  // these POSTs share a host with seed-defense-industrial — a block here takes
  // that seeder down too.
  concurrency = 8,
  delayMs = 150,
  logger = console,
  // The slice this tick is allowed to refresh. Undefined = every mapped
  // importer, which is the shape the unit tests and any one-shot manual run use.
  selectImporters = null,
  softBudgetMs = SIPRI_SWEEP_SOFT_BUDGET_MS,
  now = () => Date.now(),
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
  const catalogImporters = [...importerByIso2.values()];
  // selectImporters returns the slice owed a refresh; everything it leaves out
  // keeps its previously published row via buildSipriSupplierSnapshot.
  const uniqueImporters = typeof selectImporters === 'function'
    ? selectImporters(catalogImporters, maxYear)
    : catalogImporters;
  const sweepPending = catalogImporters.length - uniqueImporters.length;
  const output = {};
  const unmapped = new Map();
  const failedImporters = [];
  let cursor = 0;

  const fetchStartedAt = now();
  let budgetStoppedAt = 0;
  async function worker() {
    while (cursor < uniqueImporters.length) {
      // Check BEFORE taking work, not after: the outer fetchPhaseTimeoutMs
      // aborts and discards the entire phase, so a worker that starts a 37s
      // request it cannot finish costs every row this tick already paid for.
      if (softBudgetMs > 0 && now() - fetchStartedAt > softBudgetMs) {
        budgetStoppedAt = uniqueImporters.length - cursor;
        return;
      }
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
  const unfetched = budgetStoppedAt + sweepPending;
  if (budgetStoppedAt > 0) {
    logger.warn(
      `  SIPRI soft budget reached after ${Math.round((now() - fetchStartedAt) / 1000)}s — `
      + `${budgetStoppedAt} importer(s) left for the next tick`,
    );
  }
  return {
    importers: output,
    failedImporters,
    windowEndYear: maxYear,
    sweep: {
      catalogCount: catalogImporters.length,
      attempted: uniqueImporters.length,
      fetched: Object.keys(output).length,
      // Sections this tick did not even attempt: deliberately deferred by the
      // slice, plus any the soft budget cut off.
      unfetched,
    },
  };
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
  const sweep = result?.sweep || null;
  const fetchedAt = now().toISOString();
  const fetchedImporterCount = Object.keys(fetched).length;

  // Carry EVERY previously published row forward, then overlay this tick's
  // slice. Before chunking only failures were retained, because a pass either
  // covered the whole catalog or was a failure; now a healthy tick deliberately
  // refreshes ~56 of ~200 and the other ~144 must survive untouched, keeping
  // their original fetchedAt so selectSweepImporters can still see their age.
  const importers = {};
  let preservedImporterCount = 0;
  for (const [iso2, previous] of Object.entries(previousSnapshot?.importers || {})) {
    importers[iso2] = {
      ...previous,
      fetchedAt: previous.fetchedAt || previousSnapshot.fetchedAt || '',
      retained: true,
    };
    preservedImporterCount += 1;
  }
  for (const [iso2, dependency] of Object.entries(fetched)) {
    if (importers[iso2]) preservedImporterCount -= 1;
    importers[iso2] = { ...dependency, fetchedAt, retained: false };
  }

  // The floor applies to the MERGED snapshot, never to one tick's slice. Judging
  // a chunk by it would reject every healthy sweep tick, since a slice is
  // smaller than the floor by design.
  const mergedImporterCount = Object.keys(importers).length;
  if (failures.length === 0 && mergedImporterCount < minimumCompleteImporterCount) {
    throw new Error(
      `SIPRI snapshot holds only ${mergedImporterCount} positive importer rows; `
      + `minimum is ${minimumCompleteImporterCount}`,
    );
  }

  // 'ok' is what writes the completion marker, and the marker is what stops the
  // section being due. It must therefore mean "the sweep finished", not "this
  // tick finished" -- otherwise the first chunk would mark the whole refresh
  // complete and the remaining ~144 importers would never be revisited.
  const sweepComplete = sweep ? sweep.unfetched === 0 : true;
  const status = failures.length === 0 && sweepComplete ? 'ok' : 'partial';

  return {
    importers,
    stage: {
      status,
      importerCount: fetchedImporterCount,
      failedImporterCount: failures.length,
      preservedImporterCount: Math.max(0, preservedImporterCount),
      windowEndYear: Number(result?.windowEndYear) || 0,
      ...(sweep
        ? {
          sweep: {
            catalogCount: sweep.catalogCount,
            refreshedThisTick: fetchedImporterCount,
            remaining: sweep.unfetched,
            complete: sweepComplete,
          },
        }
        : {}),
    },
    fetchedAt,
  };
}

export function buildArmsSupplierCompletion(data) {
  return data?.stage?.status === 'ok'
    ? { completedAt: data.fetchedAt, windowEndYear: data.stage.windowEndYear }
    : {};
}
