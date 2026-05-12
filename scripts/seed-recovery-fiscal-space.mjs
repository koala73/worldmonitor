#!/usr/bin/env node

import { loadEnvFile, runSeed, loadSharedConfig, imfSdmxFetchIndicator } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'resilience:recovery:fiscal-space:v1';
const CACHE_TTL = 35 * 24 * 3600;

// Two-floor validation thresholds for the seeded payload. Exported so
// tests assert the production values directly rather than introspecting
// `validate.toString()`.
export const FISCAL_SPACE_VALIDATION_FLOORS = { fiscal3: 150, gap: 100 };

// Hyperinflation cap on the debt-sustainability gap indicator. Above this
// CPI threshold the formula's inflation-tax term dominates and produces a
// misleadingly positive "gap" that masks underlying fiscal pathology
// (Argentina, Lebanon, Venezuela). Drop to null in that regime — the
// other 3 fiscalSpace indicators still score those countries.
export const INFLATION_GAP_CAP_PCT = 25;

const ISO2_TO_ISO3 = loadSharedConfig('iso2-to-iso3.json');
const ISO3_TO_ISO2 = Object.fromEntries(Object.entries(ISO2_TO_ISO3).map(([k, v]) => [v, k]));

const AGGREGATE_CODES = new Set([
  'ADVEC', 'EMEDE', 'EURO', 'MECA', 'OEMDC', 'WEOWORLD', 'EU',
  'AS5', 'DA', 'EDE', 'MAE', 'OAE', 'SSA', 'WE', 'EMDE', 'G20',
]);

function isAggregate(code) {
  if (!code || code.length !== 3) return true;
  return AGGREGATE_CODES.has(code) || code.endsWith('Q');
}

function weoYears() {
  const y = new Date().getFullYear();
  return [`${y}`, `${y - 1}`, `${y - 2}`];
}

function latestValue(byYear) {
  for (const year of weoYears()) {
    const v = Number(byYear?.[year]);
    if (Number.isFinite(v)) return { value: v, year: Number(year) };
  }
  return null;
}

/**
 * Find the most recent year that is present with a finite value across
 * ALL of the supplied byYear maps. Returns the year as a number, or null
 * when no common year exists in the WEO scan window (current, -1, -2).
 *
 * Year alignment is critical for the debt-sustainability formula: debt
 * could be a 2025 forecast while inflation is 2023 actual — combining
 * them across years produces a nonsense gap. Per the approved plan, only
 * the 5 formula inputs (debt, balance, primary balance, growth, inflation)
 * are aligned; revenue is NOT in the formula and is not gated by this.
 */
export function latestCommonYear(byYearMaps) {
  if (!Array.isArray(byYearMaps) || byYearMaps.length === 0) return null;
  for (const year of weoYears()) {
    const allPresent = byYearMaps.every((m) => {
      const v = Number(m?.[year]);
      return Number.isFinite(v);
    });
    if (allPresent) return Number(year);
  }
  return null;
}

/**
 * Pure computation of the IMF DSA debt-sustainability gap.
 *
 *   g    = (1 + realG/100) * (1 + infl/100) - 1     compounded nominal growth (decimal)
 *   r    = max(0, (pb - fb) / debt)                  effective interest rate (decimal)
 *   pb*  = ((r - g) / (1 + g)) * debt               debt-stabilizing primary balance (% GDP)
 *   gap  = pb - pb*                                  positive => debt declining
 *
 * Inputs are all in percent (% of GDP for fiscal terms, % per year for
 * growth and inflation). Output is in percent of GDP. Returns null when:
 *
 *   - debt is null or ≤ 0 (negative net debt is rare; r-division undefined)
 *   - inflation > INFLATION_GAP_CAP_PCT (hyperinflation; gap is unreliable)
 *   - any of {pb, fb, realG} is null (insufficient data)
 *
 * `r` is derived from the algebraic identity:
 *   overall_balance = primary_balance - interest_expense
 *   => interest_pct_gdp = primaryBalance - fiscalBalance
 *   => r = interest_pct_gdp / debt_pct_gdp
 *
 * This avoids needing per-country sovereign yields (FRED only covers US).
 */
export function computeDebtSustainabilityGap({ debt, pb, fb, realG, infl }) {
  if (debt == null || !Number.isFinite(debt) || debt <= 0) return null;
  if (infl == null || !Number.isFinite(infl) || infl > INFLATION_GAP_CAP_PCT) return null;
  if (pb == null || !Number.isFinite(pb)) return null;
  if (fb == null || !Number.isFinite(fb)) return null;
  if (realG == null || !Number.isFinite(realG)) return null;

  const g = (1 + realG / 100) * (1 + infl / 100) - 1;
  const r = Math.max(0, (pb - fb) / debt);
  const pbStar = ((r - g) / (1 + g)) * debt;
  return pb - pbStar;
}

/**
 * Pure per-country builder. Takes the raw return of `imfSdmxFetchIndicator`
 * for each of the 6 series and returns the `{[iso2]: payload}` map.
 *
 * Country inclusion stays anchored to the fiscal-3 union (revenue ∪ balance
 * ∪ debt). Growth/inflation/primaryBalance are NOT in the inclusion check
 * — an IMF fiscal-series outage that leaves countries with only growth +
 * inflation data must not produce phantom entries with null fiscal-3
 * fields (this was the R1-P0 risk in plan review).
 *
 * Fiscal-3 fields keep their existing latest-per-series semantics (no
 * regression from prior behavior). Gap-indicator fields are only emitted
 * when all 5 formula inputs share a common WEO year via latestCommonYear;
 * mismatched-year countries get gap=null with fiscal-3 still populated.
 */
export function buildFiscalSpaceCountries(perIndicator) {
  const countries = {};
  const revenueData       = perIndicator?.revenue       ?? {};
  const balanceData       = perIndicator?.balance       ?? {};
  const debtData          = perIndicator?.debt          ?? {};
  const primaryBalanceData = perIndicator?.primaryBalance ?? {};
  const growthData        = perIndicator?.growth        ?? {};
  const inflationData     = perIndicator?.inflation     ?? {};

  const allIso3 = new Set([
    ...Object.keys(revenueData),
    ...Object.keys(balanceData),
    ...Object.keys(debtData),
  ]);

  for (const iso3 of allIso3) {
    if (isAggregate(iso3)) continue;
    const iso2 = ISO3_TO_ISO2[iso3];
    if (!iso2) continue;

    const rev  = latestValue(revenueData[iso3]);
    const bal  = latestValue(balanceData[iso3]);
    const debt = latestValue(debtData[iso3]);

    // Existing skip guard — preserve verbatim. Countries with NO fiscal-3
    // data are not emitted, regardless of whether growth/inflation exist.
    if (!rev && !bal && !debt) continue;

    // Capture per-iso3 byYear dicts once — used for year alignment plus
    // the actual value reads. Saves repeated iso3 hash lookups (PR #3669
    // review nit; negligible at N=190 but the cleanup is honest).
    const debtByYear   = debtData[iso3];
    const balByYear    = balanceData[iso3];
    const pbByYear     = primaryBalanceData[iso3];
    const growthByYear = growthData[iso3];
    const inflByYear   = inflationData[iso3];

    // Year-aligned gap inputs. Only the 5 formula inputs are in the
    // alignment set — revenue is NOT in the formula and is omitted here.
    const commonYear = latestCommonYear([
      debtByYear,
      balByYear,
      pbByYear,
      growthByYear,
      inflByYear,
    ]);

    let pb = null;
    let real = null;
    let infl = null;
    let gap = null;
    let gapYear = null;
    if (commonYear != null) {
      const yearKey = String(commonYear);
      const debtCommon = Number(debtByYear?.[yearKey]);
      const fbCommon   = Number(balByYear?.[yearKey]);
      pb   = Number(pbByYear?.[yearKey]);
      real = Number(growthByYear?.[yearKey]);
      infl = Number(inflByYear?.[yearKey]);
      gap = computeDebtSustainabilityGap({
        debt: debtCommon,
        pb,
        fb: fbCommon,
        realG: real,
        infl,
      });
      gapYear = commonYear;
    }

    countries[iso2] = {
      // Existing fiscal-3 fields — unchanged latest-per-series semantics.
      govRevenuePct:     rev?.value ?? null,
      fiscalBalancePct:  bal?.value ?? null,
      debtToGdpPct:      debt?.value ?? null,
      year:              rev?.year ?? bal?.year ?? debt?.year ?? null,
      // Gap-indicator fields — only populated when all 5 formula inputs
      // share a common WEO year (otherwise all stay null).
      primaryBalancePct:         Number.isFinite(pb) ? pb : null,
      realGdpGrowthPct:          Number.isFinite(real) ? real : null,
      inflationPct:              Number.isFinite(infl) ? infl : null,
      debtSustainabilityGapPct:  gap,
      gapYear,
    };
  }

  return countries;
}

/**
 * Two-floor validator. Called by runSeed's pre-publish check.
 *
 * - If returns false → seeder rejects the payload entirely; runSeed
 *   short-circuits the canonical write and the previous canonical blob
 *   keeps serving (existing strict-floor behavior in _seed-utils.mjs).
 * - If returns true but individual countries lack gap inputs → those
 *   countries get debtSustainabilityGapPct=null and the scorer's
 *   weightedBlend redistributes weight across the remaining 3 indicators.
 *
 * Two failure modes, cleanly separated:
 *   - System-level outage (fiscal-3 < 150 OR gap-inputs < 100) → reject.
 *   - Per-country gap unavailability (year mismatch, hyperinflation cap,
 *     partial growth/inflation for one specific country) → emit with
 *     gap=null, fiscal-3 still scores them.
 */
export function validateFiscalSpace(data, floors = FISCAL_SPACE_VALIDATION_FLOORS) {
  const all = Object.values(data?.countries || {});
  const withFiscal3 = all.filter(c =>
    c.govRevenuePct != null && c.fiscalBalancePct != null && c.debtToGdpPct != null
  ).length;
  const withGap = all.filter(c => c.debtSustainabilityGapPct != null).length;
  return withFiscal3 >= floors.fiscal3 && withGap >= floors.gap;
}

async function fetchFiscalSpace() {
  const years = weoYears();
  const [revenueData, balanceData, debtData, primaryBalanceData, growthData, inflationData] = await Promise.all([
    imfSdmxFetchIndicator('GGR_NGDP',    { years }),
    imfSdmxFetchIndicator('GGXCNL_NGDP', { years }),
    imfSdmxFetchIndicator('GGXWDG_NGDP', { years }),
    imfSdmxFetchIndicator('GGXONLB_NGDP', { years }),  // primary balance % GDP
    imfSdmxFetchIndicator('NGDP_RPCH',   { years }),    // real GDP growth %
    imfSdmxFetchIndicator('PCPIPCH',     { years }),    // CPI inflation %
  ]);

  const countries = buildFiscalSpaceCountries({
    revenue:        revenueData,
    balance:        balanceData,
    debt:           debtData,
    primaryBalance: primaryBalanceData,
    growth:         growthData,
    inflation:      inflationData,
  });

  return { countries, seededAt: new Date().toISOString() };
}

export function declareRecords(data) {
  return Object.keys(data?.countries || {}).length;
}

if (process.argv[1]?.endsWith('seed-recovery-fiscal-space.mjs')) {
  runSeed('resilience', 'recovery:fiscal-space', CANONICAL_KEY, fetchFiscalSpace, {
    validateFn: (data) => validateFiscalSpace(data),
    ttlSeconds: CACHE_TTL,
    sourceVersion: `imf-sdmx-weo-fiscal-${new Date().getFullYear()}`,
    recordCount: (data) => Object.keys(data?.countries ?? {}).length,

    declareRecords,
    schemaVersion: 2,
    // 90d = 3× the 30-day cron interval per the health-maxstalemin-write-cadence
    // skill (rule: maxStaleMin = write_interval × 2-3). Bumped from 86400 (2×, at
    // project floor) to give extra margin against month-2 cron hiccups. Must also
    // be mirrored in api/health.js for the alarm threshold to track.
    maxStaleMin: 129600,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
