#!/usr/bin/env node

import { loadEnvFile, runSeed, loadSharedConfig, imfSdmxFetchIndicator } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'economic:imf:external:v1';
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

export function buildImfExternalCountries({
  exportsData,
  importsData,
  currentAccountData,
  importVolumeGrowthData,
  exportVolumeGrowthData,
}) {
  const countries = {};
  const allIso3 = new Set([
    ...Object.keys(exportsData),
    ...Object.keys(importsData),
    ...Object.keys(currentAccountData),
    ...Object.keys(importVolumeGrowthData),
    ...Object.keys(exportVolumeGrowthData),
  ]);

  for (const iso3 of allIso3) {
    if (isAggregate(iso3)) continue;
    const iso2 = ISO3_TO_ISO2[iso3];
    if (!iso2) continue;

    const exportsUsd = latestValue(exportsData[iso3]);
    const importsUsd = latestValue(importsData[iso3]);
    const currentAccountUsd = latestValue(currentAccountData[iso3]);
    const importVolumeGrowth = latestValue(importVolumeGrowthData[iso3]);
    const exportVolumeGrowth = latestValue(exportVolumeGrowthData[iso3]);

    if (!exportsUsd && !importsUsd && !currentAccountUsd && !importVolumeGrowth && !exportVolumeGrowth) continue;

    countries[iso2] = {
      exportsUsd: exportsUsd?.value ?? null,
      importsUsd: importsUsd?.value ?? null,
      currentAccountUsd: currentAccountUsd?.value ?? null,
      importVolumeGrowthPct: importVolumeGrowth?.value ?? null,
      exportVolumeGrowthPct: exportVolumeGrowth?.value ?? null,
      tradeBalanceUsd:
        exportsUsd?.value != null && importsUsd?.value != null
          ? Number((exportsUsd.value - importsUsd.value).toFixed(2))
          : null,
      year:
        exportsUsd?.year
        ?? importsUsd?.year
        ?? currentAccountUsd?.year
        ?? importVolumeGrowth?.year
        ?? exportVolumeGrowth?.year
        ?? null,
    };
  }

  return countries;
}

async function fetchImfExternal() {
  const years = weoYears();
  const [
    exportsData,
    importsData,
    currentAccountData,
    importVolumeGrowthData,
    exportVolumeGrowthData,
  ] = await Promise.all([
    imfSdmxFetchIndicator('BX', { years }),
    imfSdmxFetchIndicator('BM', { years }),
    imfSdmxFetchIndicator('BCA', { years }),
    imfSdmxFetchIndicator('TM_RPCH', { years }),
    imfSdmxFetchIndicator('TX_RPCH', { years }),
  ]);

  const countries = buildImfExternalCountries({
    exportsData,
    importsData,
    currentAccountData,
    importVolumeGrowthData,
    exportVolumeGrowthData,
  });

  return { countries, seededAt: new Date().toISOString() };
}

function validate(data) {
  return typeof data?.countries === 'object' && Object.keys(data.countries).length >= 150;
}

if (process.argv[1]?.endsWith('seed-imf-external.mjs')) {
  runSeed('economic', 'imf-external', CANONICAL_KEY, fetchImfExternal, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: `imf-sdmx-weo-external-${new Date().getFullYear()}`,
    recordCount: (data) => Object.keys(data?.countries ?? {}).length,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
