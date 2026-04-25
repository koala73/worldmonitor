#!/usr/bin/env node
//
// WB IDS — short-term external debt as % of GNI
// Canonical key: economic:wb-external-debt:v1
//
// Composition: short-term external debt as % of GNI is computed from two
// World Bank IDS series (matching plan 2026-04-25-004 §Component 1):
//
//   DT.DOD.DSTC.IR.ZS  — Short-term external debt (% of total external debt)
//   DT.DOD.DECT.GN.ZS  — Total external debt stocks (% of GNI)
//
//   shortTermDebtPctGni = (DT.DOD.DSTC.IR.ZS / 100) * DT.DOD.DECT.GN.ZS
//
// Coverage: ~125 LMICs (low- and middle-income countries). HIC are not
// published by WB IDS — those countries fall through to the BIS LBS
// structural-exposure component in the resilience scorer (see
// `scoreFinancialSystemExposure` in `_dimension-scorers.ts`).
//
// IMF Article IV vulnerability threshold for short-term external debt
// is canonically 15% of GNI; the resilience scorer uses
// `normalizeLowerBetter(value, 0, 15)` to anchor the goalpost.

import { loadEnvFile, CHROME_UA, runSeed, resolveProxyForConnect, httpsProxyFetchRaw } from './_seed-utils.mjs';
import iso3ToIso2 from './shared/iso3-to-iso2.json' with { type: 'json' };

loadEnvFile(import.meta.url);

const WB_BASE = 'https://api.worldbank.org/v2';
const _proxyAuth = resolveProxyForConnect();
const CANONICAL_KEY = 'economic:wb-external-debt:v1';
const CACHE_TTL = 35 * 24 * 3600; // 35 days; WB IDS publishes annually

const SHORT_TERM_PCT_OF_TOTAL_INDICATOR = 'DT.DOD.DSTC.IR.ZS';
const TOTAL_DEBT_PCT_GNI_INDICATOR = 'DT.DOD.DECT.GN.ZS';

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
      const value = Number(record?.value);
      if (!Number.isFinite(value)) continue;
      const year = Number(record?.date);
      if (!Number.isFinite(year)) continue;
      // Per-key memory `feedback_wb_bulk_mrv1_null_coverage_trap`: mrv=1
      // returns SINGLE year across all countries with `value: null` for
      // late-reporters; mrv=5 + pickLatestPerCountry handles that.
      const existing = out[iso2];
      if (!existing || year > existing.year) {
        out[iso2] = { value, year };
      }
    }
    page++;
  }
  return out;
}

export function combineExternalDebt({ shortTermPctOfTotal, totalDebtPctGni }) {
  const countries = {};
  const allCodes = new Set([
    ...Object.keys(shortTermPctOfTotal),
    ...Object.keys(totalDebtPctGni),
  ]);

  for (const iso2 of allCodes) {
    const stPct = shortTermPctOfTotal[iso2];
    const totalPct = totalDebtPctGni[iso2];
    if (!stPct || !totalPct) continue;
    if (stPct.value < 0 || totalPct.value < 0) continue;

    // shortTermDebt as % of GNI = (shortTermShare / 100) * totalDebtPctOfGni.
    const value = Math.round(((stPct.value / 100) * totalPct.value) * 100) / 100;
    // Use min(year) as the conservative "we have both" anchor. WB IDS
    // publishes the two source indicators with different lag patterns;
    // mixing different vintages is materially correct for resilience
    // scoring (the older year's data is the binding constraint), but
    // surface yearMismatch so the dashboard / scorer can flag countries
    // with cross-year composition for ops triage.
    const conservativeYear = Math.min(stPct.year, totalPct.year);
    const yearMismatch = stPct.year !== totalPct.year;
    countries[iso2] = {
      value,
      year: conservativeYear,
      yearMismatch,
      // Provenance: which underlying values + per-indicator years.
      shortTermPctOfTotalDebt: Math.round(stPct.value * 100) / 100,
      totalDebtPctOfGni: Math.round(totalPct.value * 100) / 100,
      shortTermPctOfTotalDebtYear: stPct.year,
      totalDebtPctOfGniYear: totalPct.year,
    };
  }
  return countries;
}

async function fetchWbExternalDebt() {
  const [shortTermPctOfTotal, totalDebtPctGni] = await Promise.all([
    fetchWbIndicator(SHORT_TERM_PCT_OF_TOTAL_INDICATOR),
    fetchWbIndicator(TOTAL_DEBT_PCT_GNI_INDICATOR),
  ]);

  return {
    countries: combineExternalDebt({ shortTermPctOfTotal, totalDebtPctGni }),
    sources: [
      `https://data.worldbank.org/indicator/${SHORT_TERM_PCT_OF_TOTAL_INDICATOR}`,
      `https://data.worldbank.org/indicator/${TOTAL_DEBT_PCT_GNI_INDICATOR}`,
    ],
    seededAt: new Date().toISOString(),
  };
}

// WB IDS publishes for ~125 LMICs only; HIC are explicitly absent.
// Floor is 80 to absorb late-reporting LMICs without blocking on a
// transient outage.
export function validate(data) {
  return typeof data?.countries === 'object' && Object.keys(data.countries).length >= 80;
}

export function declareRecords(data) {
  return Object.keys(data?.countries || {}).length;
}

export { CANONICAL_KEY, CACHE_TTL, fetchWbExternalDebt };

if (process.argv[1]?.endsWith('seed-wb-external-debt.mjs')) {
  runSeed('economic', 'wb-external-debt', CANONICAL_KEY, fetchWbExternalDebt, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: `wb-ids-${new Date().getFullYear()}`,
    recordCount: (data) => Object.keys(data?.countries ?? {}).length,
    // Empty result = real upstream failure (floor is 80 LMICs). Without this,
    // a transient WB outage would refresh seed-meta on a tiny payload and
    // freeze the bundle (see memory `feedback_strict_floor_validate_fail_poisons_seed_meta`).
    emptyDataIsFailure: true,
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 100800,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
