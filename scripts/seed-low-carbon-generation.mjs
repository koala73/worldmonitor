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
// country. We fetch up to 5 most-recent years (mrv=5) and pick the
// latest non-null per country, then sum by ISO2. The mrv=5 + null-skip
// recipe is documented in skill `wb-bulk-mrv1-null-coverage-trap`;
// applied to this file in PR #3432 (review fixup).
// Missing any of the three (e.g. a country with no nuclear filing)
// is treated as 0 for that slice — the scorer's 0..80 saturating
// goalpost tolerates partial coverage without dropping the indicator
// to null.

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
import iso3ToIso2 from './shared/iso3-to-iso2.json' with { type: 'json' };

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

function collectByIso2(records) {
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
    // Per-country latest-non-null (mrv=5 returns up to 5 records per country).
    const existing = out.get(iso2);
    if (!existing || year > existing.year) {
      out.set(iso2, { value, year });
    }
  }
  return out;
}

async function fetchLowCarbonGeneration() {
  const [nuclearRecords, renewRecords, hydroRecords] = await Promise.all(INDICATORS.map(fetchIndicator));
  const nuclearByIso = collectByIso2(nuclearRecords);
  const renewByIso = collectByIso2(renewRecords);
  const hydroByIso = collectByIso2(hydroRecords);

  const allIso = new Set([...nuclearByIso.keys(), ...renewByIso.keys(), ...hydroByIso.keys()]);
  const countries = {};
  for (const iso2 of allIso) {
    const nuc = nuclearByIso.get(iso2);
    const ren = renewByIso.get(iso2);
    const hyd = hydroByIso.get(iso2);
    const sum = (nuc?.value ?? 0) + (ren?.value ?? 0) + (hyd?.value ?? 0);
    // Year: most-recent of the three (they can diverge by a year or two
    // between filings). Use the MAX so freshness reflects newest input.
    const years = [nuc?.year, ren?.year, hyd?.year].filter((y) => y != null);
    countries[iso2] = {
      value: Math.min(sum, 100), // guard against impossible sums from revised filings
      year: years.length > 0 ? Math.max(...years) : null,
    };
  }
  return { countries, seededAt: new Date().toISOString() };
}

function validate(data) {
  return typeof data?.countries === 'object' && Object.keys(data.countries).length >= 150;
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
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
