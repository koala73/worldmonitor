#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const IMF_BASE = 'https://www.imf.org/external/datamapper/api/v1';
const TREASURY_URL = 'https://api.fiscaldata.treasury.gov/services/api/v1/accounting/od/debt_to_penny?fields=record_date,tot_pub_debt_out_amt&sort=-record_date&page[size]=1';

const CANONICAL_KEY = 'economic:national-debt:v1';
const CACHE_TTL = 35 * 24 * 3600; // 35 days — monthly cron with buffer

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

async function fetchImfIndicator(indicator, periods, timeoutMs) {
  const url = `${IMF_BASE}/${indicator}?periods=${periods}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`IMF ${indicator}: HTTP ${resp.status}`);
  const data = await resp.json();
  return data?.values?.[indicator] ?? {};
}

async function fetchTreasury() {
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

export function computeEntries(debtPctByCountry, gdpByCountry, deficitPctByCountry, treasuryOverride) {
  const BASELINE_TS = Date.UTC(2024, 0, 1); // 2024-01-01T00:00:00Z
  const SECONDS_PER_YEAR = 365.25 * 86400;

  const entries = [];

  for (const [iso3, debtByYear] of Object.entries(debtPctByCountry)) {
    if (isAggregate(iso3)) continue;

    const gdpByYear = gdpByCountry[iso3];
    if (!gdpByYear) continue;

    const gdp2024 = Number(gdpByYear['2024']);
    if (!Number.isFinite(gdp2024) || gdp2024 <= 0) continue;

    const debtPct2024 = Number(debtByYear['2024']);
    const debtPct2023 = Number(debtByYear['2023']);
    const hasDebt2024 = Number.isFinite(debtPct2024) && debtPct2024 > 0;
    const hasDebt2023 = Number.isFinite(debtPct2023) && debtPct2023 > 0;

    if (!hasDebt2024 && !hasDebt2023) continue;

    const effectiveDebtPct = hasDebt2024 ? debtPct2024 : debtPct2023;
    const gdpUsd = gdp2024 * 1e9;
    let debtUsd = (effectiveDebtPct / 100) * gdpUsd;

    // Override USA with live Treasury data when available
    if (iso3 === 'USA' && treasuryOverride && treasuryOverride.debtUsd > 0) {
      debtUsd = treasuryOverride.debtUsd;
    }

    let annualGrowth = 0;
    if (hasDebt2024 && hasDebt2023) {
      annualGrowth = ((debtPct2024 - debtPct2023) / debtPct2023) * 100;
    }

    const deficitByYear = deficitPctByCountry[iso3];
    const deficitPct2024 = deficitByYear ? Number(deficitByYear['2024']) : NaN;
    let perSecondRate = 0;
    let perDayRate = 0;
    // Only accrue when running a deficit (GGXCNL_NGDP < 0 = net borrower).
    // Surplus countries (Norway, Kuwait, Singapore, etc.) tick at 0 — not upward.
    if (Number.isFinite(deficitPct2024) && deficitPct2024 < 0) {
      const deficitAbs = (Math.abs(deficitPct2024) / 100) * gdpUsd;
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
      baselineTs: BASELINE_TS,
      source: iso3 === 'USA' && treasuryOverride ? 'IMF WEO + US Treasury FiscalData' : 'IMF WEO 2024',
    });
  }

  entries.sort((a, b) => b.debtUsd - a.debtUsd);
  return entries;
}

async function fetchNationalDebt() {
  const [debtPctData, gdpData, deficitData, treasury] = await Promise.all([
    fetchImfIndicator('GGXWDG_NGDP', '2023,2024', 30_000),
    fetchImfIndicator('NGDPD', '2024', 30_000),
    fetchImfIndicator('GGXCNL_NGDP', '2024', 30_000),
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
if (process.argv[1]?.endsWith('seed-national-debt.mjs')) {
  runSeed('economic', 'national-debt', CANONICAL_KEY, fetchNationalDebt, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: 'imf-weo-2024',
    recordCount: (data) => data?.entries?.length ?? 0,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
