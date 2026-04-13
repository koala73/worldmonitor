#!/usr/bin/env node
//
// IMF WEO — external balance, BOP & trade volumes
// Canonical key: economic:imf:external:v1
//
// Indicators:
//   BX        — Exports of goods & services, USD
//   BM        — Imports of goods & services, USD
//   BCA       — Current account balance, USD
//   TM_RPCH   — Volume of imports of goods & services, % change
//   TX_RPCH   — Volume of exports of goods & services, % change
//
// Per WorldMonitor #3027 — feeds Trade Flows card.

import { loadEnvFile, runSeed, loadSharedConfig, imfSdmxFetchIndicator } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'economic:imf:external:v1';
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

export function buildExternalCountries({
  exports = {},
  imports = {},
  currentAccount = {},
  importVol = {},
  exportVol = {},
}) {
  const countries = {};
  const allIso3 = new Set([
    ...Object.keys(exports),
    ...Object.keys(imports),
    ...Object.keys(currentAccount),
    ...Object.keys(importVol),
    ...Object.keys(exportVol),
  ]);
  for (const iso3 of allIso3) {
    if (isAggregate(iso3)) continue;
    const iso2 = ISO3_TO_ISO2[iso3];
    if (!iso2) continue;

    const ex   = latestValue(exports[iso3]);
    const im   = latestValue(imports[iso3]);
    const ca   = latestValue(currentAccount[iso3]);
    const tm   = latestValue(importVol[iso3]);
    const tx   = latestValue(exportVol[iso3]);

    if (!ex && !im && !ca && !tm && !tx) continue;

    const tradeBalance = ex && im && ex.year === im.year
      ? Number((ex.value - im.value).toFixed(3))
      : null;

    countries[iso2] = {
      exportsUsd:           ex?.value ?? null,
      importsUsd:           im?.value ?? null,
      tradeBalanceUsd:      tradeBalance,
      currentAccountUsd:    ca?.value ?? null,
      importVolumePctChg:   tm?.value ?? null,
      exportVolumePctChg:   tx?.value ?? null,
      year: ex?.year ?? im?.year ?? ca?.year ?? tm?.year ?? tx?.year ?? null,
    };
  }
  return countries;
}

export async function fetchImfExternal() {
  const years = weoYears();
  const [exports, imports, currentAccount, importVol, exportVol] = await Promise.all([
    imfSdmxFetchIndicator('BX', { years }),
    imfSdmxFetchIndicator('BM', { years }),
    imfSdmxFetchIndicator('BCA', { years }),
    imfSdmxFetchIndicator('TM_RPCH', { years }),
    imfSdmxFetchIndicator('TX_RPCH', { years }),
  ]);
  return {
    countries: buildExternalCountries({ exports, imports, currentAccount, importVol, exportVol }),
    seededAt: new Date().toISOString(),
  };
}

// IMF WEO external indicators (BX/BM/BCA) report ~210 countries. Require
// >=190 to reject partial snapshots where a bad IMF run silently drops
// dozens of countries.
export function validate(data) {
  return typeof data?.countries === 'object' && Object.keys(data.countries).length >= 190;
}

export { CANONICAL_KEY, CACHE_TTL };

if (process.argv[1]?.endsWith('seed-imf-external.mjs')) {
  runSeed('economic', 'imf-external', CANONICAL_KEY, fetchImfExternal, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: `imf-sdmx-weo-${new Date().getFullYear()}`,
    recordCount: (data) => Object.keys(data?.countries ?? {}).length,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
