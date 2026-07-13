#!/usr/bin/env node

import { loadEnvFile, loadSharedConfig, sleep, CHROME_UA, runSeed, parseYahooChart, writeExtraKey, extendExistingTtl, readCanonicalEnvelopeMeta, readSeedSnapshot, writeFreshnessMetadata } from './_seed-utils.mjs';
import { fetchYahooJson } from './_yahoo-fetch.mjs';
import { fetchAvBulkQuotes } from './_shared-av.mjs';
import { getUsEquitySession, isMultiMarketEquityTradingDay } from './shared/market-hours.cjs';
import { mergeLastGoodQuotes } from './shared/market-quote-refresh.cjs';

const stocksConfig = loadSharedConfig('stocks.json');

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'market:stocks-bootstrap:v1';
const CACHE_TTL = 1800;
const YAHOO_DELAY_MS = 200;

const MARKET_SYMBOLS = stocksConfig.symbols.map(s => s.symbol);
const RPC_KEY = `market:quotes:v1:${[...MARKET_SYMBOLS].sort().join(',')}`;

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

async function fetchYahooQuote(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
    const chart = await fetchYahooJson(url, { label: symbol });
    return parseYahooChart(chart, symbol);
  } catch (err) {
    console.warn(`  [Yahoo] ${symbol} error: ${err.message}`);
    return null;
  }
}

async function fetchMarketQuotes() {
  const previousPayloadPromise = readSeedSnapshot(CANONICAL_KEY);
  const quotes = [];
  const avKey = process.env.ALPHA_VANTAGE_API_KEY;
  const finnhubKey = process.env.FINNHUB_API_KEY;

  // --- Primary: Alpha Vantage REALTIME_BULK_QUOTES ---
  if (avKey) {
    // AV doesn't support Indian NSE symbols or Yahoo-only indices — skip those
    const avSymbols = MARKET_SYMBOLS.filter((s) => !YAHOO_ONLY.has(s) && !s.endsWith('.NS'));
    const avResults = await fetchAvBulkQuotes(avSymbols, avKey);
    for (const [sym, q] of avResults) {
      const meta = stocksConfig.symbols.find(s => s.symbol === sym);
      quotes.push({ symbol: sym, name: meta?.name || sym, display: meta?.display || sym, price: q.price, change: q.change, sparkline: [] });
      console.log(`  [AV] ${sym}: $${q.price} (${q.change > 0 ? '+' : ''}${q.change.toFixed(2)}%)`);
    }
  }

  const covered = new Set(quotes.map((q) => q.symbol));

  // --- Secondary: Finnhub (for any stocks not covered by AV or if AV key not set) ---
  if (finnhubKey) {
    const finnhubSymbols = MARKET_SYMBOLS.filter((s) => !covered.has(s) && !YAHOO_ONLY.has(s));
    for (let i = 0; i < finnhubSymbols.length; i++) {
      if (i > 0 && i % 10 === 0) await sleep(100);
      const r = await fetchFinnhubQuote(finnhubSymbols[i], finnhubKey);
      if (r) {
        quotes.push(r);
        covered.add(r.symbol);
        console.log(`  [Finnhub] ${r.symbol}: $${r.price} (${r.change > 0 ? '+' : ''}${r.change}%)`);
      }
    }
  }

  // --- Fallback: Yahoo (for remaining symbols including Yahoo-only and Indian markets) ---
  const allYahoo = MARKET_SYMBOLS.filter((s) => !covered.has(s));
  for (let i = 0; i < allYahoo.length; i++) {
    const s = allYahoo[i];
    if (i > 0) await sleep(YAHOO_DELAY_MS);
    const q = await fetchYahooQuote(s);
    if (q) {
      const meta = stocksConfig.symbols.find(x => x.symbol === s);
      quotes.push({ ...q, symbol: s, name: meta?.name || s, display: meta?.display || s });
      covered.add(s);
      console.log(`  [Yahoo] ${s}: $${q.price} (${q.change > 0 ? '+' : ''}${q.change}%)`);
    }
  }

  if (quotes.length === 0) {
    throw new Error('All market quote fetches failed');
  }

  const previousPayload = await previousPayloadPromise;
  const previousQuotes = Array.isArray(previousPayload?.quotes) ? previousPayload.quotes : [];
  const mergedQuotes = mergeLastGoodQuotes(MARKET_SYMBOLS, quotes, previousQuotes);
  const retainedCount = mergedQuotes.length - quotes.length;
  if (retainedCount > 0) console.log(`  [last-good] Retained ${retainedCount} quotes missing from this refresh`);

  return {
    quotes: mergedQuotes,
    finnhubSkipped: !finnhubKey && !avKey,
    skipReason: (!finnhubKey && !avKey) ? 'ALPHA_VANTAGE_API_KEY and FINNHUB_API_KEY not configured' : '',
    rateLimited: false,
  };
}

function validate(data) {
  return Array.isArray(data?.quotes) && data.quotes.length >= 1;
}

export function declareRecords(data) {
  return Array.isArray(data?.quotes) ? data.quotes.length : 0;
}


// #4922d: when every tracked exchange is on a non-trading day, the last
// published close IS the current truth — skip the upstream fetch entirely and
// keep last-good alive with the same TTL-extension helper the runSeed phase-1
// graceful (exit-75) path uses, plus a seed-meta refresh so freshness
// monitors stay green over a 60h+ weekend. Exit 0, NEVER 75 — a recurring 75
// is classified as a chronic crash by the fleet diagnoser. Gated on the
// MULTI-MARKET TRADING DAY, not the US session: the symbol list also includes
// NSE, mainland-China, and Hong Kong tickers that can trade on NYSE holidays.
// If last-good is missing/expired (fresh Redis, weekend deploy), fall
// through to a real fetch so the keys repopulate. We only report fresh and
// exit(0) when the TTL extension actually CONFIRMS (every key still alive and
// re-expired) — a silently-failed extension must not refresh seed-meta and
// leave health monitors green over a canonical key that then lapses.
if (!isMultiMarketEquityTradingDay()) {
  const lastGood = await readCanonicalEnvelopeMeta(CANONICAL_KEY);
  if (lastGood) {
    const extended = await extendExistingTtl([CANONICAL_KEY, 'seed-meta:market:stocks', RPC_KEY], CACHE_TTL);
    if (extended) {
      await writeFreshnessMetadata('market', 'stocks', lastGood.recordCount, lastGood.sourceVersion || 'alphavantage+finnhub+yahoo', CACHE_TTL);
      console.log(`[seed-market-quotes] Tracked equity markets closed (US session=${getUsEquitySession()}) — skipping upstream fetch, extended TTL`);
      process.exit(0);
    }
    console.warn('[seed-market-quotes] Tracked equity markets closed but TTL extension did not confirm all keys — fetching to repopulate');
  } else {
    console.warn('[seed-market-quotes] Tracked equity markets closed but no last-good canonical data — fetching anyway');
  }
}

async function writeRequiredCompanionKeys(data) {
  if (!data) return;
  await writeExtraKey(RPC_KEY, data, CACHE_TTL);
}

runSeed('market', 'stocks', CANONICAL_KEY, fetchMarketQuotes, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'alphavantage+finnhub+yahoo',
  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 30,
  afterPublish: async (data) => {
    // runSeed exits the process on success; required companion writes must be
    // awaited here so the RPC key is published before the terminal exit.
    await writeRequiredCompanionKeys(data);
  },
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
