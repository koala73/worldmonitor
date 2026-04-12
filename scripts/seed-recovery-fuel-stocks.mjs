#!/usr/bin/env node

import { loadEnvFile, runSeed, getRedisCredentials } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'resilience:recovery:fuel-stocks:v1';
const CACHE_TTL = 90 * 24 * 3600;
const IEA_SOURCE_KEY = 'energy:iea-oil-stocks:v1:index';

export function computeFuelStockDays(members) {
  const countries = {};
  for (const m of members) {
    if (!m.iso2 || m.netExporter) continue;
    const days = m.daysOfCover;
    if (days === null || days === undefined) continue;
    // Derive both flags from `days` consistently to avoid contradiction
    // when the source carries a stale belowObligation value.
    countries[m.iso2] = {
      fuelStockDays: days,
      meetsObligation: days >= 90,
      belowObligation: days < 90,
    };
  }
  return countries;
}

async function fetchFromRedis(key) {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.result ? JSON.parse(data.result) : null;
}

async function fetchFuelStocks() {
  const ieaIndex = await fetchFromRedis(IEA_SOURCE_KEY);
  if (!ieaIndex || !Array.isArray(ieaIndex.members) || ieaIndex.members.length === 0) {
    throw new Error(`IEA source key ${IEA_SOURCE_KEY} is empty or missing; run seed-iea-oil-stocks.mjs first`);
  }

  const countries = computeFuelStockDays(ieaIndex.members);
  const countryCount = Object.keys(countries).length;
  console.log(`[seed] fuel-stocks: derived ${countryCount} countries from IEA index (dataMonth: ${ieaIndex.dataMonth ?? 'unknown'})`);

  return {
    countries,
    dataMonth: ieaIndex.dataMonth ?? null,
    seededAt: new Date().toISOString(),
  };
}

function validate(data) {
  return typeof data?.countries === 'object' && Object.keys(data.countries).length >= 15;
}

if (process.argv[1]?.endsWith('seed-recovery-fuel-stocks.mjs')) {
  runSeed('resilience', 'recovery:fuel-stocks', CANONICAL_KEY, fetchFuelStocks, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: `iea-derived-fuel-stocks-${new Date().getFullYear()}`,
    recordCount: (data) => Object.keys(data?.countries ?? {}).length,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
