#!/usr/bin/env node

// @ts-check

import { createRequire } from 'node:module';
import {
  acquireLockSafely,
  CHROME_UA,
  extendExistingTtl,
  getRedisCredentials,
  loadEnvFile,
  logSeedResult,
  releaseLock,
  sleep,
} from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const META_KEY = 'seed-meta:comtrade:bilateral-hs4';
const KEY_PREFIX = 'comtrade:bilateral-hs4:';
const TTL_SECONDS = 259200; // 72h
const LOCK_DOMAIN = 'comtrade:bilateral-hs4';
const LOCK_TTL_MS = 30 * 60 * 1000; // 30 min

const COMTRADE_KEYS = (process.env.COMTRADE_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
let keyIndex = 0;
function getNextKey() {
  if (COMTRADE_KEYS.length === 0) return '';
  const key = COMTRADE_KEYS[keyIndex % COMTRADE_KEYS.length];
  keyIndex++;
  return key;
}

const usePublicApi = COMTRADE_KEYS.length === 0;
const COMTRADE_FETCH_URL = usePublicApi
  ? 'https://comtradeapi.un.org/public/v1/preview/C/A/HS'
  : 'https://comtradeapi.un.org/data/v1/get/C/A/HS';
const INTER_REQUEST_DELAY_MS = usePublicApi ? 3500 : 1500;

const HS4_CODES = [
  '2709', '2711', '8542', '8517', '8703', '3004', '7108', '2710',
  '8471', '8411', '7601', '7202', '3901', '2902', '1001', '1201',
  '6204', '0203', '8704', '8708',
];

const HS4_LABELS = {
  '2709': 'Crude Petroleum',
  '2711': 'LNG & Petroleum Gas',
  '8542': 'Semiconductors',
  '8517': 'Smartphones & Telecom',
  '8703': 'Passenger Vehicles',
  '3004': 'Pharmaceuticals',
  '7108': 'Gold',
  '2710': 'Refined Petroleum',
  '8471': 'Computers',
  '8411': 'Turbojets & Turbines',
  '7601': 'Aluminium',
  '7202': 'Ferroalloys (Steel)',
  '3901': 'Plastics (Polyethylene)',
  '2902': 'Chemicals (Hydrocarbons)',
  '1001': 'Wheat',
  '1201': 'Soybeans',
  '6204': 'Garments',
  '0203': 'Pork',
  '8704': 'Trucks',
  '8708': 'Vehicle Parts',
};

const BATCH_1 = HS4_CODES.slice(0, 10);
const BATCH_2 = HS4_CODES.slice(10);

const require = createRequire(import.meta.url);
/** @type {Record<string, {nearestRouteIds: string[], coastSide: string}>} */
const COUNTRY_PORT_CLUSTERS = require('./shared/country-port-clusters.json');
/** @type {Record<string, string>} */
const UN_TO_ISO2 = require('./shared/un-to-iso2.json');

const ISO2_TO_UN = Object.fromEntries(
  Object.entries(UN_TO_ISO2).map(([un, iso2]) => [iso2, un]),
);

// UN Comtrade uses non-standard reporter codes for some countries.
// These override the standard UN M49 codes from un-to-iso2.json.
const COMTRADE_REPORTER_OVERRIDES = {
  FR: '251', // UN M49 standard is 250, but Comtrade registers France as reporter 251
  IT: '381', // UN M49 standard is 380, but Comtrade registers Italy as reporter 381
  US: '842', // UN M49 standard is 840, but Comtrade registers the US as reporter 842
  IN: '699', // UN M49 standard is 356, Comtrade registers India as reporter 699
  TW: '490', // M49 has no entry; Comtrade reports Taiwan as 490 "Other Asia, nes"
};

/**
 * @param {Array<string[]>} commands
 */
async function redisPipeline(commands) {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Redis pipeline failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
  return resp.json();
}

/**
 * @param {string} reporterCode
 * @param {string[]} hs4Batch
 * @returns {Promise<Array<{cmdCode: string, partnerCode: string, primaryValue: number, year: number}>>}
 */
// Comtrade's API regularly returns transient 5xx (500/502/503/504) on otherwise
// valid reporter fetches — observed 2026-04-14 with India (699) 503×2 and
// Iran (364) 500. Without a 5xx retry those reporters silently drop from
// the snapshot and the panel shows missing countries for a full cycle.
export function isTransientComtrade(status) {
  return status === 500 || status === 502 || status === 503 || status === 504;
}

// Retry sleep is indirected through a module-local binding so unit tests can
// swap in a no-op without changing production cadence. Production defaults
// to the real sleep import; tests call __setSleepForTests(() => Promise.resolve()).
let _retrySleep = sleep;
export function __setSleepForTests(fn) { _retrySleep = typeof fn === 'function' ? fn : sleep; }

async function fetchBilateralOnce(url, timeoutMs = 45_000) {
  return fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function buildFetchUrl(reporterCode, hs4Batch, key) {
  const url = new URL(COMTRADE_FETCH_URL);
  url.searchParams.set('reporterCode', reporterCode);
  url.searchParams.set('cmdCode', hs4Batch.join(','));
  url.searchParams.set('flowCode', 'M');
  if (key) url.searchParams.set('subscription-key', key);
  return url.toString();
}

/**
 * Single classification loop so a post-429 5xx still consumes the bounded
 * 5xx retries (and vice versa). Caps: one 429 wait (60s), then up to two
 * transient-5xx retries (5s, 15s). Any non-transient non-OK status exits.
 *
 * @param {string} reporterCode
 * @param {string[]} hs4Batch
 * @returns {Promise<Array<{cmdCode: string, partnerCode: string, primaryValue: number, year: number}>>}
 */
export async function fetchBilateral(reporterCode, hs4Batch) {
  let rateLimitedOnce = false;
  let transientRetries = 0;
  const MAX_TRANSIENT_RETRIES = 2;

  let resp;
  while (true) {
    resp = await fetchBilateralOnce(buildFetchUrl(reporterCode, hs4Batch, getNextKey()));

    if (resp.status === 429 && !rateLimitedOnce) {
      console.warn(`  429 rate-limited for reporter ${reporterCode}, waiting 60s...`);
      await _retrySleep(60_000);
      rateLimitedOnce = true;
      continue;
    }

    if (isTransientComtrade(resp.status) && transientRetries < MAX_TRANSIENT_RETRIES) {
      const delay = transientRetries === 0 ? 5_000 : 15_000;
      console.warn(`    transient HTTP ${resp.status} for reporter ${reporterCode}, retrying in ${delay / 1000}s...`);
      await _retrySleep(delay);
      transientRetries++;
      continue;
    }

    break;
  }

  if (!resp.ok) {
    const tag = (rateLimitedOnce || transientRetries > 0) ? ' (after retries)' : '';
    console.warn(`    HTTP ${resp.status} for reporter ${reporterCode}${tag}`);
    return [];
  }

  const data = await resp.json();
  const parsed = parseRecords(data);
  if (parsed.length === 0 && data?.count > 0) {
    console.warn(`    Reporter ${reporterCode}: API returned count=${data.count} but parseRecords produced 0 — response shape may have changed`);
  }
  return parsed;
}

/**
 * @param {unknown} data
 * @returns {Array<{cmdCode: string, partnerCode: string, primaryValue: number, year: number}>}
 */
function parseRecords(data) {
  const records = /** @type {any[]} */ (/** @type {any} */ (data)?.data ?? []);
  if (!Array.isArray(records)) return [];
  return records
    .filter(r => r && Number(r.primaryValue ?? 0) > 0)
    .map(r => ({
      cmdCode: String(r.cmdCode ?? ''),
      partnerCode: String(r.partnerCode ?? r.partner2Code ?? '000'),
      primaryValue: Number(r.primaryValue ?? 0),
      year: Number(r.period ?? r.refYear ?? 0),
    }));
}

/**
 * @param {Array<{cmdCode: string, partnerCode: string, primaryValue: number, year: number}>} records
 * @returns {Array<{hs4: string, description: string, totalValue: number, topExporters: Array<{partnerCode: number, partnerIso2: string, value: number, share: number}>, year: number}>}
 */
function groupByProduct(records) {
  /** @type {Map<string, Map<string, {value: number, year: number}>>} */
  const byCode = new Map();
  for (const r of records) {
    if (!byCode.has(r.cmdCode)) byCode.set(r.cmdCode, new Map());
    const partners = byCode.get(r.cmdCode);
    const existing = partners.get(r.partnerCode);
    if (!existing || r.primaryValue > existing.value) {
      partners.set(r.partnerCode, { value: r.primaryValue, year: r.year });
    }
  }

  const products = [];
  for (const [hs4, partners] of byCode) {
    const sorted = [...partners.entries()]
      .sort((a, b) => b[1].value - a[1].value)
      .filter(([pc]) => pc !== '0' && pc !== '000');
    const totalValue = sorted.reduce((s, [, v]) => s + v.value, 0);
    if (totalValue <= 0) continue;
    const top5 = sorted.slice(0, 5);
    const latestYear = Math.max(...sorted.map(([, v]) => v.year).filter(y => y > 0));
    products.push({
      hs4,
      description: HS4_LABELS[hs4] ?? hs4,
      totalValue,
      topExporters: top5.map(([pc, v]) => ({
        partnerCode: Number(pc),
        partnerIso2: UN_TO_ISO2[pc.padStart(3, '0')] ?? '',
        value: v.value,
        share: Math.round((v.value / totalValue) * 1000) / 1000,
      })),
      year: latestYear || 2023,
    });
  }
  return products.sort((a, b) => b.totalValue - a.totalValue);
}

export async function main() {
  const startedAt = Date.now();
  const runId = `${LOCK_DOMAIN}:${startedAt}`;
  const lock = await acquireLockSafely(LOCK_DOMAIN, runId, LOCK_TTL_MS, { label: LOCK_DOMAIN });

  const countries = Object.entries(COUNTRY_PORT_CLUSTERS)
    .filter(([k]) => k !== '_comment' && k.length === 2);
  const allKeys = countries.map(([iso2]) => `${KEY_PREFIX}${iso2}:v1`);

  if (lock.skipped) {
    await extendExistingTtl([...allKeys, META_KEY], TTL_SECONDS)
      .catch(e => console.warn('[bilateral-hs4] TTL extension (skipped) failed:', e.message));
    return;
  }
  if (!lock.locked) {
    console.log('[bilateral-hs4] Lock held, skipping');
    return;
  }

  const writeMeta = async (count, status = 'ok') => {
    const meta = JSON.stringify({ fetchedAt: Date.now(), recordCount: count, status });
    await redisPipeline([['SET', META_KEY, meta, 'EX', String(TTL_SECONDS * 3)]])
      .catch(e => console.warn('[bilateral-hs4] Failed to write seed-meta:', e.message));
  };

  try {
    const apiMode = usePublicApi ? 'public preview (no COMTRADE_API_KEYS)' : `authenticated (${COMTRADE_KEYS.length} key(s), ${INTER_REQUEST_DELAY_MS}ms delay)`;
    console.log(`[bilateral-hs4] Fetching bilateral HS4 data for ${countries.length} countries × ${HS4_CODES.length} products [${apiMode}]...`);

    const commands = [];
    let writtenCount = 0;
    let failedCount = 0;
    let requestCount = 0;

    for (let i = 0; i < countries.length; i++) {
      const [iso2] = countries[i];
      const unCode = COMTRADE_REPORTER_OVERRIDES[iso2] ?? ISO2_TO_UN[iso2];
      if (!unCode) {
        console.warn(`  ${iso2}: no UN code, skipping`);
        continue;
      }

      if (requestCount > 0) await sleep(INTER_REQUEST_DELAY_MS);

      try {
        console.log(`  [${i + 1}/${countries.length}] ${iso2} batch 1/2...`);
        const batch1 = await fetchBilateral(unCode, BATCH_1);
        requestCount++;

        await sleep(INTER_REQUEST_DELAY_MS);

        console.log(`  [${i + 1}/${countries.length}] ${iso2} batch 2/2...`);
        const batch2 = await fetchBilateral(unCode, BATCH_2);
        requestCount++;

        const products = groupByProduct([...batch1, ...batch2]);
        if (products.length === 0) {
          console.warn(`    ${iso2}: no products after grouping, skipping write`);
        } else {
          const payload = JSON.stringify({
            iso2,
            products,
            fetchedAt: new Date().toISOString(),
          });
          commands.push(['SET', `${KEY_PREFIX}${iso2}:v1`, payload, 'EX', String(TTL_SECONDS)]);
          writtenCount++;
          console.log(`    ${iso2}: ${products.length} products, ${batch1.length + batch2.length} records`);
        }
      } catch (err) {
        console.warn(`  [bilateral-hs4] ${iso2}: fetch failed, preserving existing data: ${err.message}`);
        failedCount++;
      }

      if (commands.length >= 50) {
        await redisPipeline(commands.splice(0));
      }
    }

    if (commands.length > 0) {
      await redisPipeline(commands);
    }

    await writeMeta(writtenCount);

    logSeedResult('comtrade:bilateral-hs4', writtenCount, Date.now() - startedAt, {
      countries: countries.length,
      failed: failedCount,
      hs4Codes: HS4_CODES.length,
      requests: requestCount,
      ttlH: TTL_SECONDS / 3600,
    });
    console.log(`[bilateral-hs4] Seeded ${writtenCount} country keys (${failedCount} failed, existing data preserved)`);
  } catch (err) {
    console.error('[bilateral-hs4] Seed failed:', err.message || err);
    await extendExistingTtl([...allKeys, META_KEY], TTL_SECONDS)
      .catch(e => console.warn('[bilateral-hs4] TTL extension failed:', e.message));
    await writeMeta(0, 'error');
    throw err;
  } finally {
    await releaseLock(LOCK_DOMAIN, runId);
  }
}

const isMain = process.argv[1]?.endsWith('seed-comtrade-bilateral-hs4.mjs');
if (isMain) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
