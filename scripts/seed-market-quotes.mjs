#!/usr/bin/env node

import { loadEnvFile, loadSharedConfig, CHROME_UA, sleep, runSeed, parseYahooChart, writeExtraKey } from './_seed-utils.mjs';

const stocksConfig = loadSharedConfig('stocks.json');

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'market:stocks-bootstrap:v1';
const CACHE_TTL = 1800;
const YAHOO_DELAY_MS = 200;

const MARKET_SYMBOLS = stocksConfig.symbols.map(s => s.symbol);

const YAHOO_ONLY = new Set(stocksConfig.yahooOnly);

async function fetchFinnhubQuote(symbol, apiKey) {
  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, 'X-Finnhub-Token': apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.c === 0 && data.h === 0 && data.l === 0) return null;
    return { symbol, name: symbol, display: symbol, price: data.c, change: data.dp, sparkline: [] };
  } catch (err) {
    console.warn(`  [Finnhub] ${symbol} error: ${err.message}`);
    return null;
  }
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

async function fetchYahooQuote(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
    const resp = await fetchYahooWithRetry(url, symbol);
    if (!resp) return null;
    return parseYahooChart(await resp.json(), symbol);
  } catch (err) {
    console.warn(`  [Yahoo] ${symbol} error: ${err.message}`);
    return null;
  }
}

async function fetchMarketQuotes() {
  const quotes = [];
  const apiKey = process.env.FINNHUB_API_KEY;
  const finnhubSymbols = MARKET_SYMBOLS.filter((s) => !YAHOO_ONLY.has(s));
  const yahooSymbols = MARKET_SYMBOLS.filter((s) => YAHOO_ONLY.has(s));

  if (apiKey && finnhubSymbols.length > 0) {
    for (let i = 0; i < finnhubSymbols.length; i++) {
      if (i > 0 && i % 10 === 0) await sleep(100);
      const r = await fetchFinnhubQuote(finnhubSymbols[i], apiKey);
      if (r) {
        quotes.push(r);
        console.log(`  [Finnhub] ${r.symbol}: $${r.price} (${r.change > 0 ? '+' : ''}${r.change}%)`);
      }
    }
  }

  const missedFinnhub = apiKey
    ? finnhubSymbols.filter((s) => !quotes.some((q) => q.symbol === s))
    : finnhubSymbols;
  const allYahoo = [...yahooSymbols, ...missedFinnhub];

  for (let i = 0; i < allYahoo.length; i++) {
    const s = allYahoo[i];
    if (quotes.some((q) => q.symbol === s)) continue;
    if (i > 0) await sleep(YAHOO_DELAY_MS);
    const q = await fetchYahooQuote(s);
    if (q) {
      quotes.push(q);
      console.log(`  [Yahoo] ${q.symbol}: $${q.price} (${q.change > 0 ? '+' : ''}${q.change}%)`);
    }
  }

  if (quotes.length === 0) {
    throw new Error('All market quote fetches failed');
  }

  const coveredByYahoo = finnhubSymbols.every((s) => quotes.some((q) => q.symbol === s));
  const skipped = !apiKey && !coveredByYahoo;

  return {
    quotes,
    finnhubSkipped: skipped,
    skipReason: skipped ? 'FINNHUB_API_KEY not configured' : '',
    rateLimited: false,
  };
}

function validate(data) {
  return Array.isArray(data?.quotes) && data.quotes.length >= 1;
}

let seedData = null;

async function fetchAndStash() {
  seedData = await fetchMarketQuotes();
  return seedData;
}

runSeed('market', 'quotes', CANONICAL_KEY, fetchAndStash, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'yahoo+finnhub',
}).then(async (result) => {
  if (result?.skipped || !seedData) return;
  const rpcKey = `market:quotes:v1:${[...MARKET_SYMBOLS].sort().join(',')}`;
  await writeExtraKey(rpcKey, seedData, CACHE_TTL);
}).catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
