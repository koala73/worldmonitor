#!/usr/bin/env node

import {
  acquireLockSafely,
  CHROME_UA,
  extendExistingTtl,
  getRedisCredentials,
  loadEnvFile,
  logSeedResult,
  releaseLock,
  withRetry,
} from './_seed-utils.mjs';
import { resolveIso2 } from './_country-resolver.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';

loadEnvFile(import.meta.url);

export const OWID_ENERGY_MIX_KEY_PREFIX = 'energy:mix:v1:';
export const OWID_EXPOSURE_INDEX_KEY = 'energy:exposure:v1:index';
/** Full list of ISO2 codes written in the last successful run — used by the
 *  failure-preservation path to extend TTL on ALL per-country keys, not just
 *  those that happen to appear in the top-20 exposure buckets. */
export const OWID_COUNTRY_LIST_KEY = 'energy:mix:v1:_countries';
/** Bulk map of all countries keyed by ISO2 — compact shape, no redundant fields. */
export const OWID_ALL_KEY = 'energy:mix:v1:_all';
export const OWID_META_KEY = 'seed-meta:economic:owid-energy-mix';
export const OWID_TTL_SECONDS = 35 * 24 * 3600;
const OWID_CSV_URL = 'https://owid-public.owid.io/data/energy/owid-energy-data.csv';
const LOCK_DOMAIN = 'economic:owid-energy-mix';
const LOCK_TTL_MS = 30 * 60 * 1000;
const MIN_COUNTRIES = 150;
const MAX_DROP_PCT = 15;

const COLS = {
  coal:       'coal_share_elec',
  gas:        'gas_share_elec',
  oil:        'oil_share_elec',
  nuclear:    'nuclear_share_elec',
  renewables: 'renewables_share_elec',
  wind:       'wind_share_elec',
  solar:      'solar_share_elec',
  hydro:      'hydro_share_elec',
  imports:    'net_energy_imports',
};

function parseDelimitedRow(line, delimiter) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let idx = 0; idx < line.length; idx += 1) {
    const char = line[idx];
    const next = line[idx + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        idx += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function parseDelimitedText(text, delimiter) {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const headers = parseDelimitedRow(lines[0], delimiter);
  return lines.slice(1).map((line) => {
    const values = parseDelimitedRow(line, delimiter);
    return Object.fromEntries(headers.map((header, idx) => [header, values[idx] ?? '']));
  });
}

function safeFloat(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function hasAnyShareField(row) {
  return Object.values(COLS).some((col) => {
    const v = parseFloat(row[col]);
    return Number.isFinite(v);
  });
}

export function parseOwidCsv(csvText) {
  const rows = parseDelimitedText(csvText, ',');
  if (rows.length === 0) throw new Error('OWID CSV: no data rows');

  const headers = Object.keys(rows[0] || {});
  if (!headers.includes(COLS.coal)) {
    throw new Error('OWID column schema changed — update COLS mapping');
  }

  const byCountry = new Map();
  for (const row of rows) {
    const iso3 = String(row.iso_code || '').trim();
    if (iso3.startsWith('OWID_')) continue;
    if (!iso3) continue;

    const year = parseInt(row.year, 10);
    if (!Number.isFinite(year)) continue;
    if (!hasAnyShareField(row)) continue;

    const iso2 = resolveIso2({ iso3 });
    if (!iso2) continue;

    const prev = byCountry.get(iso2);
    if (prev && prev.year >= year) continue;

    byCountry.set(iso2, {
      iso2,
      country: row.country || iso2,
      year,
      coalShare: safeFloat(row[COLS.coal]),
      gasShare: safeFloat(row[COLS.gas]),
      oilShare: safeFloat(row[COLS.oil]),
      nuclearShare: safeFloat(row[COLS.nuclear]),
      renewShare: safeFloat(row[COLS.renewables]),
      windShare: safeFloat(row[COLS.wind]),
      solarShare: safeFloat(row[COLS.solar]),
      hydroShare: safeFloat(row[COLS.hydro]),
      importShare: safeFloat(row[COLS.imports]),
      seededAt: new Date().toISOString(),
    });
  }

  return byCountry;
}

export function buildExposureIndex(countries) {
  const all = [...countries.values()];

  // Each bucket filters only on its own metric so countries with valid
  // oil/import/renewables data but no gas/coal value are not excluded.
  const top20 = (key) =>
    all
      .filter((c) => c[key] != null)
      .sort((a, b) => b[key] - a[key])
      .slice(0, 20)
      .map((c) => ({ iso2: c.iso2, name: c.country, share: c[key] }));

  const years = all.map((c) => c.year).filter(Boolean);

  return {
    updatedAt: new Date().toISOString(),
    year: years.length > 0 ? Math.max(...years) : null,
    gas:      top20('gasShare'),
    coal:     top20('coalShare'),
    oil:      top20('oilShare'),
    imported: top20('importShare'),
    renewable:top20('renewShare'),
  };
}

/**
 * Build a compact bulk map of all countries keyed by ISO2.
 * Omits `iso2`, `country`, and `seededAt` to reduce payload size (~30% savings).
 * @param {Map<string, object>} countries
 * @returns {Record<string, {year: number, coalShare: number|null, gasShare: number|null, oilShare: number|null, nuclearShare: number|null, renewShare: number|null, windShare: number|null, solarShare: number|null, hydroShare: number|null, importShare: number|null}>}
 */
export function buildAllCountriesMap(countries) {
  const result = {};
  for (const [iso2, entry] of countries) {
    result[iso2] = {
      year: entry.year,
      coalShare: entry.coalShare,
      gasShare: entry.gasShare,
      oilShare: entry.oilShare,
      nuclearShare: entry.nuclearShare,
      renewShare: entry.renewShare,
      windShare: entry.windShare,
      solarShare: entry.solarShare,
      hydroShare: entry.hydroShare,
      importShare: entry.importShare,
    };
  }
  return result;
}

async function redisPipeline(commands) {
  const { url, token } = getRedisCredentials();
  const response = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(15_000),
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
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.result ? unwrapEnvelope(JSON.parse(data.result)).data : null;
}

async function preservePreviousSnapshot(errorMsg) {
  console.error('[owid-energy-mix] Preserving previous snapshot:', errorMsg);

  // Read the full country list written by the last successful run.
  // This covers ALL seeded ISO2 codes, including countries that do not appear
  // in any top-20 fuel bucket in the exposure index.
  const countryList = await redisGet(OWID_COUNTRY_LIST_KEY).catch(() => null);
  const perCountryKeys = Array.isArray(countryList)
    ? countryList.map((iso2) => `${OWID_ENERGY_MIX_KEY_PREFIX}${iso2}`)
    : [];

  await extendExistingTtl(
    [...perCountryKeys, OWID_COUNTRY_LIST_KEY, OWID_EXPOSURE_INDEX_KEY, OWID_ALL_KEY, OWID_META_KEY],
    OWID_TTL_SECONDS,
  );
  const metaPayload = {
    fetchedAt: Date.now(),
    recordCount: 0,
    sourceVersion: 'owid-energy-mix-v1',
    status: 'error',
    error: errorMsg,
  };
  await redisPipeline([
    ['SET', OWID_META_KEY, JSON.stringify(metaPayload), 'EX', OWID_TTL_SECONDS],
  ]);
}

export async function main() {
  const startedAt = Date.now();
  const runId = `owid-energy-mix:${startedAt}`;
  const lock = await acquireLockSafely(LOCK_DOMAIN, runId, LOCK_TTL_MS, { label: LOCK_DOMAIN });
  if (lock.skipped) return;
  if (!lock.locked) {
    console.log('[owid-energy-mix] Lock held, skipping');
    return;
  }

  try {
    const csvText = await withRetry(
      () =>
        fetch(OWID_CSV_URL, {
          headers: { 'User-Agent': CHROME_UA },
          signal: AbortSignal.timeout(30_000),
        }).then((r) => {
          if (!r.ok) throw new Error(`OWID HTTP ${r.status}`);
          return r.text();
        }),
      2,
      750,
    );

    const countries = parseOwidCsv(csvText);

    if (countries.size < MIN_COUNTRIES) {
      throw new Error(
        `OWID: only ${countries.size} countries parsed, expected >=${MIN_COUNTRIES}`,
      );
    }

    const prevMeta = await redisGet(OWID_META_KEY).catch(() => null);
    if (prevMeta && typeof prevMeta === 'object' && prevMeta.recordCount > 0) {
      const drop =
        ((prevMeta.recordCount - countries.size) / prevMeta.recordCount) * 100;
      if (drop > MAX_DROP_PCT) {
        throw new Error(
          `OWID: country count dropped ${drop.toFixed(1)}% vs previous ${prevMeta.recordCount}`,
        );
      }
    }

    const exposureIndex = buildExposureIndex(countries);
    const allCountriesMap = buildAllCountriesMap(countries);
    const allCountriesCount = Object.keys(allCountriesMap).length;
    if (allCountriesCount < MIN_COUNTRIES) {
      throw new Error(
        `OWID _all: only ${allCountriesCount} entries, expected >=${MIN_COUNTRIES}`,
      );
    }

    const metaPayload = {
      fetchedAt: Date.now(),
      recordCount: countries.size,
      sourceVersion: 'owid-energy-mix-v1',
    };

    const commands = [];
    for (const [iso2, payload] of countries) {
      commands.push([
        'SET',
        `${OWID_ENERGY_MIX_KEY_PREFIX}${iso2}`,
        JSON.stringify(payload),
        'EX',
        OWID_TTL_SECONDS,
      ]);
    }
    commands.push([
      'SET',
      OWID_EXPOSURE_INDEX_KEY,
      JSON.stringify(exposureIndex),
      'EX',
      OWID_TTL_SECONDS,
    ]);
    // Full ISO2 list — used by failure-preservation path to extend TTL on
    // ALL per-country keys, including countries outside the top-20 fuel buckets.
    commands.push([
      'SET',
      OWID_COUNTRY_LIST_KEY,
      JSON.stringify([...countries.keys()]),
      'EX',
      OWID_TTL_SECONDS,
    ]);
    // Bulk map keyed by ISO2 — compact shape without redundant fields.
    commands.push([
      'SET',
      OWID_ALL_KEY,
      JSON.stringify(allCountriesMap),
      'EX',
      OWID_TTL_SECONDS,
    ]);
    commands.push([
      'SET',
      OWID_META_KEY,
      JSON.stringify(metaPayload),
      'EX',
      OWID_TTL_SECONDS, // must outlive the monthly cron interval (35 days)
    ]);

    const results = await redisPipeline(commands);
    const failures = results.filter((r) => r?.error || r?.result === 'ERR');
    if (failures.length > 0) {
      throw new Error(
        `Redis pipeline: ${failures.length}/${commands.length} commands failed`,
      );
    }

    logSeedResult('economic:owid-energy-mix', countries.size, Date.now() - startedAt, {
      exposureYear: exposureIndex.year,
    });
    console.log(`[owid-energy-mix] Seeded ${countries.size} countries`);
  } catch (err) {
    await preservePreviousSnapshot(String(err)).catch((e) =>
      console.error('[owid-energy-mix] Failed to preserve snapshot:', e),
    );
    throw err;
  } finally {
    await releaseLock(LOCK_DOMAIN, runId);
  }
}

if (process.argv[1]?.endsWith('seed-owid-energy-mix.mjs')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
