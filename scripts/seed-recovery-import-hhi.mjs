#!/usr/bin/env node

import { createRequire } from 'node:module';
import { loadEnvFile, CHROME_UA, runSeed, sleep } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const require = createRequire(import.meta.url);
const UN_TO_ISO2 = require('./shared/un-to-iso2.json');

const CANONICAL_KEY = 'resilience:recovery:import-hhi:v1';
const CACHE_TTL = 90 * 24 * 3600;

// Matches the key-rotation pattern in seed-comtrade-bilateral-hs4.mjs:
// COMTRADE_API_KEYS is a comma-separated list of subscription keys.
const COMTRADE_KEYS = (process.env.COMTRADE_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
let keyIndex = 0;
function nextKey() { return COMTRADE_KEYS[keyIndex++ % COMTRADE_KEYS.length]; }

if (COMTRADE_KEYS.length === 0) {
  console.error('[seed] import-hhi: COMTRADE_API_KEYS is required. Set the env var (comma-separated keys) and retry.');
}
const COMTRADE_URL = 'https://comtradeapi.un.org/data/v1/get/C/A/HS';
const INTER_REQUEST_DELAY_MS = 600;

const ISO2_TO_UN = Object.fromEntries(
  Object.entries(UN_TO_ISO2).map(([un, iso2]) => [iso2, un]),
);

const ALL_REPORTERS = Object.values(UN_TO_ISO2).filter(c => c.length === 2);

function parseRecords(data) {
  const records = data?.data ?? [];
  if (!Array.isArray(records)) return [];
  const valid = records.filter(r => r && Number(r.primaryValue ?? 0) > 0);
  if (valid.length === 0) return [];
  // Group by period, pick the year with the most USABLE partners (excluding
  // aggregate codes 0/000 that computeHhi discards). Ties break toward newest.
  const byPeriod = new Map();
  for (const r of valid) {
    const p = String(r.period ?? r.refPeriodId ?? '0');
    if (!byPeriod.has(p)) byPeriod.set(p, []);
    byPeriod.get(p).push(r);
  }
  let bestPeriod = '';
  let bestCount = 0;
  for (const [p, rows] of byPeriod) {
    const usable = rows.filter(r => {
      const pc = String(r.partnerCode ?? r.partner2Code ?? '000');
      return pc !== '0' && pc !== '000';
    }).length;
    if (usable > bestCount || (usable === bestCount && p > bestPeriod)) {
      bestCount = usable;
      bestPeriod = p;
    }
  }
  return byPeriod.get(bestPeriod).map(r => ({
    partnerCode: String(r.partnerCode ?? r.partner2Code ?? '000'),
    primaryValue: Number(r.primaryValue ?? 0),
  }));
}

async function fetchImportsForReporter(reporterCode) {
  if (COMTRADE_KEYS.length === 0) return [];
  const url = new URL(COMTRADE_URL);
  url.searchParams.set('reporterCode', reporterCode);
  url.searchParams.set('flowCode', 'M');
  url.searchParams.set('cmdCode', 'TOTAL');
  // Omit partnerCode to get ALL bilateral partners (matching the pattern
  // in seed-comtrade-bilateral-hs4.mjs). Setting partnerCode=0 returns
  // only the world-aggregate row which computeHhi() then discards.
  // Comtrade annual data lags ~6-12 months; request both years so the API returns whichever has data.
  url.searchParams.set('period', `${new Date().getFullYear() - 1},${new Date().getFullYear() - 2}`);
  url.searchParams.set('subscription-key', nextKey());

  const resp = await fetch(url.toString(), {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(45_000),
  });

  if (resp.status === 429) {
    console.warn(`  429 for reporter ${reporterCode}, waiting 60s...`);
    await sleep(60_000);
    const retry = await fetch(url.toString(), {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(45_000),
    });
    if (!retry.ok) {
      console.warn(`  Retry for reporter ${reporterCode} also failed (HTTP ${retry.status})`);
      return [];
    }
    return parseRecords(await retry.json());
  }

  if (!resp.ok) {
    console.warn(`  HTTP ${resp.status} for reporter ${reporterCode}`);
    return [];
  }
  return parseRecords(await resp.json());
}

// Aggregate import values by partner (Comtrade may return multiple rows
// per partner across commodity codes or sub-periods). Then compute HHI
// from the per-partner totals so each partner is counted exactly once.
export function computeHhi(records) {
  const validRecords = records.filter(r => r.partnerCode !== '0' && r.partnerCode !== '000');
  // Aggregate by partner: sum all rows for the same partnerCode
  const byPartner = new Map();
  for (const r of validRecords) {
    byPartner.set(r.partnerCode, (byPartner.get(r.partnerCode) ?? 0) + r.primaryValue);
  }
  const totalValue = [...byPartner.values()].reduce((s, v) => s + v, 0);
  if (totalValue <= 0) return null;
  let hhi = 0;
  for (const partnerValue of byPartner.values()) {
    const share = partnerValue / totalValue;
    hhi += share * share;
  }
  return { hhi: Math.round(hhi * 10000) / 10000, partnerCount: byPartner.size };
}

async function fetchImportHhi() {
  const countries = {};
  let fetched = 0;
  let skipped = 0;

  console.log(`[seed] import-hhi: fetching HS2-level import data for ${ALL_REPORTERS.length} reporters (${COMTRADE_KEYS.length} key(s), ${INTER_REQUEST_DELAY_MS}ms delay)`);

  for (let i = 0; i < ALL_REPORTERS.length; i++) {
    const iso2 = ALL_REPORTERS[i];
    const unCode = ISO2_TO_UN[iso2];
    if (!unCode) { skipped++; continue; }

    if (fetched > 0) await sleep(INTER_REQUEST_DELAY_MS);

    try {
      const records = await fetchImportsForReporter(unCode);
      if (records.length === 0) { skipped++; continue; }

      const result = computeHhi(records);
      if (result === null) { skipped++; continue; }

      countries[iso2] = {
        hhi: result.hhi,
        concentrated: result.hhi > 0.25,
        partnerCount: result.partnerCount,
      };
      fetched++;

      if (fetched % 20 === 0) {
        console.log(`  [${fetched}/${ALL_REPORTERS.length}] ${iso2}: HHI=${result.hhi} (${result.partnerCount} partners)`);
      }
    } catch (err) {
      console.warn(`  ${iso2}: fetch failed: ${err.message}`);
      skipped++;
    }
  }

  console.log(`[seed] import-hhi: ${fetched} countries computed, ${skipped} skipped`);
  return { countries, seededAt: new Date().toISOString() };
}

function validate(data) {
  return typeof data?.countries === 'object' && Object.keys(data.countries).length >= 80;
}

if (process.argv[1]?.endsWith('seed-recovery-import-hhi.mjs')) {
  runSeed('resilience', 'recovery:import-hhi', CANONICAL_KEY, fetchImportHhi, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: `comtrade-hhi-${new Date().getFullYear()}`,
    recordCount: (data) => Object.keys(data?.countries ?? {}).length,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
