#!/usr/bin/env node

import { createRequire } from 'node:module';

import {
  loadEnvFile,
  PUBLISH_BLOCKED_EXIT_CODE,
  CHROME_UA,
  getRedisCredentials,
  acquireLockSafely,
  releaseLock,
  extendExistingTtl,
  logSeedResult,
  withRetry,
  readSeedSnapshot,
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
import { CURRENT_FLOWS_WINDOW, PRE_CRISIS_WINDOW } from './shared/hormuz-crisis.js';

loadEnvFile(import.meta.url);
const require = createRequire(import.meta.url);
const JODI_MEASUREMENT_FIELDS = require('./shared/jodi-measurement-fields.json');

export const CANONICAL_KEY = 'energy:jodi-oil:v1:_countries';
export const COUNTRY_KEY_PREFIX = 'energy:jodi-oil:v1:';
export const JODI_TTL = 70 * 24 * 3600; // 70 days: one missed monthly publish still serves last-good through the 40d STALE_SEED window (#7273)
// Bump when the country payload changes shape: the energy-sources bundle
// reseeds on the first tick after a deploy whose seed-meta lacks this version.
export const JODI_OIL_SOURCE_VERSION = 'jodi-oil-v2';
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

// Published per country like the others, but kept out of SECONDARY_PRODUCTS:
// that map is also the demand-change basket and the dataMonth test, which
// downstream nowcasts pin to five products. Naphtha is 9-30% of refinery
// output in JP, KR and TW and their largest product import.
const YIELD_ONLY_PRODUCTS = {
  NAPHTHA: 'naphtha',
};

const PUBLISHED_PRODUCTS = { ...SECONDARY_PRODUCTS, ...YIELD_ONLY_PRODUCTS };

// Refinery yields are summed over a trailing window so a single noisy month
// (Spain jet 1.1% in 2026-07) cannot set a country's yield.
export const REFINERY_YIELD_WINDOW_MONTHS = 12;
export const REFINERY_YIELD_MIN_MONTHS = 6;
// JODI publishes China's crude refinery intake as the balance of its supply:
// production + imports - exports - intake closes to within 0.2 kb/d in every
// month, so it is not an observed intake. A month is "balanced" when the
// residual is within the larger of 1 kb/d and 0.1% of intake; no other JODI
// reporter balances in more than 5 of 12 months.
const BALANCE_TOLERANCE_KBD = 1;
const BALANCE_TOLERANCE_SHARE = 0.001;
const BALANCING_MONTH_SHARE = 0.75;
// Gross refinery output also counts NGL and other feedstocks, so output per
// barrel of crude intake runs 1.0-1.35 for most refiners. Outside this band
// (Canada 2.24, Lithuania 0.50) the reported crude intake does not describe
// the output it is meant to feed.
const PLAUSIBLE_OUTPUT_PER_INTAKE = [0.75, 1.5];

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

/** Rows of a JODI CSV; with `keep`, only the rows it accepts are kept. */
export function parseCsv(text, keep = null) {
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
    if (!keep || keep(row)) rows.push(row);
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
  // ASSESSMENT_CODE 3 means JODI has not assessed the value, not that it is
  // missing: Saudi Arabia, Kazakhstan, Nigeria and Venezuela publish their
  // crude exports under it. Absence is a non-numeric cell ('-', '..', 'x').
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

function crudeIntakeObservation(monthRows, iso2) {
  // Same CRUDEOIL-then-TOTCRUDE preference as the published crude block, with
  // every flow of the balance read from the product whose intake was used.
  for (const product of ['CRUDEOIL', 'TOTCRUDE']) {
    const intake = pickMonthValue(monthRows, iso2, product, 'REFINOBS', false);
    if (intake === null) continue;
    return {
      intake,
      production: pickMonthValue(monthRows, iso2, product, 'INDPROD', false),
      imports: pickMonthValue(monthRows, iso2, product, 'TOTIMPSB', false),
      exports: pickMonthValue(monthRows, iso2, product, 'TOTEXPSB', false),
    };
  }
  return null;
}

const roundYield = (value) => Math.round(value * 10_000) / 10_000;

/**
 * Product refinery output per barrel of refinery intake, summed over the
 * trailing REFINERY_YIELD_WINDOW_MONTHS ending at dataMonth.
 *
 * The denominator is crude refinery intake unless it is not credible: reported
 * in fewer than REFINERY_YIELD_MIN_MONTHS months, a balancing item (China), or
 * implausible against total output. Then total refinery output (TOTPRODS) is
 * used, which makes each yield a share of output. A product needs
 * REFINERY_YIELD_MIN_MONTHS months with both its output and the denominator,
 * else its yield is null (the reader then says it is not measured). Returns
 * null when neither denominator is usable.
 */
export function computeRefineryYields(byMonth, iso2, dataMonth) {
  const startMonth = shiftMonth(dataMonth, -(REFINERY_YIELD_WINDOW_MONTHS - 1));
  if (startMonth === null) return null;
  const window = [];
  for (let offset = REFINERY_YIELD_WINDOW_MONTHS - 1; offset >= 0; offset--) {
    const month = shiftMonth(dataMonth, -offset);
    const monthRows = byMonth.get(month) ?? [];
    const crude = crudeIntakeObservation(monthRows, iso2);
    const totalOutput = pickMonthValue(monthRows, iso2, 'TOTPRODS', 'REFGROUT', false);
    window.push({
      monthRows,
      intake: crude && crude.intake > 0 ? crude : null,
      totalOutput: totalOutput !== null && totalOutput > 0 ? totalOutput : null,
    });
  }

  const intakeMonths = window.filter((m) => m.intake);
  const balanceMonths = intakeMonths.filter((m) => m.intake.production !== null && m.intake.imports !== null && m.intake.exports !== null);
  const balancedCount = balanceMonths.filter(({ intake: c }) => {
    const residual = c.production + c.imports - c.exports - c.intake;
    return Math.abs(residual) <= Math.max(BALANCE_TOLERANCE_KBD, c.intake * BALANCE_TOLERANCE_SHARE);
  }).length;
  const paired = intakeMonths.filter((m) => m.totalOutput !== null);
  // Too few paired months cannot reject the intake: the total-output basis
  // would then be too short to publish, and every yield would fall back.
  const outputPerIntake = paired.length >= REFINERY_YIELD_MIN_MONTHS
    ? paired.reduce((s, m) => s + m.totalOutput, 0) / paired.reduce((s, m) => s + m.intake.intake, 0)
    : null;

  let intakeIssue = null;
  if (intakeMonths.length < REFINERY_YIELD_MIN_MONTHS) intakeIssue = 'unreported';
  else if (balanceMonths.length >= REFINERY_YIELD_MIN_MONTHS && balancedCount >= balanceMonths.length * BALANCING_MONTH_SHARE) intakeIssue = 'balancing_item';
  else if (outputPerIntake !== null && (outputPerIntake < PLAUSIBLE_OUTPUT_PER_INTAKE[0] || outputPerIntake > PLAUSIBLE_OUTPUT_PER_INTAKE[1])) intakeIssue = 'implausible_output_ratio';

  const basis = intakeIssue === null ? 'crude_refinery_intake' : 'total_refinery_output';
  const denominator = (m) => (basis === 'crude_refinery_intake' ? m.intake?.intake ?? null : m.totalOutput);
  const months = window.filter((m) => denominator(m) !== null).length;
  if (months < REFINERY_YIELD_MIN_MONTHS) return null;

  const products = {};
  for (const [productCode, productName] of Object.entries(PUBLISHED_PRODUCTS)) {
    let output = 0;
    let input = 0;
    let count = 0;
    for (const m of window) {
      const d = denominator(m);
      const out = pickMonthValue(m.monthRows, iso2, productCode, 'REFGROUT', false);
      if (d === null || out === null || out < 0) continue;
      output += out;
      input += d;
      count++;
    }
    const value = count >= REFINERY_YIELD_MIN_MONTHS ? output / input : null;
    products[productName] = value !== null && value <= 1 ? roundYield(value) : null;
  }

  return { basis, intakeIssue, startMonth, endMonth: dataMonth, months, products };
}

const TRADE_FLOWS = { demandKbd: 'TOTDEMO', importsKbd: 'TOTIMPSB', exportsKbd: 'TOTEXPSB' };

/**
 * Per-product demand, imports and exports averaged over one window of months.
 * A month without a numeric cell is absent, never zero. A flow needs at least
 * half the window's months (rounded down, minimum one), else it is null.
 * Returns null when no month in the window carries any product flow.
 */
function productTradeWindow(byMonth, iso2, months) {
  const minMonths = Math.max(1, Math.floor(months.length / 2));
  const monthRows = months.map((month) => byMonth.get(month) ?? []);
  const covered = monthRows.filter((rows) => Object.keys(PUBLISHED_PRODUCTS).some((productCode) =>
    Object.values(TRADE_FLOWS).some((flow) => pickMonthValue(rows, iso2, productCode, flow, true) !== null))).length;
  if (covered === 0) return null;
  const products = {};
  for (const [productCode, productName] of Object.entries(PUBLISHED_PRODUCTS)) {
    products[productName] = {};
    for (const [field, flow] of Object.entries(TRADE_FLOWS)) {
      const values = monthRows.map((rows) => pickMonthValue(rows, iso2, productCode, flow, true)).filter((v) => v !== null);
      products[productName][field] = values.length >= minMonths
        ? Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10
        : null;
    }
  }
  return { startMonth: months[0], endMonth: months[months.length - 1], months: covered, products };
}

/**
 * Product trade for the shock model's two baselines (shared/hormuz-crisis.js):
 * the pre-crisis months, and current flows = the latest CURRENT_FLOWS_WINDOW
 * months ending at dataMonth, none before its earliest month.
 */
export function computeProductTrade(byMonth, iso2, dataMonth) {
  const preMonths = [];
  for (let m = PRE_CRISIS_WINDOW.startMonth; m <= PRE_CRISIS_WINDOW.endMonth; m = shiftMonth(m, 1)) preMonths.push(m);
  const currentMonths = [];
  for (let offset = CURRENT_FLOWS_WINDOW.months - 1; offset >= 0; offset--) {
    const month = shiftMonth(dataMonth, -offset);
    if (month !== null && month >= CURRENT_FLOWS_WINDOW.earliestMonth) currentMonths.push(month);
  }
  return {
    preCrisisBaseline: productTradeWindow(byMonth, iso2, preMonths),
    currentFlows: currentMonths.length > 0 ? productTradeWindow(byMonth, iso2, currentMonths) : null,
  };
}

// Month-end closing stocks are filed in thousand barrels, not kb/d.
const STOCK_FLOW = 'CLOSTLV';
const STOCK_UNIT = 'KBBL';
const isStockRow = (r) => r.FLOW_BREAKDOWN === STOCK_FLOW && r.UNIT_MEASURE === STOCK_UNIT;

/**
 * Latest month in which the country reported both crude and total-product
 * closing stocks, in million barrels. Crude and products together are the
 * scope IEA days of cover count; one without the other understates it, so a
 * month needs both. Null when no month does.
 */
export function extractClosingStocks(allRows, iso2) {
  const byMonth = new Map();
  for (const r of allRows) {
    if (r.REF_AREA !== iso2 || !r.TIME_PERIOD || !isStockRow(r)) continue;
    const val = parseObsValue(r.OBS_VALUE);
    if (val === null || val < 0) continue;
    if (!byMonth.has(r.TIME_PERIOD)) byMonth.set(r.TIME_PERIOD, {});
    byMonth.get(r.TIME_PERIOD)[r.ENERGY_PRODUCT] = val;
  }
  for (const month of [...byMonth.keys()].sort((a, b) => b.localeCompare(a))) {
    const m = byMonth.get(month);
    // A zero TOTCRUDE barrel stock is a placeholder: India files KBBL 0 beside
    // 6,086 kt in the same row set.
    const crude = m.CRUDEOIL ?? (m.TOTCRUDE > 0 ? m.TOTCRUDE : null);
    const products = m.TOTPRODS ?? null;
    if (crude === null || products === null || crude + products <= 0) continue;
    return { month, crudeMb: crude / 1000, productsMb: products / 1000 };
  }
  return null;
}

// IEA counts days of cover against the previous calendar year's average net
// imports of all oil: crude with NGL and feedstocks (TOTCRUDE), and products.
const NET_IMPORTS_MIN_MONTHS = 9;

const daysIn = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * Average net oil imports, kb/d, over one calendar year: crude (TOTCRUDE,
 * else CRUDEOIL) plus total products, imports less exports, each month's
 * rate weighted by its days. A month counts only when all four figures are
 * reported. Null with fewer than NET_IMPORTS_MIN_MONTHS such months or a
 * net-exporting year.
 */
export function computeNetOilImports(byMonth, iso2, year) {
  let barrels = 0;
  let days = 0;
  let months = 0;
  for (let m = 1; m <= 12; m++) {
    const monthRows = byMonth.get(`${year}-${String(m).padStart(2, '0')}`);
    if (!monthRows) continue;
    const pick = (product, flow) => pickMonthValue(monthRows, iso2, product, flow, false);
    const crudeCode = pick('TOTCRUDE', 'TOTIMPSB') !== null ? 'TOTCRUDE' : 'CRUDEOIL';
    const values = [pick(crudeCode, 'TOTIMPSB'), pick(crudeCode, 'TOTEXPSB'), pick('TOTPRODS', 'TOTIMPSB'), pick('TOTPRODS', 'TOTEXPSB')];
    if (values.some((v) => v === null)) continue;
    const [crudeImp, crudeExp, prodImp, prodExp] = values;
    barrels += (crudeImp - crudeExp + prodImp - prodExp) * daysIn(year, m);
    days += daysIn(year, m);
    months++;
  }
  if (months < NET_IMPORTS_MIN_MONTHS) return null;
  const kbd = Math.round((barrels / days) * 10) / 10;
  return kbd > 0 ? { year, kbd, months } : null;
}

/**
 * Net oil imports for every calendar year up to `dataMonth`'s in the files,
 * newest first; computeNetOilImports drops a year with fewer than 9 complete
 * months. IEA's own data month decides which year its days count against, and
 * it can lag or lead JODI's across a new year, so the reader picks.
 */
export function netOilImportsByYear(byMonth, iso2, dataMonth) {
  const dataYear = Number(String(dataMonth).slice(0, 4));
  const years = [...new Set([...byMonth.keys()].map((m) => Number(m.slice(0, 4))))]
    .filter((y) => Number.isInteger(y) && y <= dataYear)
    .sort((a, b) => b - a);
  return years.map((y) => computeNetOilImports(byMonth, iso2, y)).filter(Boolean);
}

export function extractCountryData(allRows, iso2) {
  const byMonth = rowsByMonth(allRows, iso2);

  const sortedMonths = [...byMonth.keys()].sort((a, b) => b.localeCompare(a));

  let dataMonth = null;
  for (const month of sortedMonths) {
    const monthRows = byMonth.get(month);
    // A month counts only if it carries a number. Every JODI cell has an
    // assessment code, including the '-' placeholders a non-reporting country
    // (the UAE since 2019) files, so the code says nothing about presence.
    // Require a usable secondary-product value so a failed secondary download
    // (crude-only month) never becomes the chosen dataMonth.
    const hasSecondaryData = monthRows.some(
      r => r.ENERGY_PRODUCT in SECONDARY_PRODUCTS && parseObsValue(r.OBS_VALUE) !== null,
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
  for (const [prodCode, prodName] of Object.entries(PUBLISHED_PRODUCTS)) {
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
    refineryYields: computeRefineryYields(byMonth, iso2, dataMonth),
    productTrade: computeProductTrade(byMonth, iso2, dataMonth),
    demandChange: oilDemandChangeFromMonths(byMonth, iso2, dataMonth).change,
    stocks: extractClosingStocks(allRows, iso2),
    netOilImports: netOilImportsByYear(byMonth, iso2, dataMonth),
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

// The year files are 7-26 MB and jodidata.org serves about 1 MB/s per
// connection, so a whole-request timeout cuts healthy downloads (30 s did,
// for every 2026 file, on 2026-10-29). Abort when bytes stop arriving, or
// past a budget that leaves the bundle section (600 s) room for one retry.
const JODI_STALL_MS = 30_000;
const JODI_DOWNLOAD_BUDGET_MS = 180_000;

export async function fetchCsv(url, {
  fetchImpl = (...args) => globalThis.fetch(...args),
  stallMs = JODI_STALL_MS,
  budgetMs = JODI_DOWNLOAD_BUDGET_MS,
} = {}) {
  const controller = new AbortController();
  const budget = setTimeout(() => {
    const err = new Error(`JODI CSV download exceeded ${budgetMs / 1000}s for ${url}`);
    // A steady but slow transfer will not finish faster on a retry.
    err.nonRetryable = true;
    controller.abort(err);
  }, budgetMs);
  let stall = null;
  const armStall = () => {
    clearTimeout(stall);
    stall = setTimeout(() => controller.abort(new Error(`JODI CSV download stalled ${stallMs / 1000}s for ${url}`)), stallMs);
  };
  try {
    armStall();
    const resp = await fetchImpl(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'text/csv,text/plain,*/*' },
      signal: controller.signal,
    });
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => {});
      const err = new Error(`JODI CSV fetch failed: HTTP ${resp.status} for ${url}`);
      // A missing static file does not appear during a 2s backoff, and this
      // seeder now tries two naming conventions per year — retrying each 404
      // three times would spend ~12s of the bundle's wall-clock budget just to
      // rediscover that a year is not published under that name.
      if (resp.status === 404) err.nonRetryable = true;
      throw err;
    }
    const chunks = [];
    for await (const chunk of resp.body ?? []) {
      armStall();
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch (err) {
    throw controller.signal.aborted ? controller.signal.reason : err;
  } finally {
    clearTimeout(budget);
    clearTimeout(stall);
  }
}

export function mergeSourceRows(
  primaryCurrent,
  primaryPrior,
  secondaryCurrent,
  secondaryPrior,
  secondaryLookback = '',
  primaryLookback = '',
) {
  if (!secondaryCurrent && !secondaryPrior) {
    throw new Error('Both secondary JODI CSV files failed to download; product-level data unavailable');
  }
  // Flows are kb/d; closing stocks are the one KBBL measure kept. Filtering
  // while parsing keeps ~1 row in 5: building all six files' rows first held
  // ~640 MB of heap, past the bundle's 1 GB container with its other costs.
  const keep = r => r.UNIT_MEASURE === 'KBD' || isStockRow(r);
  return [primaryCurrent, primaryPrior, secondaryCurrent, secondaryPrior, secondaryLookback, primaryLookback]
    .flatMap(text => (text ? parseCsv(text, keep) : []));
}

/**
 * Calendar years whose JODI files must be downloaded.
 *
 * Files are per calendar year and China's data month runs months behind, so
 * early in a year the newest usable month still sits in `priorYear` — whose
 * year-over-year comparison month lives one file further back. Without
 * `lookbackYear` the demand change is structurally unpublishable for months at
 * a time. Its primary (crude) file serves net oil imports: IEA days of cover
 * count against the previous calendar year, which early in a year is
 * `lookbackYear`.
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

  const [primaryCurrent, primaryPrior, secondaryCurrent, secondaryPrior, secondaryLookback, primaryLookback] =
    await Promise.all([
      fetchYearCsv('primary', currentYear),
      fetchYearCsv('primary', priorYear),
      fetchYearCsv('secondary', currentYear),
      fetchYearCsv('secondary', priorYear),
      // Optional: its absence only withholds the demand change, never the seed.
      fetchYearCsv('secondary', lookbackYear),
      // Optional: its absence only withholds net oil imports for that year.
      fetchYearCsv('primary', lookbackYear),
    ]);

  for (const [label, result] of [
    [`primary/${currentYear}`, primaryCurrent],
    [`primary/${priorYear}`, primaryPrior],
    [`secondary/${currentYear}`, secondaryCurrent],
    [`secondary/${priorYear}`, secondaryPrior],
    [`secondary/${lookbackYear}`, secondaryLookback],
    [`primary/${lookbackYear}`, primaryLookback],
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
    primaryLookback.text,
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
 * JODI files only grow, so a run whose newest month is older than the one
 * already published lost its current-year files. On 2026-10-29 every 2026
 * download timed out and the run replaced an August 2026 snapshot with
 * December 2025, which emptied every country's crude imports. Refuse, so the
 * coverage-gate path keeps the last-good snapshot.
 */
function formatVintageRegressionReason(newestItemAt, publishedNewestItemAt) {
  if (!Number.isFinite(newestItemAt) || !Number.isFinite(publishedNewestItemAt)) return null;
  if (newestItemAt >= publishedNewestItemAt) return null;
  const month = (ms) => new Date(ms).toISOString().slice(0, 7);
  return `newest month ${month(newestItemAt)} is older than the published ${month(publishedNewestItemAt)}`;
}

/**
 * The published seed-meta, read strictly. The vintage check above treats a
 * missing record as a first publish, so a failed read must not look like one:
 * after two retries it throws, and main() stops before writing anything.
 */
export function readPreviousOilMeta(read = readSeedSnapshot) {
  return withRetry(() => read(META_KEY, { strict: true }), 2, 1000);
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
  const contentMeta = jodiDatasetContentMeta(countries, hasOilMeasurements, now);
  const refusalReason = validateCoverage(countries)
    ? formatVintageRegressionReason(contentMeta?.newestItemAt, previousMeta?.newestItemAt)
    : formatCoverageFailureReason({ countryCount: countries.length });
  return {
    parsedCount: parsed.length,
    countries,
    chinaCoverage,
    refusalReason,
    metaPayload: {
      fetchedAt: now.getTime(),
      recordCount: countries.length,
      sourceVersion: JODI_OIL_SOURCE_VERSION,
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

    const previousMeta = await readPreviousOilMeta();
    if (previousMeta?.chinaRow == null) {
      // A missing record (or one written before chinaRow existed) re-dates an
      // ongoing gap to this run. Say so, or the reset is indistinguishable from
      // a genuine new outage in the log.
      console.warn('  China oil row: no previous record — dating any gap from this run');
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
      // #6396: the gate refused to publish, so exit 0 would make the bundle
      // report OK for a section whose seed keys were not written. Signal the
      // dedicated outcome; main()'s finally still releases the lock on this
      // return path.
      return { publishBlocked: true };
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
  main().then((outcome) => {
    if (outcome?.publishBlocked) process.exit(PUBLISH_BLOCKED_EXIT_CODE);
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
