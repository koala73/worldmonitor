#!/usr/bin/env node

/**
 * Seed script: Malaysia monthly merchandise trade by SITC section (DOSM).
 *
 * Sources (CC BY 4.0, Department of Statistics Malaysia open data):
 *   https://storage.dosm.gov.my/trade/trade_sitc_1d.csv  exports/imports, monthly from 1990
 *   https://storage.dosm.gov.my/trade/tradeidx.csv       unit value and volume indices, from 2015
 *
 * DOSM releases external trade about four weeks after the reference month. The
 * macro bundle runs this daily, which over-seeds safely and picks up revisions.
 * Read by GetMonthlySitcTrade (trade service).
 */

import { CHROME_UA, loadEnvFile, runSeed, withRetry } from './_seed-utils.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import {
  DOSM_SITC_TRADE_URL,
  DOSM_TRADE_INDEX_URL,
  buildSitcTradePayload,
  countSitcTradeMonths,
  validateSitcTradePayload,
} from './_dosm-sitc-trade.mjs';

loadEnvFile(import.meta.url);

export const SITC_TRADE_MY_KEY = 'trade:monthly-sitc:my:v1';
export const SITC_TRADE_MY_ACTIVATION_KEY = 'seed-activated:trade:monthly-sitc-my';
const TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_STALE_MIN = 4320;
// Newest month is 58-89 days old between releases; 150 days absorbs one late release.
const MAX_CONTENT_AGE_MIN = 150 * 24 * 60;
const MAX_BYTES = 2_000_000;

async function fetchCsv(url) {
  return withRetry(async () => {
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'text/csv,text/plain,*/*' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) throw new Error(`DOSM ${url.split('/').pop()}: HTTP ${resp.status}`);
    if (Number(resp.headers.get('content-length')) > MAX_BYTES) throw new Error('DOSM CSV exceeds size limit');
    const text = await resp.text();
    if (text.length > MAX_BYTES) throw new Error('DOSM CSV exceeds size limit');
    return text;
  }, 2, 2000);
}

export async function fetchSitcTradeMy() {
  const tradeCsv = await fetchCsv(DOSM_SITC_TRADE_URL);
  const indexCsv = await fetchCsv(DOSM_TRADE_INDEX_URL);
  const data = buildSitcTradePayload(tradeCsv, indexCsv);
  console.log(`  DOSM SITC trade: ${data.sections.length} sections, ${data.sections[0].months.length} months `
    + `(${data.sections[0].months[0].month}..${data.latestMonth}), indices to ${data.latestIndexMonth}`);
  return data;
}

export function sitcTradeContentMeta(data) {
  const first = data?.sections?.[0]?.months?.[0]?.month;
  if (!first || !data?.latestMonth) return null;
  return { newestItemAt: Date.parse(`${data.latestMonth}-01T00:00:00Z`), oldestItemAt: Date.parse(`${first}-01T00:00:00Z`) };
}

async function markActivated() {
  try {
    const creds = getOptionalUpstashCreds();
    if (!creds) return;
    await upstashCommand(creds, ['SET', SITC_TRADE_MY_ACTIVATION_KEY, '1']);
  } catch (err) {
    console.warn(`  WARN: SITC trade activation marker write failed: ${err?.message || err}`);
  }
}

if (process.argv[1]?.endsWith('seed-trade-sitc-my.mjs')) {
  runSeed('trade', 'monthly-sitc-my', SITC_TRADE_MY_KEY, fetchSitcTradeMy, {
    validateFn: (data) => validateSitcTradePayload(data),
    ttlSeconds: TTL_SECONDS,
    sourceVersion: 'dosm-trade-sitc-1d-v1',
    schemaVersion: 1,
    maxStaleMin: MAX_STALE_MIN,
    recordCount: countSitcTradeMonths,
    declareRecords: countSitcTradeMonths,
    contentMeta: sitcTradeContentMeta,
    maxContentAgeMin: MAX_CONTENT_AGE_MIN,
    afterPublish: markActivated,
  }).catch((err) => {
    console.error('FATAL:', err?.message || err);
    process.exit(1);
  });
}
