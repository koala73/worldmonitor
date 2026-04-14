#!/usr/bin/env node

import { loadEnvFile, runSeed, loadSharedConfig, imfSdmxFetchIndicator } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'economic:imf:macro:v2';
const CACHE_TTL = 35 * 24 * 3600; // 35 days — monthly IMF WEO release

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

async function fetchImfMacro() {
  const years = weoYears();
  const [
    inflationData,
    currentAccountData,
    govRevenueData,
    cpiIndexData,
    cpiEopData,
    govExpData,
    primaryBalanceData,
  ] = await Promise.all([
    imfSdmxFetchIndicator('PCPIPCH', { years }),     // CPI inflation, period avg %
    imfSdmxFetchIndicator('BCA_NGDPD', { years }),    // Current account % GDP
    imfSdmxFetchIndicator('GGR_NGDP', { years }),     // Gov revenue % GDP
    imfSdmxFetchIndicator('PCPI', { years }),         // CPI index level
    imfSdmxFetchIndicator('PCPIEPCH', { years }),     // CPI inflation, end-of-period %
    imfSdmxFetchIndicator('GGX_NGDP', { years }),     // Gov total expenditure % GDP
    imfSdmxFetchIndicator('GGXONLB_NGDP', { years }), // Gov primary net lending/borrowing % GDP
  ]);

  const countries = {};
  const allIso3 = new Set([
    ...Object.keys(inflationData),
    ...Object.keys(currentAccountData),
    ...Object.keys(govRevenueData),
    ...Object.keys(cpiIndexData),
    ...Object.keys(cpiEopData),
    ...Object.keys(govExpData),
    ...Object.keys(primaryBalanceData),
  ]);

  for (const iso3 of allIso3) {
    if (isAggregate(iso3)) continue;
    const iso2 = ISO3_TO_ISO2[iso3];
    if (!iso2) continue;

    const infl    = latestValue(inflationData[iso3]);
    const ca      = latestValue(currentAccountData[iso3]);
    const rev     = latestValue(govRevenueData[iso3]);
    const cpi     = latestValue(cpiIndexData[iso3]);
    const cpiEop  = latestValue(cpiEopData[iso3]);
    const govExp  = latestValue(govExpData[iso3]);
    const primBal = latestValue(primaryBalanceData[iso3]);

    if (!infl && !ca && !rev && !cpi && !cpiEop && !govExp && !primBal) continue;

    countries[iso2] = {
      inflationPct:        infl?.value ?? null,
      currentAccountPct:   ca?.value ?? null,
      govRevenuePct:       rev?.value ?? null,
      cpiIndex:            cpi?.value ?? null,
      cpiEopPct:           cpiEop?.value ?? null,
      govExpenditurePct:   govExp?.value ?? null,
      primaryBalancePct:   primBal?.value ?? null,
      year: infl?.year ?? ca?.year ?? rev?.year ?? cpi?.year ?? cpiEop?.year ?? govExp?.year ?? primBal?.year ?? null,
    };
  }

  return { countries, seededAt: new Date().toISOString() };
}

function validate(data) {
  return typeof data?.countries === 'object' && Object.keys(data.countries).length >= 150;
}

// Exported for tests
export { fetchImfMacro, latestValue, isAggregate, CANONICAL_KEY, CACHE_TTL };

// Guard: only run when executed directly, not when imported by tests
if (process.argv[1]?.endsWith('seed-imf-macro.mjs')) {
  runSeed('economic', 'imf-macro', CANONICAL_KEY, fetchImfMacro, {
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
