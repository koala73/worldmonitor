#!/usr/bin/env node
//
// IMF WEO — labor & demographics
// Canonical key: economic:imf:labor:v1
//
// Indicators:
//   LUR — Unemployment rate, %
//   LP  — Population, persons (millions)
//
// Per WorldMonitor #3027 — feeds resilience macroFiscal scoring (LUR
// sub-metric) and CountryDeepDivePanel demographic tiles (LP).

import { loadEnvFile, runSeed, loadSharedConfig, imfSdmxFetchIndicator } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'economic:imf:labor:v1';
const CACHE_TTL = 35 * 24 * 3600;

const ISO2_TO_ISO3 = loadSharedConfig('iso2-to-iso3.json');
const ISO3_TO_ISO2 = Object.fromEntries(Object.entries(ISO2_TO_ISO3).map(([k, v]) => [v, k]));

const AGGREGATE_CODES = new Set([
  'ADVEC', 'EMEDE', 'EURO', 'MECA', 'OEMDC', 'WEOWORLD', 'EU',
  'AS5', 'DA', 'EDE', 'MAE', 'OAE', 'SSA', 'WE', 'EMDE', 'G20',
]);

export function isAggregate(code) {
  if (!code || code.length !== 3) return true;
  return AGGREGATE_CODES.has(code) || code.endsWith('Q');
}

export function weoYears() {
  const y = new Date().getFullYear();
  return [`${y}`, `${y - 1}`, `${y - 2}`];
}

export function latestValue(byYear) {
  for (const year of weoYears()) {
    const v = Number(byYear?.[year]);
    if (Number.isFinite(v)) return { value: v, year: Number(year) };
  }
  return null;
}

export function buildLaborCountries({ unemployment = {}, population = {} }) {
  const countries = {};
  const allIso3 = new Set([...Object.keys(unemployment), ...Object.keys(population)]);
  for (const iso3 of allIso3) {
    if (isAggregate(iso3)) continue;
    const iso2 = ISO3_TO_ISO2[iso3];
    if (!iso2) continue;

    const lur = latestValue(unemployment[iso3]);
    const lp = latestValue(population[iso3]);

    if (!lur && !lp) continue;

    countries[iso2] = {
      unemploymentPct: lur?.value ?? null,
      populationMillions: lp?.value ?? null,
      year: lur?.year ?? lp?.year ?? null,
    };
  }
  return countries;
}

export async function fetchImfLabor() {
  const years = weoYears();
  const [unemployment, population] = await Promise.all([
    imfSdmxFetchIndicator('LUR', { years }),
    imfSdmxFetchIndicator('LP', { years }),
  ]);
  return {
    countries: buildLaborCountries({ unemployment, population }),
    seededAt: new Date().toISOString(),
  };
}

// LUR (unemployment) is reported for ~100 countries while population (LP) is
// reported for ~210. Since buildLaborCountries unions the two, healthy runs
// yield ~210 countries. Require >=190 to reject partial snapshots; this still
// accommodates indicators that have slightly narrower reporting.
export function validate(data) {
  return typeof data?.countries === 'object' && Object.keys(data.countries).length >= 190;
}

export { CANONICAL_KEY, CACHE_TTL };

if (process.argv[1]?.endsWith('seed-imf-labor.mjs')) {
  runSeed('economic', 'imf-labor', CANONICAL_KEY, fetchImfLabor, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: `imf-sdmx-weo-${new Date().getFullYear()}`,
    recordCount: (data) => Object.keys(data?.countries ?? {}).length,
    emptyDataIsFailure: true,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
