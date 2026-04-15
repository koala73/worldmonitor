#!/usr/bin/env node
//
// IMF WEO — growth & per-capita aggregates
// Canonical key: economic:imf:growth:v1
//
// Indicators:
//   NGDP_RPCH   — Real GDP growth, % change
//   NGDPDPC     — Nominal GDP per capita, USD
//   NGDP_R      — Real GDP, national currency (constant prices)
//   PPPPC       — GDP per capita, PPP USD
//   PPPGDP      — GDP, PPP USD
//   NID_NGDP    — Total investment % GDP
//   NGSD_NGDP   — Gross national savings % GDP
//
// Per WorldMonitor #3027 — backfills CountryDeepDivePanel Economic
// Indicators + Country Facts tiles from the same SDMX 3.0 fetcher already
// used by seed-imf-macro.mjs.

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

export function buildGrowthCountries(perIndicator) {
  const {
    realGdpGrowth = {},
    nominalGdpPerCapita = {},
    realGdp = {},
    pppPerCapita = {},
    pppGdp = {},
    investmentPct = {},
    savingsPct = {},
  } = perIndicator;

  const countries = {};
  const allIso3 = new Set([
    ...Object.keys(realGdpGrowth),
    ...Object.keys(nominalGdpPerCapita),
    ...Object.keys(realGdp),
    ...Object.keys(pppPerCapita),
    ...Object.keys(pppGdp),
    ...Object.keys(investmentPct),
    ...Object.keys(savingsPct),
  ]);

  for (const iso3 of allIso3) {
    if (isAggregate(iso3)) continue;
    const iso2 = ISO3_TO_ISO2[iso3];
    if (!iso2) continue;

    const growth   = latestValue(realGdpGrowth[iso3]);
    const gdpPc    = latestValue(nominalGdpPerCapita[iso3]);
    const realGdpV = latestValue(realGdp[iso3]);
    const pppPc    = latestValue(pppPerCapita[iso3]);
    const pppGdpV  = latestValue(pppGdp[iso3]);
    const inv      = latestValue(investmentPct[iso3]);
    const sav      = latestValue(savingsPct[iso3]);

    if (!growth && !gdpPc && !realGdpV && !pppPc && !pppGdpV && !inv && !sav) continue;

    // savings - investment gap is a leading indicator for BOP pressure.
    const savInvGap = inv && sav ? Number((sav.value - inv.value).toFixed(2)) : null;

    countries[iso2] = {
      realGdpGrowthPct:   growth?.value ?? null,
      gdpPerCapitaUsd:    gdpPc?.value ?? null,
      realGdp:            realGdpV?.value ?? null,
      gdpPerCapitaPpp:    pppPc?.value ?? null,
      gdpPpp:             pppGdpV?.value ?? null,
      investmentPct:      inv?.value ?? null,
      savingsPct:         sav?.value ?? null,
      savingsInvestmentGap: savInvGap,
      year: growth?.year ?? gdpPc?.year ?? realGdpV?.year ?? pppPc?.year ?? pppGdpV?.year ?? inv?.year ?? sav?.year ?? null,
    };
  }
  return countries;
}

export async function fetchImfGrowth() {
  const years = weoYears();
  const [
    realGdpGrowth,
    nominalGdpPerCapita,
    realGdp,
    pppPerCapita,
    pppGdp,
    investmentPct,
    savingsPct,
  ] = await Promise.all([
    imfSdmxFetchIndicator('NGDP_RPCH', { years }),
    imfSdmxFetchIndicator('NGDPDPC', { years }),
    imfSdmxFetchIndicator('NGDP_R', { years }),
    imfSdmxFetchIndicator('PPPPC', { years }),
    imfSdmxFetchIndicator('PPPGDP', { years }),
    imfSdmxFetchIndicator('NID_NGDP', { years }),
    imfSdmxFetchIndicator('NGSD_NGDP', { years }),
  ]);

  const countries = buildGrowthCountries({
    realGdpGrowth,
    nominalGdpPerCapita,
    realGdp,
    pppPerCapita,
    pppGdp,
    investmentPct,
    savingsPct,
  });

  return { countries, seededAt: new Date().toISOString() };
}

// IMF WEO growth indicators report ~210 countries. Require >=190 to reject
// partial snapshots where a bad IMF run silently drops dozens of countries.
export function validate(data) {
  return typeof data?.countries === 'object' && Object.keys(data.countries).length >= 190;
}

export { CANONICAL_KEY, CACHE_TTL };

export function declareRecords(data) {
  return Object.keys(data?.countries || {}).length;
}

if (process.argv[1]?.endsWith('seed-imf-growth.mjs')) {
  runSeed('economic', 'imf-growth', CANONICAL_KEY, fetchImfGrowth, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: `imf-sdmx-weo-${new Date().getFullYear()}`,
    recordCount: (data) => Object.keys(data?.countries ?? {}).length,
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
