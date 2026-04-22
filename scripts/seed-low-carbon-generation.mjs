#!/usr/bin/env node

// PR 1 of the resilience repair plan (§3.3). Writes the per-country
// low-carbon share of electricity generation (nuclear + renewables).
// Read by scoreEnergy v2 via `resilience:low-carbon-generation:v1`.
//
// Source: World Bank WDI. Two indicators summed per country:
//   - EG.ELC.NUCL.ZS: electricity production from nuclear (% of total)
//   - EG.ELC.RNEW.ZS: electricity production from renewable sources
//                     excluding hydroelectric (% of total)
//
// Both series are annual; WDI reports latest observed year per
// country. We fetch the most-recent value (mrv=1) and sum by ISO2.
// Missing half of the pair (e.g. a country with nuclear data but no
// renewable filing) still produces a value using just the observed
// half — the scorer treats the goalpost 0..80 as saturating, so
// partial coverage is better than `null`.

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
import iso3ToIso2 from './shared/iso3-to-iso2.json' with { type: 'json' };

loadEnvFile(import.meta.url);

const WB_BASE = 'https://api.worldbank.org/v2';
const CANONICAL_KEY = 'resilience:low-carbon-generation:v1';
const CACHE_TTL = 35 * 24 * 3600;
const INDICATORS = ['EG.ELC.NUCL.ZS', 'EG.ELC.RNEW.ZS'];

async function fetchIndicator(indicatorId) {
  const pages = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages) {
    const url = `${WB_BASE}/country/all/indicator/${indicatorId}?format=json&per_page=500&page=${page}&mrv=1`;
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
    const value = Number(record?.value);
    if (!Number.isFinite(value)) continue;
    const year = Number(record?.date);
    out.set(iso2, { value, year: Number.isFinite(year) ? year : null });
  }
  return out;
}

async function fetchLowCarbonGeneration() {
  const [nuclearRecords, renewRecords] = await Promise.all(INDICATORS.map(fetchIndicator));
  const nuclearByIso = collectByIso2(nuclearRecords);
  const renewByIso = collectByIso2(renewRecords);

  const allIso = new Set([...nuclearByIso.keys(), ...renewByIso.keys()]);
  const countries = {};
  for (const iso2 of allIso) {
    const nuc = nuclearByIso.get(iso2);
    const ren = renewByIso.get(iso2);
    const sum = (nuc?.value ?? 0) + (ren?.value ?? 0);
    // Year: most-recent of the two (they can diverge by a year or two
    // between filings). Use the MAX so freshness reflects newest input.
    const years = [nuc?.year, ren?.year].filter((y) => y != null);
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
