#!/usr/bin/env node

/**
 * Seed REIT quotes from Yahoo Finance.
 * Fetches price, change%, dividend yield, and sparkline for 41 REIT symbols
 * (32 US + 9 China consumer/rental).
 *
 * Redis key: reits:quotes:v1 (TTL 1800s / 30min)
 */

import { loadEnvFile, loadSharedConfig, CHROME_UA, sleep, runSeed, parseYahooChart } from './_seed-utils.mjs';

const reitsConfig = loadSharedConfig('reits.json');

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'reits:quotes:v1';
const CACHE_TTL = 1800;
const YAHOO_DELAY_MS = 250;

const ALL_SYMBOLS = reitsConfig.symbols;
const SECTOR_MAP = Object.fromEntries(ALL_SYMBOLS.map(s => [s.symbol, s]));

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

async function fetchReitQuote(symbolConfig) {
  const { symbol, name, display, sector, market } = symbolConfig;
  try {
    // Yahoo Finance uses .SS for Shanghai, .SZ for Shenzhen — symbols already correct
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d`;
    const resp = await fetchYahooWithRetry(url, symbol);
    if (!resp) return null;

    const data = await resp.json();
    const parsed = parseYahooChart(data, symbol);
    if (!parsed) return null;

    // Extract dividend yield from Yahoo Finance summary
    const meta = data?.chart?.result?.[0]?.meta;
    const dividendYield = meta?.trailingAnnualDividendYield
      ? +(meta.trailingAnnualDividendYield * 100).toFixed(2)
      : 0;

    return {
      symbol,
      name,
      display,
      sector,
      market: market || 'us',
      price: parsed.price,
      change: parsed.change,
      dividendYield,
      sparkline: parsed.sparkline,
      disasterExposureScore: 0, // filled by seed-reit-properties.mjs
    };
  } catch (err) {
    console.warn(`  [Yahoo] ${symbol} error: ${err.message}`);
    return null;
  }
}

async function fetchAllReitQuotes() {
  const quotes = [];

  for (let i = 0; i < ALL_SYMBOLS.length; i++) {
    if (i > 0) await sleep(YAHOO_DELAY_MS);
    const q = await fetchReitQuote(ALL_SYMBOLS[i]);
    if (q) {
      quotes.push(q);
      const currency = q.market === 'china' ? '¥' : '$';
      console.log(`  [Yahoo] ${q.symbol} (${q.sector}): ${currency}${q.price} (${q.change > 0 ? '+' : ''}${q.change}%) yield=${q.dividendYield}%`);
    }
  }

  if (quotes.length === 0) {
    throw new Error('All REIT quote fetches failed');
  }

  return {
    quotes,
    stale: false,
    lastUpdated: new Date().toISOString(),
  };
}

function validate(data) {
  return Array.isArray(data?.quotes) && data.quotes.length >= 1;
}

runSeed('reits', 'quotes', CANONICAL_KEY, fetchAllReitQuotes, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'yahoo-v1',
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
