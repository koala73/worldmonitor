#!/usr/bin/env node
//
// IMF WEO — external balance, BOP & trade volumes
// Canonical key: economic:imf:external:v1
//
// Indicators:
//   BCA       — Current account balance, USD (broad coverage, ~209 countries)
//   TM_RPCH   — Volume of imports of goods & services, % change (~189 countries)
//   TX_RPCH   — Volume of exports of goods & services, % change (~190 countries)
//
// NOTE: BX/BM (export/import LEVELS in USD) were dropped 2026-04 — WEO
// currently publishes these for only ~10 countries, so joining on them
// collapsed the result set below the 190-country validate floor and the
// whole seed was rejected on every run. If WEO republishes BX/BM with
// broader coverage, re-add them + restore the tradeBalance join.
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
  currentAccount = {},
  importVol = {},
  exportVol = {},
}) {
  const countries = {};
  const allIso3 = new Set([
    ...Object.keys(currentAccount),
    ...Object.keys(importVol),
    ...Object.keys(exportVol),
  ]);
  for (const iso3 of allIso3) {
    if (isAggregate(iso3)) continue;
    const iso2 = ISO3_TO_ISO2[iso3];
    if (!iso2) continue;

    const ca = latestValue(currentAccount[iso3]);
    const tm = latestValue(importVol[iso3]);
    const tx = latestValue(exportVol[iso3]);

    if (!ca && !tm && !tx) continue;

    countries[iso2] = {
      // BX/BM dropped — WEO coverage is ~10 countries. Fields kept as null so
      // downstream consumers that probed for their presence see an explicit
      // gap rather than a missing field.
      exportsUsd:         null,
      importsUsd:         null,
      tradeBalanceUsd:    null,
      currentAccountUsd:  ca?.value ?? null,
      importVolumePctChg: tm?.value ?? null,
      exportVolumePctChg: tx?.value ?? null,
      year: ca?.year ?? tm?.year ?? tx?.year ?? null,
    };
  }
  return countries;
}

export async function fetchImfExternal() {
  const years = weoYears();
  const [currentAccount, importVol, exportVol] = await Promise.all([
    imfSdmxFetchIndicator('BCA', { years }),
    imfSdmxFetchIndicator('TM_RPCH', { years }),
    imfSdmxFetchIndicator('TX_RPCH', { years }),
  ]);
  return {
    countries: buildExternalCountries({ currentAccount, importVol, exportVol }),
    seededAt: new Date().toISOString(),
  };
}

// BCA ~209 / TM_RPCH ~189 / TX_RPCH ~190. The union typically yields 189-210
// non-aggregate countries. 180 is a safe floor that rejects a broken IMF run
// while absorbing normal per-indicator sparseness.
export function validate(data) {
  return typeof data?.countries === 'object' && Object.keys(data.countries).length >= 180;
}

export { CANONICAL_KEY, CACHE_TTL };

export function declareRecords(data) {
  return Object.keys(data?.countries || {}).length;
}

if (process.argv[1]?.endsWith('seed-imf-external.mjs')) {
  runSeed('economic', 'imf-external', CANONICAL_KEY, fetchImfExternal, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: `imf-sdmx-weo-${new Date().getFullYear()}`,
    recordCount: (data) => Object.keys(data?.countries ?? {}).length,
    // Empty/short result = real upstream failure (floor is 180 countries).
    // Without this, a single transient fetch glitch refreshes seed-meta and
    // locks the bundle out for 30 days (see log 2026-04-13).
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
