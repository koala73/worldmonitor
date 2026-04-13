#!/usr/bin/env node

import { loadEnvFile, runSeed, loadSharedConfig, imfSdmxFetchIndicator } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'economic:imf:labor:v1';
const CACHE_TTL = 35 * 24 * 3600; // 35 days — monthly IMF WEO release cadence

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

export function buildImfLaborCountries({ unemploymentData, populationData }) {
  const countries = {};
  const allIso3 = new Set([...Object.keys(unemploymentData), ...Object.keys(populationData)]);

  for (const iso3 of allIso3) {
    if (isAggregate(iso3)) continue;
    const iso2 = ISO3_TO_ISO2[iso3];
    if (!iso2) continue;

    const unemployment = latestValue(unemploymentData[iso3]);
    const population = latestValue(populationData[iso3]);
    if (!unemployment && !population) continue;

    countries[iso2] = {
      unemploymentPct: unemployment?.value ?? null,
      populationMillions: population?.value ?? null,
      year: unemployment?.year ?? population?.year ?? null,
    };
  }

  return countries;
}

async function fetchImfLabor() {
  const years = weoYears();
  const [unemploymentData, populationData] = await Promise.all([
    imfSdmxFetchIndicator('LUR', { years }),
    imfSdmxFetchIndicator('LP', { years }),
  ]);

  const countries = buildImfLaborCountries({ unemploymentData, populationData });
  return { countries, seededAt: new Date().toISOString() };
}

function validate(data) {
  return typeof data?.countries === 'object' && Object.keys(data.countries).length >= 150;
}

if (process.argv[1]?.endsWith('seed-imf-labor.mjs')) {
  runSeed('economic', 'imf-labor', CANONICAL_KEY, fetchImfLabor, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: `imf-sdmx-weo-labor-${new Date().getFullYear()}`,
    recordCount: (data) => Object.keys(data?.countries ?? {}).length,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
