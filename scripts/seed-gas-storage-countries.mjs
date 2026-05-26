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
import { unwrapEnvelope } from './_seed-envelope-source.mjs';

loadEnvFile(import.meta.url);

export const GAS_STORAGE_KEY_PREFIX = 'energy:gas-storage:v1:';
export const GAS_STORAGE_COUNTRIES_KEY = 'energy:gas-storage:v1:_countries';
export const GAS_STORAGE_META_KEY = 'seed-meta:energy:gas-storage-countries';
export const GAS_STORAGE_TTL_SECONDS = 259200; // 3 days = 3× daily cron

const LOCK_DOMAIN = 'energy:gas-storage-countries';
const LOCK_TTL_MS = 20 * 60 * 1000;
const MIN_VALID_COUNTRIES = 24;
const BATCH_SIZE = 4;
const BATCH_DELAY_MS = 200;

const GIE_API_BASE = 'https://agsi.gie.eu/api';

/** Full list of EU-28 + UK ISO2 codes to seed */
const EU_COUNTRIES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'GB',
];

const COUNTRY_NAMES = {
  AT: 'Austria', BE: 'Belgium', BG: 'Bulgaria', HR: 'Croatia', CY: 'Cyprus',
  CZ: 'Czech Republic', DK: 'Denmark', EE: 'Estonia', FI: 'Finland', FR: 'France',
  DE: 'Germany', GR: 'Greece', HU: 'Hungary', IE: 'Ireland', IT: 'Italy',
  LV: 'Latvia', LT: 'Lithuania', LU: 'Luxembourg', MT: 'Malta', NL: 'Netherlands',
  PL: 'Poland', PT: 'Portugal', RO: 'Romania', SK: 'Slovakia', SI: 'Slovenia',
  ES: 'Spain', SE: 'Sweden', GB: 'United Kingdom',
};

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

/** Parse a single GIE entry into fill/gwh/date/change */
export function parseFillEntry(entry) {
  const fill = parseFloat(entry.full || entry.fillLevel || entry.pct || '0');
  const gwh = parseFloat(entry.gasInStorage || entry.gasTwh || entry.volume || '0');
  const date = entry.gasDayStart ?? entry.date ?? '';
  const change = parseFloat(entry.trend || entry.change || '0');
  return { fill, gwh, date, change };
}

/** Derive trend string from 1-day fill % change */
export function computeTrend(fillPctChange1d) {
  if (fillPctChange1d > 0.05) return 'injecting';
  if (fillPctChange1d < -0.05) return 'withdrawing';
  return 'stable';
}

/** Build per-country payload objects from raw GIE data per country */
export function buildCountriesPayload(rawEntries) {
  const result = [];
  for (const { iso2, entries } of rawEntries) {
    if (!entries || !entries.length) continue;

    // Sort descending so entries[0] = most recent
    const sorted = [...entries].sort((a, b) => {
      const da = a.gasDayStart ?? a.date ?? '';
      const db = b.gasDayStart ?? b.date ?? '';
      return db.localeCompare(da);
    });

    const current = parseFillEntry(sorted[0]);
    const prev = sorted.length > 1 ? parseFillEntry(sorted[1]) : null;

    const fillPct = current.fill;
    if (!Number.isFinite(fillPct) || fillPct < 0 || fillPct > 100) continue;

    const fillPctChange1d = prev !== null ? +(fillPct - prev.fill).toFixed(2) : 0;
    const trend = computeTrend(fillPctChange1d);

    const countryName =
      sorted[0].name ?? sorted[0].country ?? COUNTRY_NAMES[iso2] ?? iso2;

    result.push({
      iso2,
      countryName,
      fillPct: +(fillPct.toFixed(2)),
      fillPctChange1d,
      gasTwh: +(current.gwh.toFixed(1)),
      trend,
      date: current.date,
      seededAt: new Date().toISOString(),
    });
  }
  return result;
}

async function fetchCountryData(iso2) {
  const apiKey = process.env.GIE_API_KEY || process.env.AGSI_API_KEY || '';
  const url = `${GIE_API_BASE}?country=${iso2}&size=3`;
  const headers = {
    Accept: 'application/json',
    'User-Agent': CHROME_UA,
  };
  if (apiKey) headers['x-key'] = apiKey;

  const resp = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`GIE AGSI+ HTTP ${resp.status} for ${iso2}: ${body.slice(0, 200)}`);
  }
  const latestData = await resp.json();

  let entries = [];
  if (Array.isArray(latestData)) entries = latestData;
  else if (Array.isArray(latestData?.data)) entries = latestData.data;
  else if (latestData?.gasDayStart) entries = [latestData];

  return entries;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function preservePreviousSnapshot(errorMsg) {
  console.error('[gas-storage-countries] Preserving previous snapshot:', errorMsg);

  const countryList = await redisGet(GAS_STORAGE_COUNTRIES_KEY).catch(() => null);
  const perCountryKeys = Array.isArray(countryList)
    ? countryList.map((iso2) => `${GAS_STORAGE_KEY_PREFIX}${iso2}`)
    : [];

  await extendExistingTtl(
    [...perCountryKeys, GAS_STORAGE_COUNTRIES_KEY],
    GAS_STORAGE_TTL_SECONDS,
  );

  // Preserve old fetchedAt so health staleness detection stays accurate.
  // A fresh fetchedAt on a failed run would make health report OK indefinitely.
  // (GAS_STORAGE_META_KEY is not in extendExistingTtl above — the SET below handles its TTL.)
  const existingMeta = await redisGet(GAS_STORAGE_META_KEY).catch(() => null);
  const metaPayload = {
    fetchedAt: existingMeta?.fetchedAt ?? 0,
    recordCount: existingMeta?.recordCount ?? 0,
    sourceVersion: 'gie-agsi-plus-countries-v1',
    status: 'error',
    error: errorMsg,
  };
  await redisPipeline([
    ['SET', GAS_STORAGE_META_KEY, JSON.stringify(metaPayload), 'EX', GAS_STORAGE_TTL_SECONDS],
  ]);
}

export async function main() {
  const startedAt = Date.now();
  const runId = `gas-storage-countries:${startedAt}`;
  const lock = await acquireLockSafely(LOCK_DOMAIN, runId, LOCK_TTL_MS, { label: LOCK_DOMAIN });
  if (lock.skipped) return;
  if (!lock.locked) {
    console.log('[gas-storage-countries] Lock held, skipping');
    return;
  }

  const apiKey = process.env.GIE_API_KEY || process.env.AGSI_API_KEY || '';
  if (!apiKey) {
    console.warn('  WARNING: GIE_API_KEY / AGSI_API_KEY not set — attempting unauthenticated requests');
  }

  try {
    // Fetch all countries in batches
    const rawEntries = [];
    for (let i = 0; i < EU_COUNTRIES.length; i += BATCH_SIZE) {
      const batch = EU_COUNTRIES.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (iso2) => {
          const entries = await withRetry(() => fetchCountryData(iso2), 2, 500);
          return { iso2, entries };
        }),
      );
      for (const result of results) {
        if (result.status === 'fulfilled') {
          rawEntries.push(result.value);
        } else {
          console.warn(`  [gas-storage-countries] Failed to fetch country data:`, result.reason?.message || result.reason);
        }
      }
      if (i + BATCH_SIZE < EU_COUNTRIES.length) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    const countries = buildCountriesPayload(rawEntries);

    if (countries.length < MIN_VALID_COUNTRIES) {
      throw new Error(
        `gas-storage-countries: only ${countries.length} valid countries, need >=${MIN_VALID_COUNTRIES}`,
      );
    }

    const seededIso2 = countries.map((c) => c.iso2);
    const metaPayload = {
      fetchedAt: Date.now(),
      recordCount: countries.length,
      sourceVersion: 'gie-agsi-plus-countries-v1',
    };

    const commands = [];
    for (const payload of countries) {
      commands.push([
        'SET',
        `${GAS_STORAGE_KEY_PREFIX}${payload.iso2}`,
        JSON.stringify(payload),
        'EX',
        GAS_STORAGE_TTL_SECONDS,
      ]);
    }
    commands.push([
      'SET',
      GAS_STORAGE_COUNTRIES_KEY,
      JSON.stringify(seededIso2),
      'EX',
      GAS_STORAGE_TTL_SECONDS,
    ]);
    commands.push([
      'SET',
      GAS_STORAGE_META_KEY,
      JSON.stringify(metaPayload),
      'EX',
      GAS_STORAGE_TTL_SECONDS,
    ]);

    const results = await redisPipeline(commands);
    const failures = results.filter((r) => r?.error || r?.result === 'ERR');
    if (failures.length > 0) {
      throw new Error(
        `Redis pipeline: ${failures.length}/${commands.length} commands failed`,
      );
    }

    logSeedResult('energy:gas-storage-countries', countries.length, Date.now() - startedAt, {
      countries: seededIso2.join(','),
    });
    console.log(`[gas-storage-countries] Seeded ${countries.length} countries`);
  } catch (err) {
    await preservePreviousSnapshot(String(err)).catch((e) =>
      console.error('[gas-storage-countries] Failed to preserve snapshot:', e),
    );
    throw err;
  } finally {
    await releaseLock(LOCK_DOMAIN, runId);
  }
}

if (process.argv[1]?.endsWith('seed-gas-storage-countries.mjs')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
