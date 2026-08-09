/**
 * #6305: ListMarketQuotes resolves the fixed seed first and fills only the
 * remaining symbols through a bounded, Redis-cached provider adapter.
 *
 * Before this, the handler was a pure filter over `market:stocks-bootstrap:v1`:
 * a valid custom watchlist ticker absent from that snapshot was dropped with no
 * error and no missing-symbol signal, and because the request also carried the
 * defaults the response looked healthy.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type {
  ListMarketQuotesResponse,
  ServerContext,
} from '../src/generated/server/worldmonitor/market/v1/service_server';
import {
  __clearLocalUnavailableBackoffForTests,
  __resetKeyPrefixCacheForTests,
} from '../server/_shared/redis';
import {
  __resetUpstreamDeadlineForTests,
  __setUpstreamDeadlineForTests,
  MARKET_QUOTES_REQUEST_LIMIT,
  MARKET_QUOTES_UPSTREAM_LIMIT,
  filterMarketQuotes,
  listMarketQuotes,
  normalizeRequestedSymbols,
} from '../server/worldmonitor/market/v1/list-market-quotes';

const BOOTSTRAP_KEY = 'market:stocks-bootstrap:v1';
const CTX = {} as ServerContext;

const ORIGINAL_ENV = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  VERCEL_ENV: process.env.VERCEL_ENV,
  VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
  LOCAL_API_MODE: process.env.LOCAL_API_MODE,
  FINNHUB_API_KEY: process.env.FINNHUB_API_KEY,
  ALPHA_VANTAGE_API_KEY: process.env.ALPHA_VANTAGE_API_KEY,
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
  // `cacheFetcherErrors: false` arms a module-level 3s per-key backoff instead
  // of a Redis sentinel. Clearing it keeps each test's provider outcome its
  // own, rather than inheriting a neighbour's throttle.
  __clearLocalUnavailableBackoffForTests();
  __resetUpstreamDeadlineForTests();
});

function quote(symbol: string, price: number) {
  return { symbol, name: symbol, display: symbol, price, change: 1, sparkline: [] };
}

function seedPayload(symbols: string[]): ListMarketQuotesResponse {
  return {
    quotes: symbols.map((symbol, i) => quote(symbol, 100 + i)),
    finnhubSkipped: false,
    skipReason: '',
    rateLimited: false,
    unavailableSymbols: [],
  };
}

type ProviderReply = { status: number; body?: unknown; waitForAbort?: boolean };

interface Harness {
  redis: Map<string, unknown>;
  /** Symbols the fake Finnhub answers, plus how. */
  provider: Map<string, ProviderReply>;
  /** Redis GETs that returned an error response instead of a value. */
  failingRedisKeys: Set<string>;
  finnhubCalls: string[];
  redisSets: Array<{ key: string; value: unknown }>;
}

/**
 * Route the single global fetch to the fake Upstash REST API and the fake
 * Finnhub quote endpoint. Anything else is a test bug and throws loudly.
 */
function installHarness(init: {
  seed?: ListMarketQuotesResponse | null;
  seedFails?: boolean;
  provider?: Record<string, ProviderReply>;
  finnhubKey?: string | null;
}): Harness {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  // Production => empty key prefix, so cache keys in assertions are literal.
  process.env.VERCEL_ENV = 'production';
  delete process.env.LOCAL_API_MODE;
  if (init.finnhubKey === null) delete process.env.FINNHUB_API_KEY;
  else process.env.FINNHUB_API_KEY = init.finnhubKey ?? 'test-finnhub-key';
  // Gap-fetch tests mock Finnhub only; clear any host AV key so the cascade
  // cannot leak to a real Alpha Vantage network call (#6304).
  delete process.env.ALPHA_VANTAGE_API_KEY;
  __resetKeyPrefixCacheForTests();

  const harness: Harness = {
    redis: new Map(),
    provider: new Map(Object.entries(init.provider ?? {})),
    failingRedisKeys: new Set(),
    finnhubCalls: [],
    redisSets: [],
  };
  if (init.seed) harness.redis.set(BOOTSTRAP_KEY, init.seed);
  if (init.seedFails) harness.failingRedisKeys.add(BOOTSTRAP_KEY);

  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

  globalThis.fetch = (async (input: RequestInfo | URL, opts?: RequestInit) => {
    const url = String(input);

    if (url.startsWith('https://redis.example.test/get/')) {
      const key = decodeURIComponent(url.slice('https://redis.example.test/get/'.length));
      if (harness.failingRedisKeys.has(key)) return json({ error: 'simulated redis failure' }, 500);
      const value = harness.redis.get(key);
      return json({ result: value === undefined ? null : JSON.stringify(value) });
    }

    if (url === 'https://redis.example.test/') {
      const [command, key, value] = JSON.parse(String(opts?.body)) as [string, string, string];
      assert.equal(command, 'SET');
      harness.redis.set(key, JSON.parse(value));
      harness.redisSets.push({ key, value: JSON.parse(value) });
      return json({ result: 'OK' });
    }

    if (url.startsWith('https://finnhub.io/api/v1/quote')) {
      const symbol = decodeURIComponent(new URL(url).searchParams.get('symbol') ?? '');
      harness.finnhubCalls.push(symbol);
      const reply = harness.provider.get(symbol);
      // No configured reply => Finnhub's "unknown ticker" all-zero payload.
      if (!reply) return json({ c: 0, dp: 0, h: 0, l: 0 });
      if (reply.waitForAbort) {
        const signal = opts?.signal;
        assert.ok(signal, 'deadline signal must reach the provider fetch');
        return await new Promise<Response>((_resolve, reject) => {
          const onAbort = () => reject(signal.reason);
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        });
      }
      return json(reply.body ?? {}, reply.status);
    }

    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;

  console.warn = () => {};
  return harness;
}

const okQuote = (price: number, changePct: number): ProviderReply => ({
  status: 200,
  body: { c: price, dp: changePct, h: price, l: price },
});

const symbolsOf = (resp: ListMarketQuotesResponse) => resp.quotes.map((q) => q.symbol);
const reasonFor = (resp: ListMarketQuotesResponse, symbol: string) =>
  resp.unavailableSymbols.find((u) => u.symbol === symbol)?.reason;

describe('normalizeRequestedSymbols', () => {
  it('upper-cases, strips whitespace, and de-dupes keeping first-seen order', () => {
    const { accepted, dropped } = normalizeRequestedSymbols([' aapl ', 'MS FT', 'AAPL', '', 'nvda']);
    assert.deepEqual(accepted, ['AAPL', 'MSFT', 'NVDA']);
    assert.deepEqual(dropped, []);
  });

  it('bounds cardinality and reports the overflow instead of truncating silently', () => {
    const many = Array.from({ length: MARKET_QUOTES_REQUEST_LIMIT + 3 }, (_, i) => `S${i}`);
    const { accepted, dropped } = normalizeRequestedSymbols(many);
    assert.equal(accepted.length, MARKET_QUOTES_REQUEST_LIMIT);
    assert.deepEqual(dropped, [
      `S${MARKET_QUOTES_REQUEST_LIMIT}`,
      `S${MARKET_QUOTES_REQUEST_LIMIT + 1}`,
      `S${MARKET_QUOTES_REQUEST_LIMIT + 2}`,
    ]);
  });
});

describe('filterMarketQuotes', () => {
  it('answers in requested order, not seed order', () => {
    const filtered = filterMarketQuotes(seedPayload(['AAPL', 'MSFT', 'NVDA']), ['NVDA', 'AAPL']);
    assert.deepEqual(filtered.quotes.map((q) => q.symbol), ['NVDA', 'AAPL']);
  });

  it('returns the whole snapshot when no symbols are requested', () => {
    const seed = seedPayload(['AAPL', 'MSFT']);
    assert.equal(filterMarketQuotes(seed, []), seed);
  });
});

describe('listMarketQuotes seed-first resolution', () => {
  it('serves seed hits without contacting the provider at all', async () => {
    const h = installHarness({ seed: seedPayload(['AAPL', 'MSFT', 'NVDA']) });

    const resp = await listMarketQuotes(CTX, { symbols: ['NVDA', 'AAPL'] });

    assert.deepEqual(symbolsOf(resp), ['NVDA', 'AAPL']);
    assert.deepEqual(resp.unavailableSymbols, []);
    assert.deepEqual(h.finnhubCalls, []);
  });

  it('returns the seed universe unfiltered when no symbols are requested', async () => {
    installHarness({ seed: seedPayload(['AAPL', 'MSFT']) });
    const resp = await listMarketQuotes(CTX, { symbols: [] });
    assert.deepEqual(symbolsOf(resp), ['AAPL', 'MSFT']);
  });

  it('merges gap-fetched custom symbols with the defaults in requested order', async () => {
    const h = installHarness({
      seed: seedPayload(['AAPL', 'MSFT']),
      provider: { RIVN: okQuote(12.5, -2), PLTR: okQuote(88, 3.25) },
    });

    const resp = await listMarketQuotes(CTX, { symbols: ['AAPL', 'RIVN', 'MSFT', 'PLTR'] });

    assert.deepEqual(symbolsOf(resp), ['AAPL', 'RIVN', 'MSFT', 'PLTR']);
    assert.deepEqual(resp.unavailableSymbols, []);
    assert.deepEqual(h.finnhubCalls.sort(), ['PLTR', 'RIVN']);
    const rivn = resp.quotes.find((q) => q.symbol === 'RIVN');
    assert.equal(rivn?.price, 12.5);
    assert.equal(rivn?.change, -2);
  });

  it('resolves an all-miss request through the provider', async () => {
    installHarness({
      seed: seedPayload(['AAPL']),
      provider: { SOFI: okQuote(9, 1), HOOD: okQuote(40, -1) },
    });

    const resp = await listMarketQuotes(CTX, { symbols: ['SOFI', 'HOOD'] });

    assert.deepEqual(symbolsOf(resp), ['SOFI', 'HOOD']);
    assert.deepEqual(resp.unavailableSymbols, []);
  });

  it('reuses the Redis-cached quote on a repeat request for the same missing symbol', async () => {
    const h = installHarness({ seed: seedPayload(['AAPL']), provider: { CRWV: okQuote(55, 4) } });

    const first = await listMarketQuotes(CTX, { symbols: ['AAPL', 'CRWV'] });
    const second = await listMarketQuotes(CTX, { symbols: ['AAPL', 'CRWV'] });

    assert.deepEqual(symbolsOf(first), ['AAPL', 'CRWV']);
    assert.deepEqual(symbolsOf(second), ['AAPL', 'CRWV']);
    assert.deepEqual(h.finnhubCalls, ['CRWV'], 'the second request must be served from Redis');
    assert.ok(h.redisSets.some((s) => s.key === 'market:custom-quote:v1:CRWV'));
  });

  it('keeps a partial provider failure visible and does not cache it', async () => {
    const h = installHarness({
      seed: seedPayload(['AAPL']),
      provider: { LCID: okQuote(3, 0.5), FUBO: { status: 503 } },
    });

    const resp = await listMarketQuotes(CTX, { symbols: ['AAPL', 'LCID', 'FUBO'] });

    assert.deepEqual(symbolsOf(resp), ['AAPL', 'LCID']);
    assert.equal(reasonFor(resp, 'FUBO'), 'MARKET_QUOTE_UNAVAILABLE_REASON_PROVIDER_ERROR');
    assert.ok(
      !h.redisSets.some((s) => s.key === 'market:custom-quote:v1:FUBO'),
      'a transient provider failure must not be cached — it would pin a real symbol as unavailable',
    );
  });

  it('surfaces a provider rate limit on both the symbol and the response flag', async () => {
    installHarness({ seed: seedPayload(['AAPL']), provider: { AFRM: { status: 429 } } });

    const resp = await listMarketQuotes(CTX, { symbols: ['AAPL', 'AFRM'] });

    assert.equal(reasonFor(resp, 'AFRM'), 'MARKET_QUOTE_UNAVAILABLE_REASON_PROVIDER_RATE_LIMITED');
    assert.equal(resp.rateLimited, true);
  });

  it('reports a symbol the provider does not know as not-found and caches that verdict', async () => {
    const h = installHarness({ seed: seedPayload(['AAPL']) });

    const resp = await listMarketQuotes(CTX, { symbols: ['AAPL', 'NOSUCH'] });

    assert.deepEqual(symbolsOf(resp), ['AAPL']);
    assert.equal(reasonFor(resp, 'NOSUCH'), 'MARKET_QUOTE_UNAVAILABLE_REASON_NOT_FOUND');
    assert.ok(h.redisSets.some((s) => s.key === 'market:custom-quote:v1:NOSUCH'));
  });

  it('reports missing credentials instead of quietly returning a short list', async () => {
    const h = installHarness({ seed: seedPayload(['AAPL']), finnhubKey: null });

    const resp = await listMarketQuotes(CTX, { symbols: ['AAPL', 'ARM'] });

    assert.deepEqual(symbolsOf(resp), ['AAPL']);
    assert.equal(reasonFor(resp, 'ARM'), 'MARKET_QUOTE_UNAVAILABLE_REASON_PROVIDER_NOT_CONFIGURED');
    assert.equal(resp.finnhubSkipped, true);
    assert.equal(resp.skipReason, 'FINNHUB_API_KEY and ALPHA_VANTAGE_API_KEY not configured');
    assert.deepEqual(h.finnhubCalls, []);
  });

  it('does not spend the lookup budget on symbols the provider cannot serve', async () => {
    const h = installHarness({ seed: seedPayload(['AAPL']) });

    // ^GSPC is a seeded index the relay routes through Yahoo; GC=F is Yahoo
    // futures notation. Both only reach here when the seeder dropped them.
    const resp = await listMarketQuotes(CTX, { symbols: ['AAPL', '^GSPC', 'GC=F'] });

    assert.deepEqual(symbolsOf(resp), ['AAPL']);
    assert.equal(reasonFor(resp, '^GSPC'), 'MARKET_QUOTE_UNAVAILABLE_REASON_NOT_FOUND');
    assert.equal(reasonFor(resp, 'GC=F'), 'MARKET_QUOTE_UNAVAILABLE_REASON_NOT_FOUND');
    assert.deepEqual(h.finnhubCalls, []);
  });

  it('bounds provider lookups per request and reports the remainder', async () => {
    const misses = Array.from({ length: MARKET_QUOTES_UPSTREAM_LIMIT + 4 }, (_, i) => `MISS${i}`);
    const h = installHarness({
      seed: seedPayload(['AAPL']),
      provider: Object.fromEntries(misses.map((s, i) => [s, okQuote(10 + i, 0)])),
    });

    const resp = await listMarketQuotes(CTX, { symbols: ['AAPL', ...misses] });

    assert.equal(h.finnhubCalls.length, MARKET_QUOTES_UPSTREAM_LIMIT);
    assert.equal(resp.quotes.length, 1 + MARKET_QUOTES_UPSTREAM_LIMIT);
    for (const symbol of misses.slice(MARKET_QUOTES_UPSTREAM_LIMIT)) {
      assert.equal(
        reasonFor(resp, symbol),
        'MARKET_QUOTE_UNAVAILABLE_REASON_UPSTREAM_BUDGET_EXHAUSTED',
        `${symbol} must be reported, not omitted`,
      );
    }
  });

  it('enforces one wall-clock deadline across an in-window stalled lookup', async () => {
    __setUpstreamDeadlineForTests(30);
    installHarness({
      seed: seedPayload(['AAPL']),
      provider: { STALL: { status: 200, waitForAbort: true } },
    });

    const startedAt = Date.now();
    const resp = await listMarketQuotes(CTX, { symbols: ['AAPL', 'STALL'] });

    assert.ok(Date.now() - startedAt < 500, 'the response must not wait for the 3s provider timeout');
    assert.equal(
      reasonFor(resp, 'STALL'),
      'MARKET_QUOTE_UNAVAILABLE_REASON_UPSTREAM_BUDGET_EXHAUSTED',
    );
  });

  it('reports symbols dropped by the request cardinality bound', async () => {
    const overflow = Array.from({ length: MARKET_QUOTES_REQUEST_LIMIT + 2 }, (_, i) => `BULK${i}`);
    const h = installHarness({ seed: seedPayload(overflow.slice(0, MARKET_QUOTES_REQUEST_LIMIT)) });

    const resp = await listMarketQuotes(CTX, { symbols: overflow });

    assert.equal(resp.quotes.length, MARKET_QUOTES_REQUEST_LIMIT);
    assert.equal(
      reasonFor(resp, `BULK${MARKET_QUOTES_REQUEST_LIMIT}`),
      'MARKET_QUOTE_UNAVAILABLE_REASON_REQUEST_LIMIT_EXCEEDED',
    );
    assert.deepEqual(h.finnhubCalls, []);
  });

  it('never fans out to the provider when the seed read fails', async () => {
    const h = installHarness({ seedFails: true, provider: { RIVN: okQuote(12, 1) } });

    const resp = await listMarketQuotes(CTX, { symbols: ['AAPL', 'RIVN'] });

    assert.deepEqual(resp.quotes, []);
    assert.deepEqual(
      resp.unavailableSymbols.map((u) => u.reason),
      ['MARKET_QUOTE_UNAVAILABLE_REASON_SEED_UNAVAILABLE', 'MARKET_QUOTE_UNAVAILABLE_REASON_SEED_UNAVAILABLE'],
    );
    assert.deepEqual(h.finnhubCalls, [], 'a degraded seed must not amplify into one upstream call per symbol');
  });

  it('degrades to seed-unavailable on a corrupt snapshot instead of throwing', async () => {
    // The pre-#6305 handler wrapped everything in a try/catch, so a malformed
    // payload produced an empty response. Keep that fail-soft edge.
    const h = installHarness({ provider: { RIVN: okQuote(12, 1) } });
    h.redis.set(BOOTSTRAP_KEY, { quotes: 'not-an-array', finnhubSkipped: false });

    const resp = await listMarketQuotes(CTX, { symbols: ['AAPL', 'RIVN'] });

    assert.deepEqual(resp.quotes, []);
    assert.equal(reasonFor(resp, 'AAPL'), 'MARKET_QUOTE_UNAVAILABLE_REASON_SEED_UNAVAILABLE');
    assert.deepEqual(h.finnhubCalls, []);
  });

  it('never fans out to the provider when the seed snapshot is absent', async () => {
    const h = installHarness({ seed: null, provider: { RIVN: okQuote(12, 1) } });

    const resp = await listMarketQuotes(CTX, { symbols: ['AAPL', 'RIVN'] });

    assert.deepEqual(resp.quotes, []);
    assert.equal(reasonFor(resp, 'RIVN'), 'MARKET_QUOTE_UNAVAILABLE_REASON_SEED_UNAVAILABLE');
    assert.deepEqual(h.finnhubCalls, []);
  });
});
