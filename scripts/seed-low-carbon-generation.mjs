#!/usr/bin/env node

// PR 1 of the resilience repair plan (§3.3). Writes the per-country
// low-carbon share of electricity generation (nuclear + renewables
// + hydroelectric). Read by scoreEnergy v2 via
// `resilience:low-carbon-generation:v1`.
//
// Source: World Bank WDI. THREE indicators summed per country:
//   - EG.ELC.NUCL.ZS: electricity production from nuclear (% of total)
//   - EG.ELC.RNEW.ZS: electricity production from renewable sources
//                     EXCLUDING hydroelectric (% of total)
//   - EG.ELC.HYRO.ZS: electricity production from hydroelectric
//                     sources (% of total)
//
// Hydro is included alongside RNEW because the WB RNEW series
// explicitly excludes hydroelectric — omitting HYRO would collapse
// this indicator to ~0 for Norway (~95% hydro), Paraguay (~99%),
// Brazil (~65%), Canada (~60%) and produce rankings that contradict
// the power-system security intent.
//
// All three series are annual; WDI reports latest observed year per
// country. We fetch up to 5 most-recent years (mrv=5), keep the per-year
// history for each country, and sum only the latest COMMON source year
// across the component series available for that country. That prevents a
// 2024 hydro filing from being added to a 2021 renewables-ex-hydro filing
// and then labelled as 2024. The mrv=5 + null-skip recipe is documented in
// skill `wb-bulk-mrv1-null-coverage-trap`; applied to this file in PR #3432
// (review fixup).
// Missing an entire component series for a country is treated as 0 for that
// slice, but if a component series exists for the country it must have data
// in the selected common year. The scorer's 0..80 saturating goalpost
// tolerates partial coverage without dropping the indicator to null.

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
import iso3ToIso2 from './shared/iso3-to-iso2.json' with { type: 'json' };
// Shared content-age helper for WB per-country annual seeders.
// Per-seeder budget lives below — same shape, different publication lags.
import { wbCountryDictContentMeta } from './_wb-country-dict-content-age-helpers.mjs';

// 60mo budget (INTERIM). The binding constraint is the latest COMMON component
// year (min across NUCL/RNEW/HYRO), and one component (hydro/nuclear) is frozen
// at 2021 in WB WDI — so the live composite is ~53mo old (verified 2026-06),
// well past the original 36mo estimate. That 36mo assumed an ~18mo per-component
// publication lag, which does NOT hold for the min-common-year composite when
// one WB series stalls. 60mo clears the genuine WB lag while still tripping a
// real regression (a 2020 freeze is ~64mo > 60mo). This is a STOPGAP: the
// durable fix is migrating low-carbon generation to a fresher source (Ember/OWID,
// which publish 2023+ electricity mix) and restoring a tight budget — issue #4219.
const MAX_CONTENT_AGE_MIN = 60 * 30 * 24 * 60;

loadEnvFile(import.meta.url);

const WB_BASE = 'https://api.worldbank.org/v2';
const CANONICAL_KEY = 'resilience:low-carbon-generation:v1';
const CACHE_TTL = 35 * 24 * 3600;
const INDICATORS = ['EG.ELC.NUCL.ZS', 'EG.ELC.RNEW.ZS', 'EG.ELC.HYRO.ZS'];

async function fetchIndicator(indicatorId) {
  const pages = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages) {
    // mrv=5 (NOT mrv=1) per memory `feedback_wb_bulk_mrv1_null_coverage_trap`:
    // mrv=1 returns a SINGLE year across all countries with `value: null` for
    // late-reporters (KW/QA/AE publish 1-2y behind G7), silently dropping
    // them. mrv=5 + per-country pickLatest gives a true latest-non-null.
    const url = `${WB_BASE}/country/all/indicator/${indicatorId}?format=json&per_page=2000&page=${page}&mrv=5`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) throw new Error(`World Bank ${indicatorId}: HTTP ${resp.status}`);
    const json = await resp.json();
    totalPages = json[0]?.pages ?? 1;
    pages.push(...(json[1] ?? []));
    page++;
  }
  return pages;
}

export function collectByIsoYear(records) {
  const out = new Map();
  for (const record of records) {
    const rawCode = record?.countryiso3code ?? record?.country?.id ?? '';
    const iso2 = rawCode.length === 3 ? (iso3ToIso2[rawCode] ?? null) : (rawCode.length === 2 ? rawCode : null);
    if (!iso2) continue;
    // CRITICAL: skip null records BEFORE Number() coercion.
    // Number(null) === 0 (not NaN), passes Number.isFinite(), and the
    // `out.set(iso2, ...)` overwrite below would replace an older
    // non-null record. EG.ELC.{NUCL,RNEW,HYRO}.ZS are "% of" indicators
    // where 0 IS a legitimate value (country has 0% nuclear / renewable /
    // hydro), so we CAN'T use the `value <= 0` defense — must skip
    // null explicitly. Same recipe as PR #3427.
    if (record?.value == null) continue;
    const value = Number(record.value);
    if (!Number.isFinite(value)) continue;
    const year = Number(record?.date);
    if (!Number.isFinite(year)) continue;
    let byYear = out.get(iso2);
    if (!byYear) {
      byYear = new Map();
      out.set(iso2, byYear);
    }
    byYear.set(year, value);
  }
  return out;
}

function latestCommonYear(componentMaps) {
  const populated = componentMaps.filter((m) => m instanceof Map && m.size > 0);
  if (populated.length === 0) return null;

  const [first, ...rest] = populated;
  const commonYears = [...first.keys()].filter((year) => rest.every((m) => m.has(year)));
  if (commonYears.length === 0) return null;
  return Math.max(...commonYears);
}

export function buildLowCarbonCountries({ nuclearByIso, renewByIso, hydroByIso }) {
  const allIso = new Set([...nuclearByIso.keys(), ...renewByIso.keys(), ...hydroByIso.keys()]);
  const countries = {};

  for (const iso2 of allIso) {
    const nuc = nuclearByIso.get(iso2) ?? new Map();
    const ren = renewByIso.get(iso2) ?? new Map();
    const hyd = hydroByIso.get(iso2) ?? new Map();
    const year = latestCommonYear([nuc, ren, hyd]);
    if (year == null) continue;

    const nuclearShare = nuc.get(year) ?? 0;
    const renewablesExHydroShare = ren.get(year) ?? 0;
    const hydroShare = hyd.get(year) ?? 0;
    const sum = nuclearShare + renewablesExHydroShare + hydroShare;

    countries[iso2] = {
      value: Math.min(sum, 100), // guard against impossible sums from revised filings
      year,
      nuclearShare,
      renewablesExHydroShare,
      hydroShare,
      sourceYears: {
        nuclear: nuc.has(year) ? year : null,
        renewablesExHydro: ren.has(year) ? year : null,
        hydro: hyd.has(year) ? year : null,
      },
    };
  }

  return countries;
}

async function fetchLowCarbonGeneration() {
  const [nuclearRecords, renewRecords, hydroRecords] = await Promise.all(INDICATORS.map(fetchIndicator));
  const nuclearByIso = collectByIsoYear(nuclearRecords);
  const renewByIso = collectByIsoYear(renewRecords);
  const hydroByIso = collectByIsoYear(hydroRecords);
  const countries = buildLowCarbonCountries({ nuclearByIso, renewByIso, hydroByIso });
  return { countries, seededAt: new Date().toISOString() };
}

function validate(data) {
  // 150 → 100 on 2026-05-03 — see seed-power-reliability.mjs for rationale.
  // Same WB late-reporter variation affects this indicator;
  // canonical cache holds 208 countries.
  return typeof data?.countries === 'object' && Object.keys(data.countries).length >= 100;
}

export function declareRecords(data) {
  return Object.keys(data?.countries || {}).length;
}

if (process.argv[1]?.endsWith('seed-low-carbon-generation.mjs')) {
  runSeed('resilience', 'low-carbon-generation', CANONICAL_KEY, fetchLowCarbonGeneration, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: `wb-low-carbon-${new Date().getFullYear()}`,
    recordCount: (data) => Object.keys(data?.countries ?? {}).length,
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 8 * 24 * 60, // weekly cadence + 1 day slack

    // ── Content-age contract (Sprint 4 cohort follow-up) ──
    // Seeder publishes the latest COMMON component year across NUCL/RNEW/HYRO
    // per country; contentMeta then takes MAX year across countries. Budget
    // rationale documented at the MAX_CONTENT_AGE_MIN constant above.
    contentMeta: wbCountryDictContentMeta,
    maxContentAgeMin: MAX_CONTENT_AGE_MIN,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
