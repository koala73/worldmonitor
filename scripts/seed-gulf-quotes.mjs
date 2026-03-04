#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'market:gulf-quotes:v1';
const CACHE_TTL = 3600;
const YAHOO_DELAY_MS = 200;

const GULF_SYMBOLS = [
  { symbol: '^TASI.SR', name: 'Tadawul All Share', country: 'Saudi Arabia', flag: '\u{1F1F8}\u{1F1E6}', type: 'index' },
  { symbol: 'DFMGI.AE', name: 'Dubai Financial Market', country: 'UAE', flag: '\u{1F1E6}\u{1F1EA}', type: 'index' },
  { symbol: 'UAE', name: 'Abu Dhabi (iShares)', country: 'UAE', flag: '\u{1F1E6}\u{1F1EA}', type: 'index' },
  { symbol: 'QAT', name: 'Qatar (iShares)', country: 'Qatar', flag: '\u{1F1F6}\u{1F1E6}', type: 'index' },
  { symbol: 'GULF', name: 'Gulf Dividend (WisdomTree)', country: 'Kuwait', flag: '\u{1F1F0}\u{1F1FC}', type: 'index' },
  { symbol: '^MSM', name: 'Muscat MSM 30', country: 'Oman', flag: '\u{1F1F4}\u{1F1F2}', type: 'index' },
  { symbol: 'SARUSD=X', name: 'Saudi Riyal', country: 'Saudi Arabia', flag: '\u{1F1F8}\u{1F1E6}', type: 'currency' },
  { symbol: 'AEDUSD=X', name: 'UAE Dirham', country: 'UAE', flag: '\u{1F1E6}\u{1F1EA}', type: 'currency' },
  { symbol: 'QARUSD=X', name: 'Qatari Riyal', country: 'Qatar', flag: '\u{1F1F6}\u{1F1E6}', type: 'currency' },
  { symbol: 'KWDUSD=X', name: 'Kuwaiti Dinar', country: 'Kuwait', flag: '\u{1F1F0}\u{1F1FC}', type: 'currency' },
  { symbol: 'BHDUSD=X', name: 'Bahraini Dinar', country: 'Bahrain', flag: '\u{1F1E7}\u{1F1ED}', type: 'currency' },
  { symbol: 'OMRUSD=X', name: 'Omani Rial', country: 'Oman', flag: '\u{1F1F4}\u{1F1F2}', type: 'currency' },
  { symbol: 'CL=F', name: 'WTI Crude', country: '', flag: '\u{1F6E2}\u{FE0F}', type: 'oil' },
  { symbol: 'BZ=F', name: 'Brent Crude', country: '', flag: '\u{1F6E2}\u{FE0F}', type: 'oil' },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
      const resp = await fetch(url, {
        headers: { 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        console.warn(`  [Yahoo] ${meta.symbol} HTTP ${resp.status}`);
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
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
