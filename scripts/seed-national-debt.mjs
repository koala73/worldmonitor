#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, imfSdmxFetchIndicator } from './_seed-utils.mjs';
import weoFiscalPeriods from './shared/weo-fiscal-periods.mjs';

loadEnvFile(import.meta.url);

const TREASURY_URL = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny?fields=record_date,tot_pub_debt_out_amt&sort=-record_date&page[size]=1';

const CANONICAL_KEY = 'economic:national-debt:v1';
// 65 days — must exceed health.js SEED_META.nationalDebt.maxStaleMin (60d) so
// a missed monthly cron keeps the canonical payload readable through the
// STALE_SEED warn window instead of vanishing into EMPTY crit at day 35.
// writeFreshnessMetadata() uses max(7d, ttlSeconds) → meta TTL tracks this.
const CACHE_TTL = 65 * 24 * 3600;

// IMF WEO regional aggregate codes (not real sovereign countries)
const AGGREGATE_CODES = new Set([
  'ADVEC', 'EMEDE', 'EURO', 'MECA', 'OEMDC', 'WEOWORLD', 'EU',
  'AS5', 'DA', 'EDE', 'MAE', 'OAE', 'SSA', 'WE', 'EMDE', 'G20',
]);

// Overseas territories / non-sovereign entities to exclude
const TERRITORY_CODES = new Set(['ABW', 'PRI', 'WBG']);

function isAggregate(code) {
  if (!code || code.length !== 3) return true;
  return AGGREGATE_CODES.has(code) || TERRITORY_CODES.has(code) || code.endsWith('Q');
}

export async function fetchTreasury() {
  const resp = await fetch(TREASURY_URL, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Treasury API: HTTP ${resp.status}`);
  const data = await resp.json();
  const record = data?.data?.[0];
  if (!record) return null;
  return {
    date: record.record_date,
    debtUsd: Number(record.tot_pub_debt_out_amt),
  };
}

// Latest year with a positive value, capped at maxYear. The cap keeps next
// year's WEO forecast (fetched by weoYearWindow) from replacing the current
// year, which is the figure IMF DataMapper ranks.
function latestYearWithValue(byYear, maxYear) {
  if (!byYear) return null;
  let best = null;
  for (const [yearStr, value] of Object.entries(byYear)) {
    const y = Number(yearStr);
    const v = Number(value);
    if (Number.isFinite(y) && y <= maxYear && Number.isFinite(v) && v > 0 && (best === null || y > best)) {
      best = y;
    }
  }
  return best;
}

export function computeEntries(debtPctByCountry, gdpByCountry, deficitPctByCountry, treasuryOverride, now = new Date()) {
  const SECONDS_PER_YEAR = 365.25 * 86400;
  const currentYear = now.getUTCFullYear();

  const entries = [];

  for (const [iso3, debtByYear] of Object.entries(debtPctByCountry)) {
    if (isAggregate(iso3)) continue;

    const gdpByYear = gdpByCountry[iso3];
    if (!gdpByYear) continue;

    // Only years with GDP too, so debt % is never multiplied by another year's GDP.
    const debtWithGdp = Object.fromEntries(
      Object.entries(debtByYear || {}).filter(([year]) => Number(gdpByYear[year]) > 0),
    );
    const latestDebtYear = latestYearWithValue(debtWithGdp, currentYear);
    if (latestDebtYear === null) continue;
    const weoLabel = `IMF WEO ${latestDebtYear}`;
    const gdpLatest = Number(gdpByYear[String(latestDebtYear)]);

    const effectiveDebtPct = Number(debtByYear[String(latestDebtYear)]);
    const prevYear = String(latestDebtYear - 1);
    const prevDebtPct = Number(debtByYear[prevYear]);
    const hasPrev = Number.isFinite(prevDebtPct) && prevDebtPct > 0;

    const gdpUsd = gdpLatest;
    let debtUsd = (effectiveDebtPct / 100) * gdpUsd;
    // Debt already includes the period's deficit. Anchor at the UTC boundary
    // after its last day, just as calendar-year stocks use January 1.
    const fiscalPeriod = weoFiscalPeriods.countries[iso3];
    let baselineTs = fiscalPeriod
      ? Date.UTC(
        latestDebtYear + (fiscalPeriod.yearLabel === 'start' ? 1 : 0),
        fiscalPeriod.endMonth - 1,
        fiscalPeriod.endDay + 1,
      )
      : Date.UTC(latestDebtYear + 1, 0, 1);
    const periodEndTs = baselineTs;

    // Override USA with live Treasury data when available. That total is
    // already current as of its record date, so the ticker accrues from there.
    if (iso3 === 'USA' && treasuryOverride && treasuryOverride.debtUsd > 0) {
      debtUsd = treasuryOverride.debtUsd;
      const recordTs = Date.parse(treasuryOverride.date);
      if (Number.isFinite(recordTs) && recordTs <= now.getTime()) baselineTs = recordTs;
    }

    let annualGrowth = 0;
    if (hasPrev) {
      annualGrowth = ((effectiveDebtPct - prevDebtPct) / prevDebtPct) * 100;
    }

    const deficitByYear = deficitPctByCountry[iso3];
    // The clock accrues over the period after the anchored stock's period
    // end, so once that end has passed it runs on the next period's projected
    // deficit and GDP. Before then, or without both, it uses the stock's own
    // year; no deficit for that year means no accrual.
    const nextYear = String(latestDebtYear + 1);
    const nextDeficitPct = Number(deficitByYear?.[nextYear]);
    const nextGdpUsd = Number(gdpByYear[nextYear]);
    const useNextPeriod = now.getTime() >= periodEndTs && Number.isFinite(nextDeficitPct) && nextGdpUsd > 0;
    const deficitPct2024 = useNextPeriod
      ? nextDeficitPct
      : (deficitByYear ? Number(deficitByYear[String(latestDebtYear)]) : NaN);
    const accrualGdpUsd = useNextPeriod ? nextGdpUsd : gdpUsd;
    let perSecondRate = 0;
    let perDayRate = 0;
    // Only accrue when running a deficit (GGXCNL_NGDP < 0 = net borrower).
    // Surplus countries (Norway, Kuwait, Singapore, etc.) tick at 0 — not upward.
    if (Number.isFinite(deficitPct2024) && deficitPct2024 < 0) {
      const deficitAbs = (Math.abs(deficitPct2024) / 100) * accrualGdpUsd;
      perSecondRate = deficitAbs / SECONDS_PER_YEAR;
      perDayRate = deficitAbs / 365.25;
    }

    entries.push({
      iso3,
      debtUsd,
      gdpUsd,
      debtToGdp: effectiveDebtPct,
      annualGrowth,
      perSecondRate,
      perDayRate,
      baselineTs,
      source: iso3 === 'USA' && treasuryOverride ? `${weoLabel} + US Treasury FiscalData` : weoLabel,
    });
  }

  entries.sort((a, b) => b.debtUsd - a.debtUsd);
  return entries;
}

// Rolling 4-year window: two historical, current, one forward. WEO publishes
// the current-year vintage mid-year and forecasts forward — this keeps the
// seed picking up newer vintages without manual edits.
export function weoYearWindow(now = new Date()) {
  const y = now.getUTCFullYear();
  return [String(y - 2), String(y - 1), String(y), String(y + 1)];
}

async function fetchNationalDebt() {
  const years = weoYearWindow();
  const [debtPctData, gdpData, deficitData, treasury] = await Promise.all([
    imfSdmxFetchIndicator('GGXWDG_NGDP', { years }),
    imfSdmxFetchIndicator('NGDPD', { years }),
    imfSdmxFetchIndicator('GGXCNL_NGDP', { years }),
    fetchTreasury().catch(() => null),
  ]);

  const entries = computeEntries(debtPctData, gdpData, deficitData, treasury);

  return {
    entries,
    seededAt: new Date().toISOString(),
  };
}

function validate(data) {
  return Array.isArray(data?.entries) && data.entries.length >= 100;
}

// Guard: only run seed when executed directly, not when imported by tests
export function declareRecords(data) {
  return Array.isArray(data?.entries) ? data.entries.length : 0;
}

if (process.argv[1]?.endsWith('seed-national-debt.mjs')) {
  runSeed('economic', 'national-debt', CANONICAL_KEY, fetchNationalDebt, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: 'imf-sdmx-weo-2024',
    recordCount: (data) => data?.entries?.length ?? 0,
  
    declareRecords,
    schemaVersion: 1,
    // Matches api/health.js SEED_META.nationalDebt (60d = 2× monthly interval).
    // runSeed only validates the field is present; health.js is the actual
    // alarm source, but keeping these in sync prevents future drift.
    maxStaleMin: 86400,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
