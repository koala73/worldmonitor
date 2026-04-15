#!/usr/bin/env node

import {
  acquireLockSafely,
  extendExistingTtl,
  getRedisCredentials,
  loadEnvFile,
  logSeedResult,
  releaseLock,
} from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';

loadEnvFile(import.meta.url);

// ── Constants ─────────────────────────────────────────────────────────────────

export const SPINE_KEY_PREFIX = 'energy:spine:v1:';
export const SPINE_COUNTRIES_KEY = 'energy:spine:v1:_countries';
export const SPINE_META_KEY = 'seed-meta:energy:spine';
export const SPINE_TTL_SECONDS = 172800; // 48h — 2× daily cron interval

const LOCK_DOMAIN = 'energy:spine';
const LOCK_TTL_MS = 20 * 60 * 1000; // 20 min (pipeline write of 200+ countries)
const MIN_COVERAGE_RATIO = 0.80; // abort if new spine < 80% of previous country count

// Countries with Comtrade reporter codes for shock model inputs.
// Only these 6 reporters are seeded in comtrade:flows; must stay in sync with
// compute-energy-shock.ts ISO2_TO_COMTRADE.
const ISO2_TO_COMTRADE = {
  US: '842',
  CN: '156',
  RU: '643',
  IR: '364',
  IN: '699',
  TW: '490',
};

// Chokepoints supported by the shock model for comtrade-mapped countries.
const SHOCK_CHOKEPOINTS = ['hormuz', 'malacca', 'suez', 'babelm'];

// ── Redis helpers ─────────────────────────────────────────────────────────────

async function redisPipeline(commands) {
  const { url, token } = getRedisCredentials();
  const response = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Redis pipeline failed: HTTP ${response.status} — ${text.slice(0, 200)}`);
  }
  return response.json();
}

async function redisGet(key) {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.result ? unwrapEnvelope(JSON.parse(data.result)).data : null;
}

async function redisMget(keys) {
  if (keys.length === 0) return [];
  const { url, token } = getRedisCredentials();
  const pipeline = keys.map(k => ['GET', k]);
  const response = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(pipeline),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Redis mget failed: HTTP ${response.status} — ${text.slice(0, 200)}`);
  }
  const results = await response.json();
  return results.map(r => {
    const raw = r?.result;
    if (!raw) return null;
    try { return unwrapEnvelope(JSON.parse(raw)).data; } catch { return null; }
  });
}

// ── Country list assembly ─────────────────────────────────────────────────────

async function assembleCountryList() {
  const [jodiOilCountries, owidCountries, emberAll] = await Promise.allSettled([
    redisGet('energy:jodi-oil:v1:_countries'),
    redisGet('energy:mix:v1:_countries'),
    redisGet('energy:ember:v1:_all'),
  ]);

  const jodiList = jodiOilCountries.status === 'fulfilled' && Array.isArray(jodiOilCountries.value)
    ? jodiOilCountries.value
    : [];
  const owidList = owidCountries.status === 'fulfilled' && Array.isArray(owidCountries.value)
    ? owidCountries.value
    : [];
  const emberList = emberAll.status === 'fulfilled' && emberAll.value && typeof emberAll.value === 'object'
    ? Object.keys(emberAll.value)
    : [];

  const union = new Set([...jodiList, ...owidList, ...emberList]);
  const countries = [...union].filter(iso2 => typeof iso2 === 'string' && iso2.length === 2);
  return { countries, jodiCount: jodiList.length, owidCount: owidList.length };
}

// ── Spine assembly for a single country ──────────────────────────────────────

function checkIeaAvailability(ieaStocks) {
  if (!ieaStocks) return false;
  return ieaStocks.netExporter === true ||
    (ieaStocks.daysOfCover != null && ieaStocks.anomaly !== true);
}

function buildOilFields(jodiOil, ieaStocks, hasIeaStocks) {
  return {
    crudeImportsKbd: jodiOil ? (jodiOil.crude?.importsKbd ?? 0) : 0,
    gasolineDemandKbd: jodiOil ? (jodiOil.gasoline?.demandKbd ?? 0) : 0,
    gasolineImportsKbd: jodiOil ? (jodiOil.gasoline?.importsKbd ?? 0) : 0,
    dieselDemandKbd: jodiOil ? (jodiOil.diesel?.demandKbd ?? 0) : 0,
    dieselImportsKbd: jodiOil ? (jodiOil.diesel?.importsKbd ?? 0) : 0,
    jetDemandKbd: jodiOil ? (jodiOil.jet?.demandKbd ?? 0) : 0,
    jetImportsKbd: jodiOil ? (jodiOil.jet?.importsKbd ?? 0) : 0,
    lpgDemandKbd: jodiOil ? (jodiOil.lpg?.demandKbd ?? 0) : 0,
    lpgImportsKbd: jodiOil ? (jodiOil.lpg?.importsKbd ?? 0) : 0,
    daysOfCover: hasIeaStocks ? (ieaStocks.daysOfCover ?? 0) : 0,
    netExporter: ieaStocks?.netExporter === true,
    belowObligation: ieaStocks?.belowObligation === true,
  };
}

function buildGasFields(jodiGas) {
  if (!jodiGas) return { lngImportsTj: 0, pipeImportsTj: 0, totalDemandTj: 0, lngShareOfImports: 0 };
  return {
    lngImportsTj: jodiGas.lngImportsTj ?? 0,
    pipeImportsTj: jodiGas.pipeImportsTj ?? 0,
    totalDemandTj: jodiGas.totalDemandTj ?? 0,
    lngShareOfImports: jodiGas.lngShareOfImports ?? 0,
  };
}

function buildMixFields(mix) {
  if (!mix) return { coalShare: 0, gasShare: 0, oilShare: 0, nuclearShare: 0, renewShare: 0, windShare: 0, solarShare: 0, hydroShare: 0, importShare: 0 };
  return {
    coalShare: mix.coalShare ?? 0,
    gasShare: mix.gasShare ?? 0,
    oilShare: mix.oilShare ?? 0,
    nuclearShare: mix.nuclearShare ?? 0,
    renewShare: mix.renewShare ?? 0,
    windShare: mix.windShare ?? 0,
    solarShare: mix.solarShare ?? 0,
    hydroShare: mix.hydroShare ?? 0,
    importShare: mix.importShare ?? 0,
  };
}

function buildSourceTimestamps(mix, jodiOil, jodiGas, ieaStocks, ember) {
  return {
    mixYear: mix ? (mix.year ?? null) : null,
    jodiOilMonth: jodiOil ? (jodiOil.dataMonth ?? null) : null,
    jodiGasMonth: jodiGas ? (jodiGas.dataMonth ?? null) : null,
    ieaStocksMonth: ieaStocks ? (ieaStocks.dataMonth ?? null) : null,
    emberMonth: ember ? (ember.dataMonth ?? null) : null,
  };
}

/**
 * Build the canonical spine object for one country from its six domain keys.
 * All domain values are validated for required fields before writing.
 * Throws on schema sentinel violation (e.g., OWID mix missing coalShare).
 */
// electricity prices and gasStorage are intentionally excluded from the spine
// (they update sub-daily; the spine seeds once at 06:00 UTC). However, Ember
// monthly generation mix IS included — it updates at most twice monthly.
export function buildSpineEntry(iso2, { mix, jodiOil, jodiGas, ieaStocks, ember = null, sprPolicy = null }) {
  // Schema sentinel: OWID mix must have coalShare field if data is present
  if (mix != null && !('coalShare' in mix)) {
    throw new Error(`OWID mix schema changed for ${iso2} — missing coalShare field`);
  }

  const hasMix = mix != null;
  const hasJodiOil = jodiOil != null;
  const hasJodiGas = jodiGas != null;
  const hasIeaStocks = checkIeaAvailability(ieaStocks);
  const hasEmber = ember != null && typeof ember.fossilShare === 'number';

  const comtradeCode = ISO2_TO_COMTRADE[iso2] ?? null;

  return {
    countryCode: iso2,
    updatedAt: new Date().toISOString(),
    sources: buildSourceTimestamps(mix, jodiOil, jodiGas, ieaStocks, ember),
    coverage: { hasMix, hasJodiOil, hasJodiGas, hasIeaStocks, hasEmber, hasSprPolicy: sprPolicy != null && sprPolicy.regime !== 'unknown' },
    oil: buildOilFields(jodiOil, ieaStocks, hasIeaStocks),
    gas: buildGasFields(jodiGas),
    mix: buildMixFields(hasMix ? mix : null),
    electricity: hasEmber ? {
      fossilShare: ember.fossilShare,
      renewShare: ember.renewShare ?? null,
      nuclearShare: ember.nuclearShare ?? null,
      coalShare: ember.coalShare ?? null,
      gasShare: ember.gasShare ?? null,
      demandTwh: ember.demandTwh ?? null,
    } : null,
    shockInputs: {
      comtradeReporterCode: comtradeCode,
      supportedChokepoints: comtradeCode ? SHOCK_CHOKEPOINTS : [],
      sprRegime: sprPolicy?.regime ?? 'unknown',
      sprCapacityMb: sprPolicy?.capacityMb ?? null,
      sprOperator: sprPolicy?.operator ?? null,
      sprIeaMember: sprPolicy?.ieaMember ?? false,
    },
  };
}

// ── Main seed function ────────────────────────────────────────────────────────

export async function main() {
  const startedAt = Date.now();
  const runId = `energy:spine:${startedAt}`;
  const lock = await acquireLockSafely(LOCK_DOMAIN, runId, LOCK_TTL_MS, { label: LOCK_DOMAIN });

  if (lock.skipped) return;
  if (!lock.locked) {
    console.log('[energy-spine] Lock held by another process, skipping');
    return;
  }

  const writeMeta = async (recordCount, status = 'ok') => {
    const metaPayload = { fetchedAt: Date.now(), recordCount, status };
    await redisPipeline([
      ['SET', SPINE_META_KEY, JSON.stringify(metaPayload), 'EX', SPINE_TTL_SECONDS],
    ]).catch(e => console.warn('[energy-spine] Failed to write seed-meta:', e.message));
  };

  try {
    // Step 1: Collect country list (union of JODI oil + OWID mix countries)
    console.log('[energy-spine] Assembling country list...');
    const { countries, jodiCount, owidCount } = await assembleCountryList();
    if (countries.length === 0) {
      console.error('[energy-spine] No countries found in source keys — aborting');
      await writeMeta(0, 'empty');
      return;
    }

    if (jodiCount === 0 && owidCount === 0) {
      console.error('[energy-spine] Both JODI oil and OWID mix returned zero countries — aborting to preserve snapshot');
      const prevCountries = await redisGet(SPINE_COUNTRIES_KEY).catch(() => null);
      if (Array.isArray(prevCountries) && prevCountries.length > 0) {
        const prevKeys = prevCountries.map(iso2 => `${SPINE_KEY_PREFIX}${iso2}`);
        await extendExistingTtl([...prevKeys, SPINE_COUNTRIES_KEY, SPINE_META_KEY], SPINE_TTL_SECONDS);
      }
      await writeMeta(0, 'core_sources_empty');
      return;
    }

    console.log(`[energy-spine] ${countries.length} countries to process`);

    // Step 2: Count-drop guard — check against previous _countries count
    const prevCountries = await redisGet(SPINE_COUNTRIES_KEY).catch(() => null);
    const prevCount = Array.isArray(prevCountries) ? prevCountries.length : 0;
    if (prevCount > 0) {
      const coverageRatio = countries.length / prevCount;
      if (coverageRatio < MIN_COVERAGE_RATIO) {
        console.error(
          `[energy-spine] Count-drop guard triggered: ${countries.length} countries = ` +
          `${(coverageRatio * 100).toFixed(1)}% of previous ${prevCount} — aborting to preserve snapshot`,
        );
        // Extend TTL on existing spine keys
        const prevKeys = prevCountries.map(iso2 => `${SPINE_KEY_PREFIX}${iso2}`);
        await extendExistingTtl(
          [...prevKeys, SPINE_COUNTRIES_KEY, SPINE_META_KEY],
          SPINE_TTL_SECONDS,
        );
        await writeMeta(0, 'count_drop_guard');
        return;
      }
    }

    // Read SPR policy registry once (global key, not per-country)
    const sprRegistry = await redisGet('energy:spr-policies:v1').catch(() => null);
    const sprPolicies = sprRegistry?.policies ?? {};

    // Step 3: Batch-read all 6 domain keys per country via pipeline
    // Order: mix, jodiOil, jodiGas, ieaStocks (electricity + gasStorage excluded — they
    // update sub-daily and are always read directly by handlers, not from the spine)
    console.log('[energy-spine] Reading domain keys in batches...');
    const BATCH_SIZE = 60; // 5 keys * 60 countries = 300 commands per pipeline call
    const spineEntries = new Map();

    for (let i = 0; i < countries.length; i += BATCH_SIZE) {
      const batch = countries.slice(i, i + BATCH_SIZE);
      const keys = [];
      for (const iso2 of batch) {
        keys.push(
          `energy:mix:v1:${iso2}`,
          `energy:jodi-oil:v1:${iso2}`,
          `energy:jodi-gas:v1:${iso2}`,
          `energy:iea-oil-stocks:v1:${iso2}`,
          `energy:ember:v1:${iso2}`,
        );
      }

      const values = await redisMget(keys);

      for (let j = 0; j < batch.length; j++) {
        const iso2 = batch[j];
        const base = j * 5;
        const mix = values[base];
        const jodiOil = values[base + 1];
        const jodiGas = values[base + 2];
        const ieaStocks = values[base + 3];
        const ember = values[base + 4];

        try {
          const sprPolicy = sprPolicies[iso2] ?? null;
          const spine = buildSpineEntry(iso2, { mix, jodiOil, jodiGas, ieaStocks, ember, sprPolicy });
          spineEntries.set(iso2, spine);
        } catch (err) {
          throw new Error(`Schema validation failed for ${iso2}: ${err.message}`);
        }
      }

      console.log(`[energy-spine] Processed ${Math.min(i + BATCH_SIZE, countries.length)}/${countries.length}`);
    }

    // Step 4: Write all spine keys in a single pipeline
    console.log(`[energy-spine] Writing ${spineEntries.size} spine keys...`);
    const commands = [];

    for (const [iso2, entry] of spineEntries) {
      commands.push([
        'SET',
        `${SPINE_KEY_PREFIX}${iso2}`,
        JSON.stringify(entry),
        'EX',
        SPINE_TTL_SECONDS,
      ]);
    }

    // Write _countries index last so it's always a superset
    commands.push([
      'SET',
      SPINE_COUNTRIES_KEY,
      JSON.stringify([...spineEntries.keys()]),
      'EX',
      SPINE_TTL_SECONDS,
    ]);

    // Write seed-meta
    commands.push([
      'SET',
      SPINE_META_KEY,
      JSON.stringify({ fetchedAt: Date.now(), recordCount: spineEntries.size, status: 'ok' }),
      'EX',
      SPINE_TTL_SECONDS,
    ]);

    const results = await redisPipeline(commands);
    const failures = results.filter(r => r?.error || r?.result === 'ERR');
    if (failures.length > 0) {
      throw new Error(
        `Redis pipeline: ${failures.length}/${commands.length} commands failed`,
      );
    }

    logSeedResult('energy:spine', spineEntries.size, Date.now() - startedAt, {
      countries: spineEntries.size,
      ttlH: SPINE_TTL_SECONDS / 3600,
    });
    console.log(`[energy-spine] Seeded ${spineEntries.size} country spine keys`);
  } catch (err) {
    console.error('[energy-spine] Seed failed:', err.message || err);
    // Extend existing snapshot TTL on failure; still write seed-meta with count=0
    const existingCountries = await redisGet(SPINE_COUNTRIES_KEY).catch(() => null);
    if (Array.isArray(existingCountries) && existingCountries.length > 0) {
      const keys = existingCountries.map(iso2 => `${SPINE_KEY_PREFIX}${iso2}`);
      await extendExistingTtl(
        [...keys, SPINE_COUNTRIES_KEY, SPINE_META_KEY],
        SPINE_TTL_SECONDS,
      ).catch(e => console.warn('[energy-spine] TTL extension failed:', e.message));
    }
    await writeMeta(0, 'error');
    throw err;
  } finally {
    await releaseLock(LOCK_DOMAIN, runId);
  }
}

if (process.argv[1]?.endsWith('seed-energy-spine.mjs')) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
