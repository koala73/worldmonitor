#!/usr/bin/env node

import { createRequire } from 'node:module';
import { loadEnvFile, CHROME_UA, runSeed, sleep } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const require = createRequire(import.meta.url);
const UN_TO_ISO2 = require('./shared/un-to-iso2.json');

const CANONICAL_KEY = 'resilience:recovery:import-hhi:v1';
const CACHE_TTL = 90 * 24 * 3600;

const COMTRADE_API_KEY = process.env.COMTRADE_API_KEY || '';
const COMTRADE_URL = COMTRADE_API_KEY
  ? 'https://comtradeapi.un.org/data/v1/get/C/A/HS'
  : 'https://comtradeapi.un.org/public/v1/preview/C/A/HS';
const INTER_REQUEST_DELAY_MS = COMTRADE_API_KEY ? 600 : 3500;

const ISO2_TO_UN = Object.fromEntries(
  Object.entries(UN_TO_ISO2).map(([un, iso2]) => [iso2, un]),
);

const ALL_REPORTERS = Object.values(UN_TO_ISO2).filter(c => c.length === 2);

function parseRecords(data) {
  const records = data?.data ?? [];
  if (!Array.isArray(records)) return [];
  return records
    .filter(r => r && Number(r.primaryValue ?? 0) > 0)
    .map(r => ({
      partnerCode: String(r.partnerCode ?? r.partner2Code ?? '000'),
      primaryValue: Number(r.primaryValue ?? 0),
    }));
}

async function fetchImportsForReporter(reporterCode) {
  const url = new URL(COMTRADE_URL);
  url.searchParams.set('reporterCode', reporterCode);
  url.searchParams.set('flowCode', 'M');
  url.searchParams.set('cmdCode', 'TOTAL');
  url.searchParams.set('partnerCode', '');
  if (COMTRADE_API_KEY) url.searchParams.set('subscription-key', COMTRADE_API_KEY);

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
    if (!retry.ok) return [];
    return parseRecords(await retry.json());
  }

  if (!resp.ok) {
    console.warn(`  HTTP ${resp.status} for reporter ${reporterCode}`);
    return [];
  }
  return parseRecords(await resp.json());
}

export function computeHhi(records) {
  const validRecords = records.filter(r => r.partnerCode !== '0' && r.partnerCode !== '000');
  const totalValue = validRecords.reduce((s, r) => s + r.primaryValue, 0);
  if (totalValue <= 0) return null;
  let hhi = 0;
  for (const r of validRecords) {
    const share = r.primaryValue / totalValue;
    hhi += share * share;
  }
  return Math.round(hhi * 10000) / 10000;
}

async function fetchImportHhi() {
  const countries = {};
  let fetched = 0;
  let skipped = 0;

  console.log(`[seed] import-hhi: fetching HS2-level import data for ${ALL_REPORTERS.length} reporters (mode: ${COMTRADE_API_KEY ? 'authenticated' : 'public'})`);

  for (let i = 0; i < ALL_REPORTERS.length; i++) {
    const iso2 = ALL_REPORTERS[i];
    const unCode = ISO2_TO_UN[iso2];
    if (!unCode) { skipped++; continue; }

    if (fetched > 0) await sleep(INTER_REQUEST_DELAY_MS);

    try {
      const records = await fetchImportsForReporter(unCode);
      if (records.length === 0) { skipped++; continue; }

      const hhi = computeHhi(records);
      if (hhi === null) { skipped++; continue; }

      countries[iso2] = {
        hhi,
        concentrated: hhi > 0.25,
        partnerCount: records.filter(r => r.partnerCode !== '0' && r.partnerCode !== '000').length,
      };
      fetched++;

      if (fetched % 20 === 0) {
        console.log(`  [${fetched}/${ALL_REPORTERS.length}] ${iso2}: HHI=${hhi}`);
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
