#!/usr/bin/env node

// PR 1 of the resilience repair plan (§3.2). Writes the per-country
// fossil share of electricity generation. Read by scoreEnergy v2 via
// `resilience:fossil-electricity-share:v1` as the `fossilShare`
// multiplier in the importedFossilDependence composite.
//
// Source: World Bank WDI EG.ELC.FOSL.ZS — electricity production
// from oil, gas and coal sources (% of total). Annual cadence.
//
// Shape: { countries: { [ISO2]: { value: 0-100, year } }, seededAt }

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
import iso3ToIso2 from './shared/iso3-to-iso2.json' with { type: 'json' };

loadEnvFile(import.meta.url);

const WB_BASE = 'https://api.worldbank.org/v2';
const CANONICAL_KEY = 'resilience:fossil-electricity-share:v1';
const CACHE_TTL = 35 * 24 * 3600;
const INDICATOR = 'EG.ELC.FOSL.ZS';

async function fetchFossilElectricityShare() {
  const pages = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages) {
    // mrv=5 (NOT mrv=1) per memory `feedback_wb_bulk_mrv1_null_coverage_trap`:
    // mrv=1 returns a SINGLE year across all countries with `value: null` for
    // late-reporters (KW/QA/AE publish 1-2y behind G7), silently dropping
    // them. mrv=5 + per-country pickLatest gives a true latest-non-null.
    const url = `${WB_BASE}/country/all/indicator/${INDICATOR}?format=json&per_page=2000&page=${page}&mrv=5`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) throw new Error(`World Bank ${INDICATOR}: HTTP ${resp.status}`);
    const json = await resp.json();
    totalPages = json[0]?.pages ?? 1;
    pages.push(...(json[1] ?? []));
    page++;
  }

  const countries = {};
  for (const record of pages) {
    const rawCode = record?.countryiso3code ?? record?.country?.id ?? '';
    const iso2 = rawCode.length === 3 ? (iso3ToIso2[rawCode] ?? null) : (rawCode.length === 2 ? rawCode : null);
    if (!iso2) continue;
    // CRITICAL: skip null records BEFORE Number() coercion.
    // Number(null) === 0 (not NaN), passes Number.isFinite(), and would
    // let a `value: null` record overwrite an older non-null record in
    // the year-comparison below. EG.ELC.FOSL.ZS is a "% of" indicator
    // where 0 IS a legitimate value (country has 0% fossil generation),
    // so we CAN'T use the `value <= 0` defense from the recipe — must
    // skip null explicitly. Same recipe as PR #3427 fixed for the
    // recovery seeders.
    if (record?.value == null) continue;
    const value = Number(record.value);
    if (!Number.isFinite(value)) continue;
    const year = Number(record?.date);
    if (!Number.isFinite(year)) continue;
    // Per-country latest-non-null (mrv=5 returns up to 5 records per country).
    const existing = countries[iso2];
    if (!existing || year > existing.year) {
      countries[iso2] = { value, year };
    }
  }

  return { countries, seededAt: new Date().toISOString() };
}

function validate(data) {
  return typeof data?.countries === 'object' && Object.keys(data.countries).length >= 150;
}

export function declareRecords(data) {
  return Object.keys(data?.countries || {}).length;
}

if (process.argv[1]?.endsWith('seed-fossil-electricity-share.mjs')) {
  runSeed('resilience', 'fossil-electricity-share', CANONICAL_KEY, fetchFossilElectricityShare, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: `wb-fossil-elec-${new Date().getFullYear()}`,
    recordCount: (data) => Object.keys(data?.countries ?? {}).length,
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 8 * 24 * 60,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
