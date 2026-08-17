#!/usr/bin/env node
//
// WB IDS — short-term external debt as % of GNI
// Canonical key: economic:wb-external-debt:v1
//
// Composition: divide absolute USD values directly. The previous
// version used `DT.DOD.DSTC.IR.ZS` × `DT.DOD.DECT.GN.ZS` / 100, but
// `DT.DOD.DSTC.IR.ZS` is "% of total RESERVES" (NOT "% of total
// external debt"), so the composed result was mathematically wrong —
// AR / TR scored above 100% on the intermediate ratio because their
// short-term debt exceeds reserves. Caught by activation-time Redis
// audit (PR #3407 follow-up).
//
//   DT.DOD.DSTC.CD     — Short-term external debt stocks (current US$)
//   NY.GNP.MKTP.CD     — GNI (current US$)
//
//   shortTermDebtPctGni = (DT.DOD.DSTC.CD / NY.GNP.MKTP.CD) * 100
//
// Coverage: ~125 World Bank borrower economies. WB IDS is the published
// output of the Debtor Reporting System; non-borrowers are absent by design
// and are identified explicitly from the World Bank country catalog below.
// See `scoreFinancialSystemExposure` in `_dimension-scorers.ts`.
//
// IMF Article IV vulnerability threshold for short-term external debt
// is canonically 15% of GNI; the resilience scorer uses
// `normalizeLowerBetter(value, 0, 15)` to anchor the goalpost.

import { loadEnvFile, CHROME_UA, runSeed, resolveProxyForConnect, httpsProxyFetchRaw } from './_seed-utils.mjs';
import { wbCountryDictContentMeta } from './_wb-country-dict-content-age-helpers.mjs';
import iso3ToIso2 from './shared/iso3-to-iso2.json' with { type: 'json' };

loadEnvFile(import.meta.url);

const WB_BASE = 'https://api.worldbank.org/v2';
const _proxyAuth = resolveProxyForConnect();
const CANONICAL_KEY = 'economic:wb-external-debt:v1';
const CACHE_TTL = 35 * 24 * 3600; // 35 days; WB IDS publishes annually
// Content-age budget — WB IDS is annual and lags ~2 years. 48 months clears
// the lag plus a publication cycle; STALE_CONTENT fires only when WB stops
// publishing for 2+ annual cycles. See issue #3845.
const MAX_CONTENT_AGE_MIN = 48 * 30 * 24 * 60;

const SHORT_TERM_DEBT_USD_INDICATOR = 'DT.DOD.DSTC.CD';
const GNI_USD_INDICATOR = 'NY.GNP.MKTP.CD';

async function fetchWbIndicator(indicator) {
  const out = {};
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const url = `${WB_BASE}/country/all/indicator/${indicator}?format=json&per_page=500&page=${page}&mrv=5`;
    let json;
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      json = await resp.json();
    } catch (directErr) {
      if (!_proxyAuth) throw new Error(`World Bank ${indicator}: ${directErr.message}`);
      console.warn(`  WB ${indicator} p${page}: direct failed (${directErr.message}), retrying via proxy`);
      const { buffer } = await httpsProxyFetchRaw(url, _proxyAuth, { accept: 'application/json', timeoutMs: 30_000 });
      json = JSON.parse(buffer.toString('utf8'));
    }
    const meta = json[0];
    const records = json[1] ?? [];
    totalPages = meta?.pages ?? 1;
    for (const record of records) {
      const rawCode = record?.countryiso3code ?? record?.country?.id ?? '';
      const iso2 = rawCode.length === 3 ? (iso3ToIso2[rawCode] ?? null) : (rawCode.length === 2 ? rawCode : null);
      if (!iso2) continue;
      // CRITICAL: skip null records BEFORE Number() coercion.
      // Number(null) === 0 (not NaN), passes Number.isFinite(), and would
      // let a `value: null` record overwrite an older non-null record in
      // the year-comparison below. The downstream country-level filter
      // at `combineExternalDebt` only rejects `debt.value < 0`, not
      // `< 0`, so a coerced 0 propagates through and publishes a false
      // 0% short-term-debt-to-GNI for late-reporting LMICs. Same compound
      // trap as PR #3427 / PR #3432 — original miss caught by reviewer
      // post-PR-#3432 sweep.
      if (record?.value == null) continue;
      const value = Number(record.value);
      if (!Number.isFinite(value)) continue;
      const year = Number(record?.date);
      if (!Number.isFinite(year)) continue;
      // Per-key memory `feedback_wb_bulk_mrv1_null_coverage_trap`: mrv=1
      // returns SINGLE year across all countries with `value: null` for
      // late-reporters; mrv=5 + pickLatestPerCountry handles that.
      // The explicit null-skip above is the second half of the trap fix.
      const existing = out[iso2];
      if (!existing || year > existing.year) {
        out[iso2] = { value, year };
      }
    }
    page++;
  }
  return out;
}

/**
 * World Bank country records with lendingType=LNX are outside the Bank's
 * borrower programs and therefore outside DRS reporting scope. Derive the
 * list from the source catalog instead of inferring eligibility from a
 * missing observation, which can also mean a late or partial country row.
 */
export function deriveNonDrsCountryCodes(records) {
  if (!Array.isArray(records)) return [];
  return [...new Set(records.flatMap((record) => {
    const iso2 = record?.iso2Code;
    if (typeof iso2 !== 'string' || !/^[A-Z]{2}$/.test(iso2)) return [];
    // World Bank aggregate rows use region.id=NA and must never become
    // country-level scorer policy.
    if (record?.region?.id === 'NA') return [];
    return record?.lendingType?.id === 'LNX' ? [iso2] : [];
  }))].sort();
}

async function fetchWbNonDrsCountryCodes() {
  const url = `${WB_BASE}/country?format=json&per_page=400`;
  let json;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    json = await resp.json();
  } catch (directErr) {
    if (!_proxyAuth) throw new Error(`World Bank country metadata: ${directErr.message}`);
    console.warn(`  WB country metadata: direct failed (${directErr.message}), retrying via proxy`);
    const { buffer } = await httpsProxyFetchRaw(url, _proxyAuth, { accept: 'application/json', timeoutMs: 30_000 });
    json = JSON.parse(buffer.toString('utf8'));
  }
  return deriveNonDrsCountryCodes(json?.[1]);
}

export function combineExternalDebt({ shortTermDebtUsd, gniUsd }) {
  const countries = {};
  const allCodes = new Set([
    ...Object.keys(shortTermDebtUsd),
    ...Object.keys(gniUsd),
  ]);

  for (const iso2 of allCodes) {
    const debt = shortTermDebtUsd[iso2];
    const gni = gniUsd[iso2];
    // Both indicators must be present; GNI must be positive (division).
    if (!debt || !gni) continue;
    if (debt.value < 0 || gni.value <= 0) continue;

    // shortTermDebt as % of GNI = (DT.DOD.DSTC.CD / NY.GNP.MKTP.CD) × 100.
    // Both indicators are absolute USD values; direct ratio.
    const value = Math.round((debt.value / gni.value) * 10_000) / 100;
    // Use min(year) as the conservative "we have both" anchor. WB IDS
    // publishes the two source indicators with different lag patterns;
    // mixing different vintages is materially correct for resilience
    // scoring (the older year's data is the binding constraint), but
    // surface yearMismatch so the dashboard / scorer can flag countries
    // with cross-year composition for ops triage.
    const conservativeYear = Math.min(debt.year, gni.year);
    const yearMismatch = debt.year !== gni.year;
    countries[iso2] = {
      value,
      year: conservativeYear,
      yearMismatch,
      // Provenance: absolute USD values + per-indicator years.
      shortTermDebtUsd: debt.value,
      gniUsd: gni.value,
      shortTermDebtUsdYear: debt.year,
      gniUsdYear: gni.year,
    };
  }
  return countries;
}

async function fetchWbExternalDebt() {
  const [shortTermDebtUsd, gniUsd, nonDrsCountryCodes] = await Promise.all([
    fetchWbIndicator(SHORT_TERM_DEBT_USD_INDICATOR),
    fetchWbIndicator(GNI_USD_INDICATOR),
    fetchWbNonDrsCountryCodes(),
  ]);

  return {
    countries: combineExternalDebt({ shortTermDebtUsd, gniUsd }),
    nonDrsCountryCodes,
    sources: [
      `https://data.worldbank.org/indicator/${SHORT_TERM_DEBT_USD_INDICATOR}`,
      `https://data.worldbank.org/indicator/${GNI_USD_INDICATOR}`,
      `${WB_BASE}/country`,
    ],
    seededAt: new Date().toISOString(),
  };
}

// WB IDS publishes for ~125 LMICs only; HIC are explicitly absent.
// Floor is 80 to absorb late-reporting LMICs without blocking on a
// transient outage.
export function validate(data) {
  const nonDrsCountryCodes = data?.nonDrsCountryCodes;
  return (
    typeof data?.countries === 'object'
    && !Array.isArray(data.countries)
    && Object.keys(data.countries).length >= 80
    && Array.isArray(nonDrsCountryCodes)
    && nonDrsCountryCodes.length >= 40
    && nonDrsCountryCodes.every((code) => typeof code === 'string' && /^[A-Z]{2}$/.test(code))
    && new Set(nonDrsCountryCodes).size === nonDrsCountryCodes.length
  );
}

export function declareRecords(data) {
  return Object.keys(data?.countries || {}).length;
}

export function createWbExternalDebtSeedOptions(now = new Date()) {
  return {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: `wb-ids-${now.getFullYear()}`,
    recordCount: (data) => Object.keys(data?.countries ?? {}).length,
    // Empty result = real upstream failure (floor is 80 LMICs). Without this,
    // a transient WB outage would refresh seed-meta on a tiny payload and
    // freeze the bundle (see memory `feedback_strict_floor_validate_fail_poisons_seed_meta`).
    emptyDataIsFailure: true,
    declareRecords,
    schemaVersion: 2,
    maxStaleMin: 100800,
    contentMeta: wbCountryDictContentMeta,
    maxContentAgeMin: MAX_CONTENT_AGE_MIN,
  };
}

export { CANONICAL_KEY, CACHE_TTL, fetchWbExternalDebt };

if (process.argv[1]?.endsWith('seed-wb-external-debt.mjs')) {
  runSeed(
    'economic',
    'wb-external-debt',
    CANONICAL_KEY,
    fetchWbExternalDebt,
    createWbExternalDebtSeedOptions(),
  ).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
