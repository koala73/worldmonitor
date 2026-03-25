#!/usr/bin/env node

import { loadEnvFile, loadSharedConfig, CHROME_UA, runSeed } from './_seed-utils.mjs';

const gulfConfig = loadSharedConfig('gulf.json');

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'market:gulf-quotes:v1';
const CACHE_TTL = 5400; // 90min — 1h buffer over 10min cron cadence (was 60min = 50min buffer)
const YAHOO_DELAY_MS = 200;

const GULF_SYMBOLS = gulfConfig.symbols;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

function parseYahooChart(data, meta) {
  const result = data?.chart?.result?.[0];
  const chartMeta = result?.meta;
  if (!chartMeta) return null;

  const price = chartMeta.regularMarketPrice;
  const prevClose = chartMeta.chartPreviousClose || chartMeta.previousClose || price;
  const change = ((price - prevClose) / prevClose) * 100;

  const closes = result.indicators?.quote?.[0]?.close;
  const sparkline = (closes || []).filter((v) => v != null);

  return {
    symbol: meta.symbol,
    name: meta.name,
    country: meta.country,
    flag: meta.flag,
    type: meta.type,
    price,
    change: +change.toFixed(2),
    sparkline,
  };
}

async function fetchGulfQuotes() {
  const quotes = [];
  let misses = 0;

  for (let i = 0; i < GULF_SYMBOLS.length; i++) {
    const meta = GULF_SYMBOLS[i];
    if (i > 0) await sleep(YAHOO_DELAY_MS);

    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(meta.symbol)}`;
      const resp = await fetchYahooWithRetry(url, meta.symbol);
      if (!resp) {
        misses++;
        continue;
      }
      const chart = await resp.json();
      const parsed = parseYahooChart(chart, meta);
      if (parsed) {
        quotes.push(parsed);
        console.log(`  ${meta.symbol}: $${parsed.price} (${parsed.change > 0 ? '+' : ''}${parsed.change}%)`);
      } else {
        misses++;
      }
    } catch (err) {
      console.warn(`  [Yahoo] ${meta.symbol} error: ${err.message}`);
      misses++;
    }
  }

  if (quotes.length === 0) {
    throw new Error(`All Gulf quote fetches failed (${misses} misses)`);
  }

  return { quotes, rateLimited: false };
}

function validate(data) {
  return Array.isArray(data?.quotes) && data.quotes.length >= 1;
}

runSeed('market', 'gulf-quotes', CANONICAL_KEY, fetchGulfQuotes, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'yahoo-chart',
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
