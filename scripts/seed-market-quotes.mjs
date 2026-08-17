#!/usr/bin/env node

import { loadEnvFile, loadSharedConfig, sleep, runSeed, parseYahooChart, writeExtraKey, extendExistingTtl, extendExistingTtlDetailed, readCanonicalEnvelopeMeta, readSeedSnapshot, writeFreshnessMetadata, writeFreshnessMetadataSafely } from './_seed-utils.mjs';
import { fetchYahooJson } from './_yahoo-fetch.mjs';
import { buildCountryStockIndexSnapshot, countryStockIndexKey } from './_country-stock-index.mjs';
import { loadCountryStockIndexes } from './_country-stock-index-registry.mjs';
import { getUsEquitySession, isMultiMarketEquityTradingDay } from './shared/market-hours.cjs';
import { mergeLastGoodQuotes } from './shared/market-quote-refresh.cjs';
import {
  authorizedProvidersMissingReason,
  fetchAuthorizedEquityQuotes,
  hasSufficientFreshQuoteCoverage,
} from './shared/market-quote-provider.mjs';

const stocksConfig = loadSharedConfig('stocks.json');

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'market:stocks-bootstrap:v1';
const CACHE_TTL = 1800;
const YAHOO_DELAY_MS = 200;
const FRESH_QUOTE_COUNT = Symbol('freshQuoteCount');

// #6235: the RPC answers a bounded 45-country enum, so every country is
// seedable. Previously only CN was seeded and the other 44 lazy-fetched Yahoo
// at the edge, leaving a cold Vercel isolate with no fallback at all.
const COUNTRY_STOCK_INDEXES = loadCountryStockIndexes();
const COUNTRY_STOCK_INDEX_KEYS = COUNTRY_STOCK_INDEXES.map(index => countryStockIndexKey(index.code));

const MARKET_SYMBOLS = stocksConfig.symbols.map(s => s.symbol);
const RPC_KEY = `market:quotes:v1:${[...MARKET_SYMBOLS].sort().join(',')}`;

const YAHOO_ONLY = new Set(stocksConfig.yahooOnly);

const META_BY_SYMBOL = new Map(
  stocksConfig.symbols.map((s) => [s.symbol, { name: s.name, display: s.display }]),
);

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

/**
 * Seed path uses the shared authorized provider adapter (#6304): Alpha Vantage
 * bulk → Finnhub residual → optional Yahoo residual for yahooOnly / regional
 * listings. Provider-specific response shapes never leak past the adapter.
 */
async function fetchMarketQuotes() {
  const previousPayloadPromise = readSeedSnapshot(CANONICAL_KEY);
  const avKey = process.env.ALPHA_VANTAGE_API_KEY;
  const finnhubKey = process.env.FINNHUB_API_KEY;

  const { quotes, providersUsed } = await fetchAuthorizedEquityQuotes({
    symbols: MARKET_SYMBOLS,
    yahooOnly: YAHOO_ONLY,
    metaBySymbol: META_BY_SYMBOL,
    alphaVantageKey: avKey,
    finnhubKey,
    fetchYahooQuote,
    yahooDelayMs: YAHOO_DELAY_MS,
  });

  if (quotes.length === 0) {
    throw new Error('All market quote fetches failed');
  }

  const previousPayload = await previousPayloadPromise;
  const previousQuotes = Array.isArray(previousPayload?.quotes) ? previousPayload.quotes : [];
  const mergedQuotes = mergeLastGoodQuotes(MARKET_SYMBOLS, quotes, previousQuotes);
  const retainedCount = mergedQuotes.length - quotes.length;
  if (retainedCount > 0) console.log(`  [last-good] Retained ${retainedCount} quotes missing from this refresh`);
  if (providersUsed.length > 0) {
    console.log(`  [providers] ${providersUsed.join(' → ')}`);
  }

  return {
    quotes: mergedQuotes,
    finnhubSkipped: !finnhubKey && !avKey,
    skipReason: (!finnhubKey && !avKey) ? authorizedProvidersMissingReason() : '',
    rateLimited: false,
    // Symbols are deliberately omitted by JSON.stringify, so this proof is
    // available to validateFn at the publication boundary but never changes
    // the public cache contract.
    [FRESH_QUOTE_COUNT]: quotes.length,
  };
}

function validate(data) {
  return Array.isArray(data?.quotes)
    && hasSufficientFreshQuoteCoverage(data[FRESH_QUOTE_COUNT], MARKET_SYMBOLS.length);
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
