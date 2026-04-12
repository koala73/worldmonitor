#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, loadSharedConfig } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const IMF_BASE = 'https://www.imf.org/external/datamapper/api/v1';
const CANONICAL_KEY = 'resilience:recovery:fiscal-space:v1';
const CACHE_TTL = 35 * 24 * 3600;

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

async function fetchImfIndicator(indicator) {
  const url = `${IMF_BASE}/${indicator}?periods=${weoYears().join(',')}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`IMF ${indicator}: HTTP ${resp.status}`);
  const data = await resp.json();
  return data?.values?.[indicator] ?? {};
}

function latestValue(byYear) {
  for (const year of weoYears()) {
    const v = Number(byYear?.[year]);
    if (Number.isFinite(v)) return { value: v, year: Number(year) };
  }
  return null;
}

async function fetchFiscalSpace() {
  const [revenueData, balanceData, debtData] = await Promise.all([
    fetchImfIndicator('GGR_G01_GDP_PT'),
    fetchImfIndicator('GGXCNL_G01_GDP_PT'),
    fetchImfIndicator('GGXWDG_NGDP_PT'),
  ]);

  const countries = {};
  const allIso3 = new Set([
    ...Object.keys(revenueData),
    ...Object.keys(balanceData),
    ...Object.keys(debtData),
  ]);

  for (const iso3 of allIso3) {
    if (isAggregate(iso3)) continue;
    const iso2 = ISO3_TO_ISO2[iso3];
    if (!iso2) continue;

    const rev = latestValue(revenueData[iso3]);
    const bal = latestValue(balanceData[iso3]);
    const debt = latestValue(debtData[iso3]);
    if (!rev && !bal && !debt) continue;

    countries[iso2] = {
      govRevenuePct: rev?.value ?? null,
      fiscalBalancePct: bal?.value ?? null,
      debtToGdpPct: debt?.value ?? null,
      year: rev?.year ?? bal?.year ?? debt?.year ?? null,
    };
  }

  return { countries, seededAt: new Date().toISOString() };
}

function validate(data) {
  return typeof data?.countries === 'object' && Object.keys(data.countries).length >= 150;
}

if (process.argv[1]?.endsWith('seed-recovery-fiscal-space.mjs')) {
  runSeed('resilience', 'recovery:fiscal-space', CANONICAL_KEY, fetchFiscalSpace, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: `imf-weo-fiscal-${new Date().getFullYear()}`,
    recordCount: (data) => Object.keys(data?.countries ?? {}).length,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
