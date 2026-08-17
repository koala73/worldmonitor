#!/usr/bin/env node

import { createRequire } from 'node:module';

import {
  loadEnvFile,
  CHROME_UA,
  getRedisCredentials,
  acquireLockSafely,
  releaseLock,
  extendExistingTtl,
  logSeedResult,
  withRetry,
  readSeedSnapshot,
  readExistingSeedMeta,
} from './_seed-utils.mjs';
import {
  MAX_JODI_CONTENT_AGE_MIN,
  assessChinaJodiCoverage,
  buildChinaRowDiagnostic,
  hasFiniteMeasurementAtPaths,
  jodiDatasetContentMeta,
} from './shared/jodi-content-age.mjs';
import {
  DEMAND_CHANGE_BASIS,
  DEMAND_CHANGE_UNIT,
  DEMAND_CHANGE_LOOKBACK_MONTHS,
  MAX_DEMAND_CHANGE_PERCENT,
  MIN_DEMAND_CHANGE_PRODUCTS,
  monthPeriodEnd,
  shiftMonth,
} from './shared/jodi-demand-change.mjs';

loadEnvFile(import.meta.url);
const require = createRequire(import.meta.url);
const JODI_MEASUREMENT_FIELDS = require('./shared/jodi-measurement-fields.json');

export const CANONICAL_KEY = 'energy:jodi-oil:v1:_countries';
export const COUNTRY_KEY_PREFIX = 'energy:jodi-oil:v1:';
export const JODI_TTL = 3_024_000; // 35 days
const META_KEY = 'seed-meta:energy:jodi-oil';
const LOCK_DOMAIN = 'energy:jodi-oil';
const LOCK_TTL_MS = 10 * 60 * 1000;
const MIN_VALID_COUNTRIES = 40;
const ANOMALY_DEMAND_KBD = 10_000;

const JODI_BASE = 'https://www.jodidata.org/_resources/files/downloads/oil-data/annual-csv/';

const SECONDARY_PRODUCTS = {
  GASOLINE: 'gasoline',
  GASDIES: 'diesel',
  JETKERO: 'jet',
  RESFUEL: 'fuelOil',
  LPG: 'lpg',
};

function splitCsvLine(line) {
  const fields = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { field += ch; }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(field.trim());
      field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field.trim());
  return fields;
}

export function parseCsv(text) {
  const lines = text.split('\n');
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = splitCsvLine(line);
    const row = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]] = parts[j] ?? '';
    }
    rows.push(row);
  }
  return rows;
}

export function parseObsValue(raw) {
  if (!raw || raw === '-' || raw === 'x' || raw.toLowerCase() === 'na') return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function rowsByMonth(allRows, iso2) {
  const rows = allRows.filter(r => r.REF_AREA === iso2 && r.UNIT_MEASURE === 'KBD');

  const byMonth = new Map();
  for (const r of rows) {
    const month = r.TIME_PERIOD;
    if (!month) continue;
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(r);
  }
  return byMonth;
}

function pickMonthValue(monthRows, iso2, product, flow, isAnomalyCapped) {
  const r = monthRows.find(row => row.ENERGY_PRODUCT === product && row.FLOW_BREAKDOWN === flow);
  if (!r) return null;
  const code = r.ASSESSMENT_CODE;
  if (code === '3') return null;
  const val = parseObsValue(r.OBS_VALUE);
  if (val === null) return null;
  if (isAnomalyCapped && iso2 !== 'US' && flow === 'TOTDEMO' && val > ANOMALY_DEMAND_KBD) return null;
  return val;
}

/** Total demand across every secondary product reporting a usable TOTDEMO. */
function monthProductDemand(monthRows, iso2) {
  const demand = new Map();
  for (const [productCode, productName] of Object.entries(SECONDARY_PRODUCTS)) {
    const value = pickMonthValue(monthRows, iso2, productCode, 'TOTDEMO', true);
    if (value !== null) demand.set(productName, value);
  }
  return demand;
}

/**
 * Observed year-over-year change in reported oil-product demand.
 *
 * Fails closed: the comparison month must be exactly twelve months earlier and
 * must report the identical product set, so a product appearing or vanishing
 * between vintages can never read as a demand move. Returns null whenever the
 * change is not observable — an absent change is never a zero.
 */
export function computeOilDemandChange(allRows, iso2, dataMonth) {
  return assessOilDemandChange(allRows, iso2, dataMonth).change;
}

/**
 * Explain a refused demand comparison for the operator log without changing
 * the public null-on-refusal data contract.
 */
export function assessOilDemandChange(allRows, iso2, dataMonth) {
  return oilDemandChangeFromMonths(rowsByMonth(allRows, iso2), iso2, dataMonth);
}

function refusedDemandChange(reason) {
  return { change: null, reason };
}

function oilDemandChangeFromMonths(byMonth, iso2, dataMonth) {
  const priorMonth = shiftMonth(dataMonth, -DEMAND_CHANGE_LOOKBACK_MONTHS);
  if (priorMonth === null) {
    return refusedDemandChange(`invalid comparison period ${dataMonth ?? 'missing'}`);
  }

  const current = monthProductDemand(byMonth.get(dataMonth) ?? [], iso2);
  const prior = monthProductDemand(byMonth.get(priorMonth) ?? [], iso2);
  if (current.size < MIN_DEMAND_CHANGE_PRODUCTS) {
    return refusedDemandChange(
      `current basket has ${current.size} comparable product(s); need >=${MIN_DEMAND_CHANGE_PRODUCTS}`,
    );
  }

  const products = [...current.keys()].sort();
  if (prior.size !== current.size || products.some(product => !prior.has(product))) {
    return refusedDemandChange(
      `current/prior comparable baskets differ (${products.length} vs ${prior.size} product(s))`,
    );
  }

  const currentDemandKbd = products.reduce((sum, product) => sum + current.get(product), 0);
  const priorDemandKbd = products.reduce((sum, product) => sum + prior.get(product), 0);
  if (!Number.isFinite(currentDemandKbd) || currentDemandKbd < 0 || !(priorDemandKbd > 0)) {
    return refusedDemandChange('current demand is non-finite/negative or prior demand is non-positive');
  }

  const percentChange = ((currentDemandKbd - priorDemandKbd) / priorDemandKbd) * 100;
  if (!Number.isFinite(percentChange)) {
    return refusedDemandChange('percentage change is non-finite');
  }
  if (Math.abs(percentChange) > MAX_DEMAND_CHANGE_PERCENT) {
    return refusedDemandChange(
      `absolute percentage change ${percentChange.toFixed(2)} exceeds ±${MAX_DEMAND_CHANGE_PERCENT}%`,
    );
  }

  const periodEnd = monthPeriodEnd(dataMonth);
  const priorPeriodEnd = monthPeriodEnd(priorMonth);
  if (periodEnd === null || priorPeriodEnd === null) {
    return refusedDemandChange(`invalid period end for ${dataMonth} or ${priorMonth}`);
  }

  return {
    reason: null,
    change: {
      basis: DEMAND_CHANGE_BASIS,
      observationPeriod: dataMonth,
      priorObservationPeriod: priorMonth,
      periodEnd,
      priorPeriodEnd,
      products,
      unit: DEMAND_CHANGE_UNIT,
      currentDemandKbd,
      priorDemandKbd,
      percentChange,
    },
  };
}

export function extractCountryData(allRows, iso2) {
  const byMonth = rowsByMonth(allRows, iso2);

  const sortedMonths = [...byMonth.keys()].sort((a, b) => b.localeCompare(a));

  let dataMonth = null;
  for (const month of sortedMonths) {
    const monthRows = byMonth.get(month);
    const hasValidCode = monthRows.some(r => r.ASSESSMENT_CODE === '1' || r.ASSESSMENT_CODE === '2');
    if (!hasValidCode) continue;
    // Require at least one valid secondary-product row so a failed secondary
    // download (crude-only month) never becomes the chosen dataMonth.
    const hasSecondaryData = monthRows.some(
      r => (r.ASSESSMENT_CODE === '1' || r.ASSESSMENT_CODE === '2') && r.ENERGY_PRODUCT in SECONDARY_PRODUCTS,
    );
    if (hasSecondaryData) {
      dataMonth = month;
      break;
    }
  }

  if (!dataMonth) return null;

  const monthRows = byMonth.get(dataMonth) || [];

  function pickVal(product, flow, isAnomalyCapped) {
    return pickMonthValue(monthRows, iso2, product, flow, isAnomalyCapped);
  }

  const seededAt = new Date().toISOString();

  const secondaryProducts = {};
  for (const [prodCode, prodName] of Object.entries(SECONDARY_PRODUCTS)) {
    secondaryProducts[prodName] = {
      demandKbd:    pickVal(prodCode, 'TOTDEMO',  true),
      refOutputKbd: pickVal(prodCode, 'REFGROUT', false),
      importsKbd:   pickVal(prodCode, 'TOTIMPSB', false),
      exportsKbd:   pickVal(prodCode, 'TOTEXPSB', false),
    };
  }

  let crudeProductionKbd = null;
  let crudeRefineryIntakeKbd = null;
  let crudeImportsKbd = null;
  let crudeExportsKbd = null;

  for (const prodCode of ['CRUDEOIL', 'TOTCRUDE']) {
    if (crudeProductionKbd === null) {
      crudeProductionKbd = pickVal(prodCode, 'INDPROD', false);
    }
    if (crudeRefineryIntakeKbd === null) {
      crudeRefineryIntakeKbd = pickVal(prodCode, 'REFINOBS', false);
    }
    if (crudeImportsKbd === null) {
      crudeImportsKbd = pickVal(prodCode, 'TOTIMPSB', false);
    }
    if (crudeExportsKbd === null) {
      crudeExportsKbd = pickVal(prodCode, 'TOTEXPSB', false);
    }
  }

  return {
    iso2,
    dataMonth,
    ...secondaryProducts,
    crude: {
      productionKbd:     crudeProductionKbd,
      refineryIntakeKbd: crudeRefineryIntakeKbd,
      importsKbd:        crudeImportsKbd,
      exportsKbd:        crudeExportsKbd,
    },
    demandChange: oilDemandChangeFromMonths(byMonth, iso2, dataMonth).change,
    seededAt,
  };
}

export function buildAllCountries(allRows) {
  const countries = new Set(allRows.filter(r => r.REF_AREA && r.UNIT_MEASURE === 'KBD').map(r => r.REF_AREA));
  const results = [];
  for (const iso2 of countries) {
    const data = extractCountryData(allRows, iso2);
    if (data) results.push(data);
  }
  return results;
}

export function validateCoverage(countries) {
  return countries.length >= MIN_VALID_COUNTRIES;
}

function hasOilMeasurements(record) {
  return hasFiniteMeasurementAtPaths(record, JODI_MEASUREMENT_FIELDS.oil);
}

export function assessChinaOilCoverage(countries, now = new Date()) {
  return assessChinaJodiCoverage(countries, now, hasOilMeasurements);
}

async function fetchCsv(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'text/csv,text/plain,*/*' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const err = new Error(`JODI CSV fetch failed: HTTP ${resp.status} for ${url}`);
    // A missing static file does not appear during a 2s backoff, and this
    // seeder now tries two naming conventions per year — retrying each 404
    // three times would spend ~12s of the bundle's wall-clock budget just to
    // rediscover that a year is not published under that name.
    if (resp.status === 404) err.nonRetryable = true;
    throw err;
  }
  return resp.text();
}

export function mergeSourceRows(
  primaryCurrent,
  primaryPrior,
  secondaryCurrent,
  secondaryPrior,
  secondaryLookback = '',
) {
  if (!secondaryCurrent && !secondaryPrior) {
    throw new Error('Both secondary JODI CSV files failed to download; product-level data unavailable');
  }
  const allRows = [
    ...(primaryCurrent ? parseCsv(primaryCurrent) : []),
    ...(primaryPrior ? parseCsv(primaryPrior) : []),
    ...(secondaryCurrent ? parseCsv(secondaryCurrent) : []),
    ...(secondaryPrior ? parseCsv(secondaryPrior) : []),
    ...(secondaryLookback ? parseCsv(secondaryLookback) : []),
  ];
  return allRows.filter(r => r.UNIT_MEASURE === 'KBD');
}

/**
 * Calendar years whose JODI files must be downloaded.
 *
 * Files are per calendar year and China's data month runs months behind, so
 * early in a year the newest usable month still sits in `priorYear` — whose
 * year-over-year comparison month lives one file further back. Without
 * `lookbackYear` the demand change is structurally unpublishable for months at
 * a time. Demand is a secondary-product measure, so only that file is needed.
 */
export function jodiSourceYears(now = new Date()) {
  const currentYear = now.getFullYear();
  return {
    currentYear,
    priorYear: currentYear - 1,
    lookbackYear: currentYear - 2,
  };
}

/**
 * Every published filename for one JODI year file, in the order to try them.
 *
 * JODI names each completed year `<kind>/<year>.csv` (2002 through 2025) but
 * publishes the year in progress as `<kind>/<kind>year<year>.csv`. Asking only
 * for the plain name meant the current year 404d for the whole of 2026 (#6799).
 * Plain name first: it is what every settled year uses, so a completed year
 * costs one request.
 */
export function jodiCsvCandidates(kind, year) {
  return [
    `${JODI_BASE}${kind}/${year}.csv`,
    `${JODI_BASE}${kind}/${kind}year${year}.csv`,
  ];
}

/**
 * Fetch one JODI year, trying each published naming convention in turn.
 *
 * Returns `{ ok, text, url, attempted, error }` rather than a bare string so a
 * caller can tell "this year is unreachable" from "this year is empty". That
 * distinction is the actual #6799 defect: the previous `.catch(() => '')`
 * collapsed both into an empty string, and an unreachable CURRENT year then
 * degraded silently to publishing the prior year as if it were current.
 */
export async function fetchYearCsv(kind, year, options = {}) {
  const fetcher = options.fetchCsv ?? fetchCsv;
  const retries = options.retries ?? 2;
  const attempted = jodiCsvCandidates(kind, year);
  let lastError = null;

  for (const url of attempted) {
    try {
      const text = await withRetry(() => fetcher(url), retries, 2000);
      return { ok: true, text, url, attempted, error: null };
    } catch (err) {
      lastError = err;
    }
  }
  return {
    ok: false,
    text: '',
    url: null,
    attempted,
    error: lastError?.message || String(lastError),
  };
}

async function fetchAllRows() {
  const { currentYear, priorYear, lookbackYear } = jodiSourceYears();

  const [primaryCurrent, primaryPrior, secondaryCurrent, secondaryPrior, secondaryLookback] =
    await Promise.all([
      fetchYearCsv('primary', currentYear),
      fetchYearCsv('primary', priorYear),
      fetchYearCsv('secondary', currentYear),
      fetchYearCsv('secondary', priorYear),
      // Optional: its absence only withholds the demand change, never the seed.
      fetchYearCsv('secondary', lookbackYear),
    ]);

  for (const [label, result] of [
    [`primary/${currentYear}`, primaryCurrent],
    [`primary/${priorYear}`, primaryPrior],
    [`secondary/${currentYear}`, secondaryCurrent],
    [`secondary/${priorYear}`, secondaryPrior],
    [`secondary/${lookbackYear}`, secondaryLookback],
  ]) {
    if (!result.ok) console.warn(`  ${label} unavailable (tried ${result.attempted.length} names): ${result.error}`);
  }

  // Losing BOTH current-year files is not a soft degrade — every month the
  // snapshot can still date itself from is last year's, so the publish silently
  // becomes a re-run of a stale vintage. Say so loudly: this is what went
  // unnoticed from January to August 2026.
  if (!primaryCurrent.ok && !secondaryCurrent.ok) {
    console.error(
      `  [jodi-oil] CURRENT_YEAR_UNAVAILABLE ${currentYear}: no primary or secondary file resolved `
      + `under any known naming convention. Publishing from ${priorYear} only — the snapshot cannot `
      + 'advance past that year until this is fixed. Check whether JODI renamed the download again.',
    );
  }

  return mergeSourceRows(
    primaryCurrent.text,
    primaryPrior.text,
    secondaryCurrent.text,
    secondaryPrior.text,
    secondaryLookback.text,
  );
}

async function redisPipeline(commands) {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Redis pipeline failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
  return resp.json();
}

/**
 * The only condition that may withhold an oil publish: too few countries
 * carry a usable measurement to trust the file at all. A single country —
 * China included — is reported, never enforced (issue #6395).
 */
export function formatCoverageFailureReason({ countryCount }) {
  return `only ${countryCount} countries with usable measurements, need >=${MIN_VALID_COUNTRIES}`;
}

/**
 * Everything main() decides about a parsed snapshot, in one testable place:
 * whether it may publish, what China looks like, and the seed-meta record that
 * carries both to /api/health.
 *
 * @param {{ allRows: any[], previousMeta?: any, now?: Date }} input
 */
export function prepareOilPublish({ allRows, previousMeta = null, now = new Date() }) {
  const parsed = buildAllCountries(allRows);
  const chinaCoverage = assessChinaOilCoverage(parsed, now);

  // A country whose every field parsed to null is not coverage: it would count
  // toward MIN_VALID_COUNTRIES while serving no measurement to anyone. With no
  // single-country gate standing behind that floor any more (#6395), the floor
  // has to mean what it says, so only measurement-bearing countries are
  // published. It also stops a null-only month from overwriting a country's
  // last-good record — the key simply is not rewritten and ages out instead.
  const countries = parsed.filter(hasOilMeasurements);
  const refusalReason = validateCoverage(countries)
    ? null
    : formatCoverageFailureReason({ countryCount: countries.length });

  const contentMeta = jodiDatasetContentMeta(countries, hasOilMeasurements, now);
  return {
    parsedCount: parsed.length,
    countries,
    chinaCoverage,
    refusalReason,
    metaPayload: {
      fetchedAt: now.getTime(),
      recordCount: countries.length,
      chinaDataMonth: chinaCoverage.dataMonth,
      chinaRow: buildChinaRowDiagnostic(
        chinaCoverage,
        previousMeta?.chinaRow ?? null,
        now.getTime(),
      ),
      // Content-age trio: without it a JODI file that stopped advancing would
      // publish forever as fresh now that no per-country gate refuses it.
      newestItemAt: contentMeta?.newestItemAt ?? null,
      oldestItemAt: contentMeta?.oldestItemAt ?? null,
      maxContentAgeMin: MAX_JODI_CONTENT_AGE_MIN,
    },
  };
}

async function main() {
  const startedAt = Date.now();
  const runId = `jodi-oil:${startedAt}`;

  console.log('=== energy:jodi-oil Seed ===');
  console.log(`  Run ID: ${runId}`);
  console.log(`  Key prefix: ${COUNTRY_KEY_PREFIX}`);

  const lock = await acquireLockSafely(LOCK_DOMAIN, runId, LOCK_TTL_MS, { label: LOCK_DOMAIN });
  if (lock.skipped) return;
  if (!lock.locked) {
    console.log('  SKIPPED: another seed run in progress');
    return;
  }

  try {
    console.log('  Fetching JODI CSV data (5 files)...');
    const allRows = await withRetry(fetchAllRows, 2, 3000);

    if (!allRows.length) {
      throw new Error('No KBD rows parsed from JODI CSV files');
    }

    console.log(`  Parsed ${allRows.length} KBD rows`);

    const previousMeta = await readExistingSeedMeta('energy', 'jodi-oil');
    if (previousMeta?.chinaRow == null) {
      // readExistingSeedMeta collapses "no prior record" and "read failed" into
      // one null, so an ongoing gap re-dates to this run. Say so, or the reset
      // is indistinguishable from a genuine new outage in the log.
      console.warn('  China oil row: no previous record readable — dating any gap from this run');
    }
    const { countries, parsedCount, chinaCoverage, refusalReason, metaPayload } = prepareOilPublish({
      allRows,
      previousMeta,
    });
    console.log(`  Built ${countries.length} country payloads of ${parsedCount} parsed`);

    if (refusalReason) {
      console.error(`  COVERAGE GATE FAILED: ${refusalReason}`);
      const prevIso2List = await readSeedSnapshot(CANONICAL_KEY, { strict: true });
      if (Array.isArray(prevIso2List) && prevIso2List.length > 0) {
        const prevCountryKeys = prevIso2List.map(iso2 => `${COUNTRY_KEY_PREFIX}${iso2}`);
        const preserved = await extendExistingTtl(
          [CANONICAL_KEY, META_KEY, ...prevCountryKeys],
          JODI_TTL,
        );
        if (!preserved) {
          throw new Error('Coverage gate could not verify preservation of the last-good snapshot');
        }
      } else {
        console.warn('  COVERAGE GATE: no last-good snapshot exists to preserve');
      }
      return;
    }

    console.log(chinaCoverage.ok
      ? `  China oil coverage: ok (dataMonth=${chinaCoverage.dataMonth})`
      : `  China oil coverage: ${chinaCoverage.reason} (dataMonth=${chinaCoverage.dataMonth ?? 'missing'})`
        + ` — publishing the other ${countries.length} countries anyway`);

    // Every guard in this chain refuses by returning null, so a refused change
    // is otherwise indistinguishable from an upstream that simply has not
    // published one. Say which it is, once, for the only country the activity
    // nowcast consumes.
    const china = countries.find(c => c.iso2 === 'CN');
    const chinaDemandAssessment = china?.demandChange
      ? { change: china.demandChange, reason: null }
      : assessOilDemandChange(allRows, 'CN', chinaCoverage.dataMonth);
    console.log(chinaDemandAssessment.change
      ? `  China demand change: ${chinaDemandAssessment.change.percentChange.toFixed(2)}% `
        + `${chinaDemandAssessment.change.observationPeriod} vs ${chinaDemandAssessment.change.priorObservationPeriod} `
        + `(${chinaDemandAssessment.change.products.length} products)`
      : `  China demand change: not published for dataMonth=${chinaCoverage.dataMonth ?? 'missing'} `
        + `(${chinaDemandAssessment.reason ?? 'no comparable basket'})`);

    const iso2List = countries.map(c => c.iso2);

    const commands = [];
    for (const payload of countries) {
      commands.push(['SET', `${COUNTRY_KEY_PREFIX}${payload.iso2}`, JSON.stringify(payload), 'EX', JODI_TTL]);
    }
    commands.push(['SET', CANONICAL_KEY, JSON.stringify(iso2List), 'EX', JODI_TTL]);
    commands.push(['SET', META_KEY, JSON.stringify(metaPayload), 'EX', JODI_TTL]);

    const results = await redisPipeline(commands);
    const failures = results.filter(r => r?.error || r?.result === 'ERR');
    if (failures.length > 0) {
      throw new Error(`Redis pipeline: ${failures.length}/${commands.length} commands failed`);
    }

    logSeedResult('energy', countries.length, Date.now() - startedAt, { source: 'jodi-oil' });
    console.log(`  Seeded ${countries.length} countries`);
    console.log(`\n=== Done (${Date.now() - startedAt}ms) ===`);
  } catch (err) {
    console.error(`  SEED FAILED: ${err.message}`);
    const prevIso2List = await readSeedSnapshot(CANONICAL_KEY).catch(() => null);
    const prevCountryKeys = Array.isArray(prevIso2List)
      ? prevIso2List.map(iso2 => `${COUNTRY_KEY_PREFIX}${iso2}`)
      : [];
    await extendExistingTtl([CANONICAL_KEY, META_KEY, ...prevCountryKeys], JODI_TTL).catch(() => {});
    throw err;
  } finally {
    await releaseLock(LOCK_DOMAIN, runId);
  }
}

const isMain = process.argv[1]?.endsWith('seed-jodi-oil.mjs');
if (isMain) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
