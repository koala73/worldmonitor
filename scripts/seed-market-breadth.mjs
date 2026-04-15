#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, sleep } from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
loadEnvFile(import.meta.url);

const BREADTH_KEY = 'market:breadth-history:v1';
const BREADTH_TTL = 2592000; // 30 days
const HISTORY_LENGTH = 252; // trading days (~1 year)

// Barchart breadth symbols:
//   $S5TH = % of S&P 500 above 200-day SMA
//   $S5FI = % of S&P 500 above 50-day SMA
//   $S5TW = % of S&P 500 above 20-day SMA
const BARCHART_SYMBOLS = [
  { symbol: '%24S5TW', label: '20d', field: 'pctAbove20d' },
  { symbol: '%24S5FI', label: '50d', field: 'pctAbove50d' },
  { symbol: '%24S5TH', label: '200d', field: 'pctAbove200d' },
];

async function fetchBarchartPrice(encodedSymbol, label) {
  try {
    const resp = await fetch(`https://www.barchart.com/stocks/quotes/${encodedSymbol}`, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      console.warn(`  Barchart ${label}: HTTP ${resp.status}`);
      return null;
    }
    const html = await resp.text();
    const block = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? html;
    const m = block.match(/"lastPrice"\s*:\s*"?([\d.]+)"?/);
    const val = m ? parseFloat(m[1]) : NaN;
    return Number.isFinite(val) ? val : null;
  } catch (e) {
    console.warn(`  Barchart ${label}: ${e.message}`);
    return null;
  }
}

async function readExistingHistory() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const resp = await fetch(`${url}/get/${encodeURIComponent(BREADTH_KEY)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const { result } = await resp.json();
    return result ? unwrapEnvelope(JSON.parse(result)).data : null;
  } catch {
    return null;
  }
}

async function fetchAll() {
  const readings = {};
  let successCount = 0;

  for (const { symbol, label, field } of BARCHART_SYMBOLS) {
    const val = await fetchBarchartPrice(symbol, label);
    readings[field] = val;
    if (val != null) successCount++;
    await sleep(500);
  }

  console.log(`  Barchart: ${successCount}/${BARCHART_SYMBOLS.length} readings`);
  console.log(`    20d=${readings.pctAbove20d ?? 'null'} | 50d=${readings.pctAbove50d ?? 'null'} | 200d=${readings.pctAbove200d ?? 'null'}`);

  if (successCount === 0) {
    throw new Error('All Barchart breadth fetches failed');
  }

  const existing = await readExistingHistory();
  const history = existing?.history ?? [];
  // ET trading day: Railway cron fires at 9 PM ET which is 01:00-02:00 UTC on
  // the NEXT calendar day, so UTC date would stamp today's session with
  // tomorrow's date. en-CA locale returns ISO YYYY-MM-DD; America/New_York
  // handles DST automatically.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

  const lastEntry = history.at(-1);
  if (lastEntry?.date === today) {
    lastEntry.pctAbove20d = readings.pctAbove20d ?? lastEntry.pctAbove20d;
    lastEntry.pctAbove50d = readings.pctAbove50d ?? lastEntry.pctAbove50d;
    lastEntry.pctAbove200d = readings.pctAbove200d ?? lastEntry.pctAbove200d;
    console.log(`  Updated existing entry for ${today}`);
  } else {
    history.push({
      date: today,
      pctAbove20d: readings.pctAbove20d,
      pctAbove50d: readings.pctAbove50d,
      pctAbove200d: readings.pctAbove200d,
    });
    console.log(`  Appended new entry for ${today} (history: ${history.length} days)`);
  }

  while (history.length > HISTORY_LENGTH) history.shift();

  return {
    updatedAt: new Date().toISOString(),
    current: {
      pctAbove20d: readings.pctAbove20d,
      pctAbove50d: readings.pctAbove50d,
      pctAbove200d: readings.pctAbove200d,
    },
    history,
  };
}

function validate(data) {
  return (
    data?.current != null &&
    Array.isArray(data?.history) &&
    data.history.length > 0
  );
}

export function declareRecords(data) {
  return Array.isArray(data?.history) ? data.history.length : 0;
}

runSeed('market', 'breadth-history', BREADTH_KEY, fetchAll, {
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
