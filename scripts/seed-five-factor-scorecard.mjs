#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';
import { getRedisCredentials, loadEnvFile, loadSharedConfig, runSeed } from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import { listRankableCountries } from './shared/rankable-universe.mjs';
register();

// The Railway closure audit intentionally models a plain Node process for
// scripts-root Nixpacks services. This seeder self-registers tsx before its
// dynamic import, so declare the TypeScript module closure that _snapshot.ts
// imports. Each annotation is an exact deploy dependency, not a broad watch.
// @railway-runtime-dependency ./scorecard/v1/_input-registry.mts
// @railway-runtime-dependency ./scorecard/v1/_methodology.mts
// @railway-runtime-dependency ./scorecard/v1/_score-country.mts
// @railway-runtime-dependency ./scorecard/v1/_source-adapters.mts
// @railway-runtime-dependency ./scorecard/v1/_types.mts

const {
  buildFiveFactorSnapshot,
  FIVE_FACTOR_SCORECARD_KEY,
  scorecardSnapshotBytes,
  validateFiveFactorSnapshot,
} = await import('./scorecard/v1/_snapshot.mts');

loadEnvFile(import.meta.url);

export const SCORECARD_TTL_SECONDS = 3 * 24 * 3600;
export const SCORECARD_MAX_STALE_MIN = 36 * 60;

const FIXED_SOURCES = {
  population: 'economic:imf:labor:v1',
  foodStocks: 'resilience:food-stocks:v1',
  demographics: 'demographics:capability:v1',
  defense: 'military:industrial-base:v1',
  energyMix: 'energy:mix:v1:_all',
  lowCarbon: 'resilience:low-carbon-generation:v1',
  powerLosses: 'resilience:power-losses:v1',
  importHhi: 'resilience:recovery:import-hhi:v1',
  tech: 'economic:worldbank-techreadiness:v1',
};

function parseStored(value) {
  if (value == null) return null;
  try {
    return unwrapEnvelope(JSON.parse(value)).data;
  } catch {
    return null;
  }
}

async function redisPipeline(commands) {
  const { url, token } = getRedisCredentials();
  const response = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'WorldMonitor-Seed/1.0 (https://worldmonitor.app)',
    },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`scorecard source pipeline HTTP ${response.status}`);
  return response.json();
}

function techByIso2(rankings) {
  const iso3ToIso2 = loadSharedConfig('iso3-to-iso2.json');
  return Object.fromEntries((Array.isArray(rankings) ? rankings : [])
    .map((entry) => [iso3ToIso2[String(entry?.country || '').toUpperCase()], entry])
    .filter(([iso2]) => /^[A-Z]{2}$/.test(iso2 || '')));
}

export async function readScorecardSources(countryCodes = listRankableCountries()) {
  const fixedEntries = Object.entries(FIXED_SOURCES);
  const keys = [
    ...fixedEntries.map(([, key]) => key),
    ...countryCodes.map((countryCode) => `resilience:static:${countryCode}`),
  ];
  const response = await redisPipeline(keys.map((key) => ['GET', key]));
  if (!Array.isArray(response) || response.length !== keys.length) {
    throw new Error(`scorecard source pipeline returned ${response?.length ?? 0}/${keys.length} rows`);
  }
  const values = response.map((entry) => parseStored(entry?.result));
  const fixedValues = Object.fromEntries(fixedEntries.map(([name], index) => [name, values[index]]));
  const staticOffset = fixedEntries.length;
  const staticByCountry = Object.fromEntries(countryCodes
    .map((countryCode, index) => [countryCode, values[staticOffset + index]])
    .filter(([, value]) => value != null));
  return {
    population: fixedValues.population,
    foodStocks: fixedValues.foodStocks,
    demographics: fixedValues.demographics,
    defense: fixedValues.defense,
    energyMix: fixedValues.energyMix,
    staticByCountry: Object.keys(staticByCountry).length > 0 ? staticByCountry : null,
    lowCarbon: fixedValues.lowCarbon,
    powerLosses: fixedValues.powerLosses,
    importHhi: fixedValues.importHhi,
    techByIso2: fixedValues.tech ? techByIso2(fixedValues.tech) : null,
  };
}

export async function buildScorecardSeedSnapshot({
  countryCodes = listRankableCountries(),
  now = () => new Date(),
  readSources = readScorecardSources,
} = {}) {
  const sources = await readSources(countryCodes);
  const snapshot = buildFiveFactorSnapshot(countryCodes, sources, now().toISOString());
  console.log(`[scorecard] ${countryCodes.length} countries, ${scorecardSnapshotBytes(snapshot)} bytes`);
  return snapshot;
}

export function declareScorecardRecords(snapshot) {
  return Object.keys(snapshot?.countries || {}).length;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  if (process.argv.includes('--dry-run')) {
    const snapshot = await buildScorecardSeedSnapshot();
    if (!validateFiveFactorSnapshot(snapshot)) throw new Error('dry-run snapshot validation failed');
    console.log('[scorecard] dry-run valid; Redis was not modified');
  } else runSeed('scorecard', 'five-factor', FIVE_FACTOR_SCORECARD_KEY, buildScorecardSeedSnapshot, {
    validateFn: validateFiveFactorSnapshot,
    ttlSeconds: SCORECARD_TTL_SECONDS,
    declareRecords: declareScorecardRecords,
    sourceVersion: 'five-factor-scorecard-1.0.0',
    schemaVersion: 1,
    maxStaleMin: SCORECARD_MAX_STALE_MIN,
    lockTtlMs: 60_000,
    fetchPhaseTimeoutMs: 25_000,
    emptyDataIsFailure: true,
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
