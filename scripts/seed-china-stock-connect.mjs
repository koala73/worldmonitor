#!/usr/bin/env node

import { DAY_MIN, tokensToContentMeta } from './_content-age-helpers.mjs';
import { loadEnvFile, readSeedSnapshot, runSeed } from './_seed-utils.mjs';
import {
  CHINA_STOCK_CONNECT_KEY,
  STOCK_CONNECT_SOURCE_IDS,
  fetchChinaStockConnectSnapshot,
} from './china-stock-connect/adapters.mjs';

loadEnvFile(import.meta.url);

export const CHINA_STOCK_CONNECT_TTL_SECONDS = 3 * DAY_MIN * 60;
export const CHINA_STOCK_CONNECT_MAX_STALE_MIN = 180;
// Both series pause for every mainland market holiday, and margin publishes on
// a T+1 lag on top of that. Chinese New Year is the long pole at roughly nine
// closed calendar days, so the budget has to clear ~11 days of legitimate
// silence without alarming. A genuine freeze is caught earlier and more sharply
// by the trade-date agreement check in the adapter, which downgrades the
// combined value to TRADE_DATE_MISMATCH the moment one exchange stops advancing.
export const CHINA_STOCK_CONNECT_MAX_CONTENT_AGE_MIN = 14 * DAY_MIN;

export function validateChinaStockConnectSnapshot(snapshot) {
  if (
    snapshot?.schemaVersion !== 1
    || snapshot?.countryCode !== 'CN'
    || !['healthy', 'degraded'].includes(snapshot?.status)
    || !Array.isArray(snapshot?.sources)
    || !Array.isArray(snapshot?.history)
    || snapshot?.northbound == null
    || snapshot?.margin == null
  ) {
    return false;
  }
  // Northbound turnover is gross two-way activity. If a future change ever
  // drops this marker the payload would read as a flow, which is exactly the
  // claim the exchanges stopped supporting in 2024.
  if (snapshot.northbound?.netFlow?.status !== 'unavailable') return false;
  const sourceIds = new Set(snapshot.sources.map((source) => source?.id));
  return STOCK_CONNECT_SOURCE_IDS.every((id) => sourceIds.has(id));
}

export function chinaStockConnectContentMeta(snapshot) {
  // Deliberately the two headline trade dates and nothing else: history carries
  // older days, and including it would let a frozen upstream keep the newest
  // token fresh through backfill it had already published.
  return tokensToContentMeta([
    snapshot?.northbound?.tradeDate,
    snapshot?.margin?.tradeDate,
  ]);
}

export async function buildChinaStockConnectSeedSnapshot({
  readSnapshot = readSeedSnapshot,
  fetchSnapshot = fetchChinaStockConnectSnapshot,
} = {}) {
  // The rolling history is part of the product contract, so a failed cache read
  // must abort rather than silently republish a snapshot with no past.
  const previousSnapshot = await readSnapshot(CHINA_STOCK_CONNECT_KEY, { strict: true });
  return fetchSnapshot({ previousSnapshot });
}

if (process.argv[1]?.endsWith('seed-china-stock-connect.mjs')) {
  runSeed(
    'market',
    'china-stock-connect',
    CHINA_STOCK_CONNECT_KEY,
    buildChinaStockConnectSeedSnapshot,
    {
      ttlSeconds: CHINA_STOCK_CONNECT_TTL_SECONDS,
      lockTtlMs: 240_000,
      validateFn: validateChinaStockConnectSnapshot,
      declareRecords: (snapshot) => snapshot.history.length,
      // An empty history means every source failed on a run with no prior
      // snapshot to merge. That is a failure, not a quiet market.
      zeroIsValid: false,
      sourceVersion: 'china-stock-connect-sse-szse-v1',
      schemaVersion: 1,
      maxStaleMin: CHINA_STOCK_CONNECT_MAX_STALE_MIN,
      contentMeta: chinaStockConnectContentMeta,
      maxContentAgeMin: CHINA_STOCK_CONNECT_MAX_CONTENT_AGE_MIN,
    },
  );
}
