#!/usr/bin/env node

import { loadEnvFile, runSeed, loadSharedConfig, imfSdmxFetchIndicator } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'economic:imf:growth:v1';
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

export function buildImfGrowthCountries({
  realGdpGrowthData,
  nominalGdpPerCapitaData,
  realGdpLocalData,
  pppPerCapitaData,
  pppGdpData,
  investmentData,
  savingsData,
}) {
  const countries = {};
  const allIso3 = new Set([
    ...Object.keys(realGdpGrowthData),
    ...Object.keys(nominalGdpPerCapitaData),
    ...Object.keys(realGdpLocalData),
    ...Object.keys(pppPerCapitaData),
    ...Object.keys(pppGdpData),
    ...Object.keys(investmentData),
    ...Object.keys(savingsData),
  ]);

  for (const iso3 of allIso3) {
    if (isAggregate(iso3)) continue;
    const iso2 = ISO3_TO_ISO2[iso3];
    if (!iso2) continue;

    const growth = latestValue(realGdpGrowthData[iso3]);
    const gdpPerCapita = latestValue(nominalGdpPerCapitaData[iso3]);
    const realGdpLocal = latestValue(realGdpLocalData[iso3]);
    const pppPerCapita = latestValue(pppPerCapitaData[iso3]);
    const pppGdp = latestValue(pppGdpData[iso3]);
    const investment = latestValue(investmentData[iso3]);
    const savings = latestValue(savingsData[iso3]);

    if (!growth && !gdpPerCapita && !realGdpLocal && !pppPerCapita && !pppGdp && !investment && !savings) continue;

    countries[iso2] = {
      realGdpGrowthPct: growth?.value ?? null,
      nominalGdpPerCapitaUsd: gdpPerCapita?.value ?? null,
      realGdpLocal: realGdpLocal?.value ?? null,
      pppGdpPerCapita: pppPerCapita?.value ?? null,
      pppGdp: pppGdp?.value ?? null,
      investmentPctGdp: investment?.value ?? null,
      savingsPctGdp: savings?.value ?? null,
      savingsInvestmentGapPctGdp:
        savings?.value != null && investment?.value != null
          ? Number((savings.value - investment.value).toFixed(2))
          : null,
      year:
        growth?.year
        ?? gdpPerCapita?.year
        ?? realGdpLocal?.year
        ?? pppPerCapita?.year
        ?? pppGdp?.year
        ?? investment?.year
        ?? savings?.year
        ?? null,
    };
  }

  return countries;
}

async function fetchImfGrowth() {
  const years = weoYears();
  const [
    realGdpGrowthData,
    nominalGdpPerCapitaData,
    realGdpLocalData,
    pppPerCapitaData,
    pppGdpData,
    investmentData,
    savingsData,
  ] = await Promise.all([
    imfSdmxFetchIndicator('NGDP_RPCH', { years }),
    imfSdmxFetchIndicator('NGDPDPC', { years }),
    imfSdmxFetchIndicator('NGDP_R', { years }),
    imfSdmxFetchIndicator('PPPPC', { years }),
    imfSdmxFetchIndicator('PPPGDP', { years }),
    imfSdmxFetchIndicator('NID_NGDP', { years }),
    imfSdmxFetchIndicator('NGSD_NGDP', { years }),
  ]);

  const countries = buildImfGrowthCountries({
    realGdpGrowthData,
    nominalGdpPerCapitaData,
    realGdpLocalData,
    pppPerCapitaData,
    pppGdpData,
    investmentData,
    savingsData,
  });

  return { countries, seededAt: new Date().toISOString() };
}

function validate(data) {
  return typeof data?.countries === 'object' && Object.keys(data.countries).length >= 150;
}

if (process.argv[1]?.endsWith('seed-imf-growth.mjs')) {
  runSeed('economic', 'imf-growth', CANONICAL_KEY, fetchImfGrowth, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: `imf-sdmx-weo-growth-${new Date().getFullYear()}`,
    recordCount: (data) => Object.keys(data?.countries ?? {}).length,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
