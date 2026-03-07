#!/usr/bin/env node

import { loadEnvFile, loadSharedConfig, CHROME_UA, sleep, runSeed, parseYahooChart, writeExtraKey } from './_seed-utils.mjs';

const commodityConfig = loadSharedConfig('commodities.json');

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'market:commodities-bootstrap:v1';
const CACHE_TTL = 1800;
const YAHOO_DELAY_MS = 200;

async function fetchYahooWithRetry(url, label, maxAttempts = 4) {
  for (let i = 0; i < maxAttempts; i++) {
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.status === 429) {
      const wait = 5000 * (i + 1);
      console.warn(`  [Yahoo] ${label} 429 — waiting ${wait / 1000}s (attempt ${i + 1}/${maxAttempts})`);
      await sleep(wait);
      continue;
    }
    if (!resp.ok) {
      console.warn(`  [Yahoo] ${label} HTTP ${resp.status}`);
      return null;
    }
    return resp;
  }
  console.warn(`  [Yahoo] ${label} rate limited after ${maxAttempts} attempts`);
  return null;
}

const COMMODITY_SYMBOLS = commodityConfig.commodities.map(c => c.symbol);

async function fetchCommodityQuotes() {
  const quotes = [];
  let misses = 0;

  for (let i = 0; i < COMMODITY_SYMBOLS.length; i++) {
    const symbol = COMMODITY_SYMBOLS[i];
    if (i > 0) await sleep(YAHOO_DELAY_MS);

    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
      const resp = await fetchYahooWithRetry(url, symbol);
      if (!resp) {
        misses++;
        continue;
      }
      const parsed = parseYahooChart(await resp.json(), symbol);
      if (parsed) {
        quotes.push(parsed);
        console.log(`  ${symbol}: $${parsed.price} (${parsed.change > 0 ? '+' : ''}${parsed.change}%)`);
      } else {
        misses++;
      }
    } catch (err) {
      console.warn(`  [Yahoo] ${symbol} error: ${err.message}`);
      misses++;
    }
  }

  if (quotes.length === 0) {
    throw new Error(`All commodity fetches failed (${misses} misses)`);
  }

  return { quotes };
}

function validate(data) {
  return Array.isArray(data?.quotes) && data.quotes.length >= 1;
}

let seedData = null;

async function fetchAndStash() {
  seedData = await fetchCommodityQuotes();
  return seedData;
}

runSeed('market', 'commodities', CANONICAL_KEY, fetchAndStash, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'yahoo-chart',
}).then(async (result) => {
  if (result?.skipped || !seedData) return;
  const commodityKey = `market:commodities:v1:${[...COMMODITY_SYMBOLS].sort().join(',')}`;
  const quotesKey = `market:quotes:v1:${[...COMMODITY_SYMBOLS].sort().join(',')}`;
  const quotesPayload = { ...seedData, finnhubSkipped: false, skipReason: '', rateLimited: false };
  await writeExtraKey(commodityKey, seedData, CACHE_TTL);
  await writeExtraKey(quotesKey, quotesPayload, CACHE_TTL);
}).catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
