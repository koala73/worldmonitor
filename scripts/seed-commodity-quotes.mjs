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

// Alpha Vantage physical commodity function map
const AV_PHYSICAL_MAP = {
  'CL=F': 'WTI',
  'BZ=F': 'BRENT',
  'NG=F': 'NATURAL_GAS',
  'HG=F': 'COPPER',
  'ALI=F': 'ALUMINUM',
};

async function fetchAvPhysicalCommodity(yahooSymbol, apiKey) {
  const fn = AV_PHYSICAL_MAP[yahooSymbol];
  if (!fn) return null;
  try {
    const url = `https://www.alphavantage.co/query?function=${fn}&interval=daily&apikey=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) { console.warn(`  [AV] ${fn} HTTP ${resp.status}`); return null; }
    const json = await resp.json();
    const data = json.data;
    if (!Array.isArray(data) || data.length < 2) return null;
    const latest = parseFloat(data[0].value);
    const prev = parseFloat(data[1].value);
    if (!Number.isFinite(latest) || latest <= 0) return null;
    const change = (Number.isFinite(prev) && prev > 0) ? ((latest - prev) / prev) * 100 : 0;
    const meta = commodityConfig.commodities.find(c => c.symbol === yahooSymbol);
    return { symbol: yahooSymbol, name: meta?.name || yahooSymbol, display: meta?.display || yahooSymbol, price: latest, change, sparkline: [] };
  } catch (err) {
    console.warn(`  [AV] ${fn} error: ${err.message}`);
    return null;
  }
}

async function fetchAvBulkQuotes(symbols, apiKey) {
  if (symbols.length === 0) return new Map();
  const results = new Map();
  const url = `https://www.alphavantage.co/query?function=REALTIME_BULK_QUOTES&symbol=${encodeURIComponent(symbols.join(','))}&apikey=${encodeURIComponent(apiKey)}`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) { console.warn(`  [AV] Bulk quotes HTTP ${resp.status}`); return results; }
    const json = await resp.json();
    if (!Array.isArray(json.data)) return results;
    for (const item of json.data) {
      const price = parseFloat(item.price);
      const prevClose = parseFloat(item['previous close']);
      const changePct = (Number.isFinite(prevClose) && prevClose > 0)
        ? ((price - prevClose) / prevClose) * 100
        : parseFloat((item['change percent'] || '0').replace('%', ''));
      if (Number.isFinite(price) && price > 0) {
        const meta = commodityConfig.commodities.find(c => c.symbol === item.symbol);
        results.set(item.symbol, { symbol: item.symbol, name: meta?.name || item.symbol, display: meta?.display || item.symbol, price, change: Number.isFinite(changePct) ? changePct : 0, sparkline: [] });
      }
    }
  } catch (err) {
    console.warn(`  [AV] Bulk quotes error: ${err.message}`);
  }
  return results;
}

async function fetchCommodityQuotes() {
  const quotes = [];
  let misses = 0;
  const avKey = process.env.ALPHA_VANTAGE_API_KEY;

  // --- Primary: Alpha Vantage ---
  if (avKey) {
    // Physical commodity functions for WTI, BRENT, NATURAL_GAS, COPPER, ALUMINUM
    const physicalSymbols = COMMODITY_SYMBOLS.filter(s => AV_PHYSICAL_MAP[s]);
    for (const sym of physicalSymbols) {
      const q = await fetchAvPhysicalCommodity(sym, avKey);
      if (q) {
        quotes.push(q);
        console.log(`  [AV:physical] ${sym}: $${q.price} (${q.change > 0 ? '+' : ''}${q.change.toFixed(2)}%)`);
      }
    }

    // REALTIME_BULK_QUOTES for ETF-style symbols (URA, LIT) and ^VIX (if supported)
    const bulkCandidates = COMMODITY_SYMBOLS.filter(s => !AV_PHYSICAL_MAP[s] && !quotes.some(q => q.symbol === s) && !s.includes('=F') && !s.startsWith('^'));
    const bulkResults = await fetchAvBulkQuotes(bulkCandidates, avKey);
    for (const [sym, q] of bulkResults) {
      quotes.push(q);
      console.log(`  [AV:bulk] ${sym}: $${q.price} (${q.change > 0 ? '+' : ''}${q.change.toFixed(2)}%)`);
    }
  }

  const covered = new Set(quotes.map(q => q.symbol));

  // --- Fallback: Yahoo (for remaining symbols: futures not covered by AV, ^VIX, Indian markets) ---
  for (let i = 0; i < COMMODITY_SYMBOLS.length; i++) {
    const symbol = COMMODITY_SYMBOLS[i];
    if (covered.has(symbol)) continue;
    if (i > 0) await sleep(YAHOO_DELAY_MS);

    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
      const resp = await fetchYahooWithRetry(url, symbol);
      if (!resp) { misses++; continue; }
      const parsed = parseYahooChart(await resp.json(), symbol);
      if (parsed) {
        quotes.push(parsed);
        covered.add(symbol);
        console.log(`  [Yahoo] ${symbol}: $${parsed.price} (${parsed.change > 0 ? '+' : ''}${parsed.change}%)`);
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
  sourceVersion: 'alphavantage+yahoo-chart',
}).then(async (result) => {
  if (result?.skipped || !seedData) return;
  const commodityKey = `market:commodities:v1:${[...COMMODITY_SYMBOLS].sort().join(',')}`;
  const quotesKey = `market:quotes:v1:${[...COMMODITY_SYMBOLS].sort().join(',')}`;
  const quotesPayload = { ...seedData, finnhubSkipped: false, skipReason: '', rateLimited: false };
  await writeExtraKey(commodityKey, seedData, CACHE_TTL);
  await writeExtraKey(quotesKey, quotesPayload, CACHE_TTL);
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
