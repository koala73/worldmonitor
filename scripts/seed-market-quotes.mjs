#!/usr/bin/env node

import { loadEnvFile, loadSharedConfig, sleep, CHROME_UA, runSeed, parseYahooChart, writeExtraKey, extendExistingTtl, extendExistingTtlDetailed, readCanonicalEnvelopeMeta, readSeedSnapshot, writeFreshnessMetadata, writeFreshnessMetadataSafely } from './_seed-utils.mjs';
import { fetchYahooJson } from './_yahoo-fetch.mjs';
import { fetchAvBulkQuotes } from './_shared-av.mjs';
import { buildCountryStockIndexSnapshot, countryStockIndexKey } from './_country-stock-index.mjs';
import { loadCountryStockIndexes } from './_country-stock-index-registry.mjs';
import { getUsEquitySession, isMultiMarketEquityTradingDay } from './shared/market-hours.cjs';
import { mergeLastGoodQuotes } from './shared/market-quote-refresh.cjs';

const stocksConfig = loadSharedConfig('stocks.json');

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'market:stocks-bootstrap:v1';
const CACHE_TTL = 1800;
const YAHOO_DELAY_MS = 200;

// #6235: the RPC answers a bounded 45-country enum, so every country is
// seedable. Previously only CN was seeded and the other 44 lazy-fetched Yahoo
// at the edge, leaving a cold Vercel isolate with no fallback at all.
const COUNTRY_STOCK_INDEXES = loadCountryStockIndexes();
const COUNTRY_STOCK_INDEX_KEYS = COUNTRY_STOCK_INDEXES.map(index => countryStockIndexKey(index.code));

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
    // Gate the fast path on the canonical keys ONLY. Country-index keys are
    // best-effort by design — several countries in the enum have no
    // Yahoo-serviceable symbol, so their keys legitimately never exist, and
    // requiring all 45 to extend would make this branch never confirm and
    // force a full fetch on every closed day.
    const extended = await extendExistingTtl([CANONICAL_KEY, 'seed-meta:market:stocks', RPC_KEY], CACHE_TTL);
    if (extended) {
      const countryTtl = await extendExistingTtlDetailed(COUNTRY_STOCK_INDEX_KEYS, CACHE_TTL);
      await writeFreshnessMetadata('market', 'stocks', lastGood.recordCount, lastGood.sourceVersion || 'alphavantage+finnhub+yahoo', CACHE_TTL);
      // The country-index caches were just TTL-extended alongside the canonical
      // keys, so their freshness must be refreshed on this path too — otherwise
      // seed-meta ages across a 60h+ weekend and alarms on data that is present
      // and deliberately preserved. recordCount is the count actually extended,
      // never the size of the work-list.
      await writeFreshnessMetadataSafely(
        'market',
        'country-indexes',
        countryTtl.extendedKeys.length,
        'yahoo',
        CACHE_TTL,
      );
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
  await writeCountryStockIndexes();
}

/**
 * Seed every country in the public enum, best-effort and independently.
 *
 * One country's provider failure must not cost the other 44 their refresh, and
 * must not turn an otherwise successful global market seed into a false
 * outage — so each leg preserves its own last-good TTL and the pass reports a
 * summary instead of throwing. Countries that fail here still answer via the
 * RPC's own live fetch, which remains as a gap-filler.
 *
 * Because the pass never throws, it MUST publish its own freshness metadata:
 * without it a run where every country failed would leave
 * `seed-meta:market:stocks` fresh and health green while the country-index
 * caches quietly expired — the RPC would silently revert to fetching Yahoo per
 * request, which is the exact regression this seeding exists to prevent.
 */
async function writeCountryStockIndexes() {
  const failures = [];

  for (const index of COUNTRY_STOCK_INDEXES) {
    const key = countryStockIndexKey(index.code);
    try {
      await sleep(YAHOO_DELAY_MS);
      const chart = await fetchYahooJson(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(index.symbol)}?range=1mo&interval=1d`,
        { label: `${index.code} country index` },
      );
      const snapshot = buildCountryStockIndexSnapshot(chart, undefined, index);
      if (!snapshot) throw new Error('insufficient closes');
      await writeExtraKey(key, snapshot, CACHE_TTL);
    } catch (err) {
      // Preserve last-good long enough for the audit's content-age budget to
      // distinguish a transient provider error from a missing cache.
      const preserved = await extendExistingTtl([key], CACHE_TTL);
      failures.push(`${index.code} (${err.message}${preserved ? ', preserved last-good' : ', no last-good'})`);
    }
  }

  const seeded = COUNTRY_STOCK_INDEXES.length - failures.length;
  if (failures.length > 0) {
    console.warn(
      `[seed-market-quotes] Country index refresh: ${seeded}/${COUNTRY_STOCK_INDEXES.length} seeded; `
      + `failed: ${failures.join(', ')}`,
    );
  } else {
    console.log(`[seed-market-quotes] Country index refresh: ${seeded}/${COUNTRY_STOCK_INDEXES.length} seeded`);
  }

  // recordCount is what /api/health thresholds on, so it must be the count that
  // actually landed in Redis, never the size of the work-list.
  await writeFreshnessMetadataSafely(
    'market',
    'country-indexes',
    seeded,
    'yahoo',
    CACHE_TTL,
  );

  return seeded;
}

runSeed('market', 'stocks', CANONICAL_KEY, fetchMarketQuotes, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'alphavantage+finnhub+yahoo',
  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 30,
  // This companion payload is written after the global market publish because
  // it needs a different Yahoo chart shape. Preserve its last-good TTL across
  // every runSeed graceful path, just like normal extra keys.
  preserveKeys: COUNTRY_STOCK_INDEX_KEYS,
  afterPublish: async (data) => {
    // runSeed exits the process on success; required companion writes must be
    // awaited here so the RPC key is published before the terminal exit.
    await writeRequiredCompanionKeys(data);
  },
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
