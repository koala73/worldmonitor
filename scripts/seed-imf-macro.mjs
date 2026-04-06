#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, loadSharedConfig } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const IMF_BASE = 'https://www.imf.org/external/datamapper/api/v1';
const CANONICAL_KEY = 'economic:imf:macro:v1';
const CACHE_TTL = 35 * 24 * 3600; // 35 days — monthly IMF WEO release

// Invert iso2→iso3 map to convert IMF's ISO3 codes to our ISO2 keys.
// loadSharedConfig tries ../shared/ (local dev) then ./shared/ (Railway rootDirectory=scripts).
const ISO2_TO_ISO3 = loadSharedConfig('iso2-to-iso3.json');
const ISO3_TO_ISO2 = Object.fromEntries(Object.entries(ISO2_TO_ISO3).map(([k, v]) => [v, k]));

// IMF WEO regional aggregate and non-sovereign codes
const AGGREGATE_CODES = new Set([
  'ADVEC', 'EMEDE', 'EURO', 'MECA', 'OEMDC', 'WEOWORLD', 'EU',
  'AS5', 'DA', 'EDE', 'MAE', 'OAE', 'SSA', 'WE', 'EMDE', 'G20',
]);

function isAggregate(code) {
  if (!code || code.length !== 3) return true;
  return AGGREGATE_CODES.has(code) || code.endsWith('Q');
}

// Request the three most-recent years at call time so the monthly cron always picks up the
// latest WEO vintage without requiring a code edit (e.g. 2025,2024,2023 once 2025 publishes).
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

// Pick the most recent year with a finite value, searching newest-first.
function latestValue(byYear) {
  for (const year of weoYears()) {
    const v = Number(byYear?.[year]);
    if (Number.isFinite(v)) return { value: v, year: Number(year) };
  }
  return null;
}

async function fetchImfMacro() {
  const [inflationData, currentAccountData] = await Promise.all([
    fetchImfIndicator('PCPIPCH'),   // CPI inflation, annual % change
    fetchImfIndicator('BCA_NGDPD'), // Current account balance, % of GDP
  ]);

  const countries = {};
  const allIso3 = new Set([...Object.keys(inflationData), ...Object.keys(currentAccountData)]);

  for (const iso3 of allIso3) {
    if (isAggregate(iso3)) continue;
    const iso2 = ISO3_TO_ISO2[iso3];
    if (!iso2) continue;

    const infl = latestValue(inflationData[iso3]);
    const ca = latestValue(currentAccountData[iso3]);
    if (!infl && !ca) continue;

    countries[iso2] = {
      inflationPct: infl?.value ?? null,
      currentAccountPct: ca?.value ?? null,
      year: infl?.year ?? ca?.year ?? null,
    };
  }

  return { countries, seededAt: new Date().toISOString() };
}

function validate(data) {
  return typeof data?.countries === 'object' && Object.keys(data.countries).length >= 150;
}

// Guard: only run when executed directly, not when imported by tests
if (process.argv[1]?.endsWith('seed-imf-macro.mjs')) {
  runSeed('economic', 'imf-macro', CANONICAL_KEY, fetchImfMacro, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: `imf-weo-${new Date().getFullYear()}`,
    recordCount: (data) => Object.keys(data?.countries ?? {}).length,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
