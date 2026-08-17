/**
 * #6305 acceptance: two valid non-default symbols can be saved, requested, and
 * returned together with the defaults.
 *
 * This walks the real chain end to end — the shipped default universe from
 * `shared/stocks.json`, the watchlist merge the dashboard performs, and the
 * handler that answers the resulting request — because the bug needed BOTH
 * halves to be wrong at once and either fix alone still loses the symbol:
 *
 *   - the merge capped the default-plus-custom array at 50 while the defaults
 *     already numbered 59, so at most one custom ticker was ever forwarded;
 *   - the handler filtered the fixed seed snapshot and dropped anything absent
 *     from it, with no error and no missing-symbol signal.
 *
 * Panel rendering of the returned quotes and of the `unavailable` list is
 * covered in tests/market-panel-unavailable-symbols.test.mts.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  ListMarketQuotesResponse,
  ServerContext,
} from '../src/generated/server/worldmonitor/market/v1/service_server';
import {
  __clearLocalUnavailableBackoffForTests,
  __resetKeyPrefixCacheForTests,
} from '../server/_shared/redis';
import { listMarketQuotes } from '../server/worldmonitor/market/v1/list-market-quotes';
import {
  MARKET_WATCHLIST_MAX_ENTRIES,
  mergeWatchlistSymbols,
  normalizeWatchlistEntries,
  type MarketSymbolMeta,
} from '../src/services/market-watchlist.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STOCK_CONFIG = JSON.parse(readFileSync(resolve(root, 'shared/stocks.json'), 'utf8')) as {
  symbols: MarketSymbolMeta[];
  defaultSymbols: string[];
};
const CATALOG_BY_SYMBOL = new Map(STOCK_CONFIG.symbols.map((entry) => [entry.symbol, entry]));
const DEFAULTS: MarketSymbolMeta[] = STOCK_CONFIG.defaultSymbols.map((symbol) => CATALOG_BY_SYMBOL.get(symbol)!);

const CTX = {} as ServerContext;
const BOOTSTRAP_KEY = 'market:stocks-bootstrap:v1';

const ORIGINAL_ENV = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  VERCEL_ENV: process.env.VERCEL_ENV,
  LOCAL_API_MODE: process.env.LOCAL_API_MODE,
  FINNHUB_API_KEY: process.env.FINNHUB_API_KEY,
};
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_WARN = console.warn;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  console.warn = ORIGINAL_WARN;
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  __resetKeyPrefixCacheForTests();
  __clearLocalUnavailableBackoffForTests();
});

/** Seed snapshot carrying exactly the shipped default universe, as Railway writes it. */
function defaultSeed(): ListMarketQuotesResponse {
  return {
    quotes: DEFAULTS.map((meta, i) => ({
      symbol: meta.symbol,
      name: meta.name,
      display: meta.display,
      price: 100 + i,
      change: 0.5,
      sparkline: [],
    })),
    finnhubSkipped: false,
    skipReason: '',
    rateLimited: false,
    unavailableSymbols: [],
  };
}

/** Redis + provider doubles; the provider answers only the listed symbols. */
function installHarness(providerSymbols: string[]): { finnhubCalls: string[] } {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  process.env.VERCEL_ENV = 'production';
  process.env.FINNHUB_API_KEY = 'test-finnhub-key';
  delete process.env.LOCAL_API_MODE;
  __resetKeyPrefixCacheForTests();

  const redis = new Map<string, unknown>([[BOOTSTRAP_KEY, defaultSeed()]]);
  const known = new Set(providerSymbols);
  const finnhubCalls: string[] = [];
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

  globalThis.fetch = (async (input: RequestInfo | URL, opts?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://redis.example.test/get/')) {
      const key = decodeURIComponent(url.slice('https://redis.example.test/get/'.length));
      const value = redis.get(key);
      return json({ result: value === undefined ? null : JSON.stringify(value) });
    }
    if (url === 'https://redis.example.test/') {
      const [, key, value] = JSON.parse(String(opts?.body)) as [string, string, string];
      redis.set(key, JSON.parse(value));
      return json({ result: 'OK' });
    }
    if (url.startsWith('https://finnhub.io/api/v1/quote')) {
      const symbol = decodeURIComponent(new URL(url).searchParams.get('symbol') ?? '');
      finnhubCalls.push(symbol);
      // Finnhub answers an unknown ticker with zeros rather than a 404.
      return known.has(symbol) ? json({ c: 42, dp: 1.5, h: 43, l: 41 }) : json({ c: 0, dp: 0, h: 0, l: 0 });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;

  console.warn = () => {};
  return { finnhubCalls };
}

describe('custom watchlist symbols reach the response (#6305)', () => {
  it('returns two saved custom tickers alongside every default', async () => {
    const harness = installHarness(['RIVN', 'PLTR']);

    // 1. Save — what the watchlist editor persists.
    const saved = normalizeWatchlistEntries([
      { symbol: 'RIVN', name: 'Rivian' },
      { symbol: 'PLTR', name: 'Palantir' },
    ]);
    assert.equal(saved.length, 2, 'both picks must survive storage normalization');

    // 2. Merge — what the dashboard requests.
    const requested = mergeWatchlistSymbols(DEFAULTS, saved);
    assert.equal(requested.length, DEFAULTS.length + 2, 'both customs must be forwarded, not just the first');

    // 3. Request + return.
    const resp = await listMarketQuotes(CTX, { symbols: requested.map((s) => s.symbol) });

    const returned = resp.quotes.map((q) => q.symbol);
    assert.equal(returned.length, DEFAULTS.length + 2);
    assert.deepEqual(returned.slice(0, DEFAULTS.length), DEFAULTS.map((s) => s.symbol));
    assert.deepEqual(returned.slice(-2), ['RIVN', 'PLTR']);
    assert.deepEqual(resp.unavailableSymbols, [], 'nothing requested may go unreported');

    // Only the two seed misses cost an upstream call — the 59 defaults are free.
    assert.deepEqual(harness.finnhubCalls.sort(), ['PLTR', 'RIVN']);
  });

  it('reports a saved ticker the provider cannot resolve instead of dropping it', async () => {
    installHarness(['RIVN']);

    const saved = normalizeWatchlistEntries([{ symbol: 'RIVN' }, { symbol: 'NOSUCHTICKER' }]);
    const requested = mergeWatchlistSymbols(DEFAULTS, saved);

    const resp = await listMarketQuotes(CTX, { symbols: requested.map((s) => s.symbol) });

    assert.ok(resp.quotes.some((q) => q.symbol === 'RIVN'));
    assert.ok(!resp.quotes.some((q) => q.symbol === 'NOSUCHTICKER'));
    assert.deepEqual(resp.unavailableSymbols, [
      { symbol: 'NOSUCHTICKER', reason: 'MARKET_QUOTE_UNAVAILABLE_REASON_NOT_FOUND' },
    ]);
  });

  it('keeps a full 50-entry watchlist inside the handler cardinality bound', async () => {
    // The two bounds have to agree: 59 defaults plus a saturated custom list
    // must still fit under the handler's per-request symbol cap, or a legitimate
    // Pro watchlist would report its own tail as REQUEST_LIMIT_EXCEEDED.
    const saturated = normalizeWatchlistEntries(
      Array.from({ length: MARKET_WATCHLIST_MAX_ENTRIES + 10 }, (_, i) => ({ symbol: `SYM${i}` })),
    );
    installHarness([]);

    const requested = mergeWatchlistSymbols(DEFAULTS, saturated);
    assert.equal(requested.length, DEFAULTS.length + MARKET_WATCHLIST_MAX_ENTRIES);

    const resp = await listMarketQuotes(CTX, { symbols: requested.map((s) => s.symbol) });

    assert.equal(
      resp.unavailableSymbols.filter((u) => u.reason === 'MARKET_QUOTE_UNAVAILABLE_REASON_REQUEST_LIMIT_EXCEEDED').length,
      0,
      'a maximal watchlist must not exceed the handler request bound',
    );
    assert.equal(resp.quotes.length, DEFAULTS.length, 'the defaults still resolve from the seed');
  });
});
