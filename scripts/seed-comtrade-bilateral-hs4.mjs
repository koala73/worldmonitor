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
async function fetchBilateral(reporterCode, hs4Batch) {
  const url = new URL(COMTRADE_FETCH_URL);
  url.searchParams.set('reporterCode', reporterCode);
  url.searchParams.set('cmdCode', hs4Batch.join(','));
  url.searchParams.set('flowCode', 'M');
  const key = getNextKey();
  if (key) url.searchParams.set('subscription-key', key);

  const resp = await fetch(url.toString(), {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });

  if (resp.status === 429) {
    console.warn(`  429 rate-limited for reporter ${reporterCode}, waiting 60s...`);
    await sleep(60_000);
    const retryKey = getNextKey();
    const retryUrl = new URL(COMTRADE_FETCH_URL);
    retryUrl.searchParams.set('reporterCode', reporterCode);
    retryUrl.searchParams.set('cmdCode', hs4Batch.join(','));
    retryUrl.searchParams.set('flowCode', 'M');
    if (retryKey) retryUrl.searchParams.set('subscription-key', retryKey);
    const retry = await fetch(retryUrl.toString(), {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!retry.ok) {
      console.warn(`  Retry for reporter ${reporterCode} also failed (HTTP ${retry.status})`);
      return [];
    }
    const retryData = await retry.json();
    return parseRecords(retryData);
  }

  if (!resp.ok) return [];
  const data = await resp.json();
  return parseRecords(data);
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
      const unCode = ISO2_TO_UN[iso2];
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
