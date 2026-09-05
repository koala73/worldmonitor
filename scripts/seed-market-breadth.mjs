#!/usr/bin/env node

import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import {
  BREADTH_HISTORY_KEY,
  fetchSp500Breadth,
  mergeBreadthHistory,
  readBreadthHistory,
  requireCompleteReadings,
} from './_sp500-breadth.mjs';
loadEnvFile(import.meta.url);

const BREADTH_TTL = 2592000; // 30 days

async function fetchAll() {
  const { readings, constituents, valid } = await fetchSp500Breadth();

  console.log(`  TradingView: ${constituents} S&P 500 constituents (valid 20d=${valid.pctAbove20d} | 50d=${valid.pctAbove50d} | 200d=${valid.pctAbove200d})`);
  console.log(`    20d=${readings.pctAbove20d ?? 'null'} | 50d=${readings.pctAbove50d ?? 'null'} | 200d=${readings.pctAbove200d ?? 'null'}`);

  requireCompleteReadings(readings);

  const existing = await readBreadthHistory({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  // ET trading day: Railway cron fires at 9 PM ET which is 01:00-02:00 UTC on
  // the NEXT calendar day, so UTC date would stamp today's session with
  // tomorrow's date. en-CA locale returns ISO YYYY-MM-DD; America/New_York
  // handles DST automatically.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const { history, current, updatedExisting } = mergeBreadthHistory(
    existing?.history ?? [],
    readings,
    today,
  );
  if (updatedExisting) {
    console.log(`  Updated existing entry for ${today}`);
  } else {
    console.log(`  Appended new entry for ${today} (history: ${history.length} days)`);
  }

  return {
    updatedAt: new Date().toISOString(),
    current,
    history,
  };
}

function validate(data) {
  return (
    data?.current != null &&
    Number.isFinite(data.current.pctAbove20d) &&
    Number.isFinite(data.current.pctAbove50d) &&
    Number.isFinite(data.current.pctAbove200d) &&
    Array.isArray(data?.history) &&
    data.history.length > 0
  );
}

export function declareRecords(data) {
  return Array.isArray(data?.history) ? data.history.length : 0;
}

runSeed('market', 'breadth-history', BREADTH_HISTORY_KEY, fetchAll, {
  validateFn: validate,
  ttlSeconds: BREADTH_TTL,

  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 2880,
  sourceVersion: 'market-breadth-v1',
}).catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
