/**
 * #6475 — the gap fetch reconstructed WHY a lookup failed from clocks and a
 * request-local side map, instead of carrying the cause on the failure itself.
 *
 * Two reachable mis-attributions, both billing the provider for something the
 * provider never did:
 *
 *  1. Our own deadline cutoff armed `armLocalUnavailableBackoff` (any fetcher
 *     rejection did). The NEXT request, same isolate, same symbol, within 3 s
 *     hit the backoff throw before any provider call — and its catch saw a
 *     fresh deadline and an empty side map, so it reported PROVIDER_ERROR for
 *     a provider that was never contacted.
 *  2. A caller that joined an in-flight lookup inherited the leader's
 *     rejection with its OWN side map empty: a real 429 seen by the leader
 *     reported PROVIDER_ERROR to the joiner, with `rateLimited: false`.
 *
 * Provenance is now typed and carried on the failure: the provider adapters
 * report a caller cancellation as `status: 'cancelled'` (never an error), the
 * fetcher throws typed errors carrying the recorded reason, and the cache
 * layer refuses to arm the unavailable backoff for a cancellation — an
 * upstream that was never allowed to answer has not been shown unavailable.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type {
  ListMarketQuotesResponse,
  ServerContext,
} from '@/generated/server/worldmonitor/market/v1/service_server';
import {
  __clearLocalUnavailableBackoffForTests,
  __resetKeyPrefixCacheForTests,
} from '../server/_shared/redis';
import {
  __resetUpstreamDeadlineForTests,
  __setUpstreamDeadlineForTests,
  listMarketQuotes,
} from '../server/worldmonitor/market/v1/list-market-quotes';
import {
  CascadeQuoteProvider,
  FinnhubQuoteProvider,
  AlphaVantageQuoteProvider,
} from '../server/worldmonitor/market/v1/_quote-provider';

const BOOTSTRAP_KEY = 'market:stocks-bootstrap:v1';
const CTX = {} as ServerContext;

const ORIGINAL_ENV = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  VERCEL_ENV: process.env.VERCEL_ENV,
  LOCAL_API_MODE: process.env.LOCAL_API_MODE,
  FINNHUB_API_KEY: process.env.FINNHUB_API_KEY,
  ALPHA_VANTAGE_API_KEY: process.env.ALPHA_VANTAGE_API_KEY,
};
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_WARN = console.warn;
const ORIGINAL_INFO = console.info;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  console.warn = ORIGINAL_WARN;
  console.info = ORIGINAL_INFO;
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  __resetKeyPrefixCacheForTests();
  __clearLocalUnavailableBackoffForTests();
  __resetUpstreamDeadlineForTests();
});

type ProviderReply = { status: number; body?: unknown; waitForAbort?: boolean; delayMs?: number };

interface Harness {
  finnhubCalls: string[];
}

/** Minimal copy of the seed-first harness: fake Upstash + fake Finnhub. */
function installHarness(init: { provider?: Record<string, ProviderReply> } = {}): Harness {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  process.env.VERCEL_ENV = 'production';
  delete process.env.LOCAL_API_MODE;
  process.env.FINNHUB_API_KEY = 'test-finnhub-key';
  delete process.env.ALPHA_VANTAGE_API_KEY;
  __resetKeyPrefixCacheForTests();

  const provider = new Map(Object.entries(init.provider ?? {}));
  const redis = new Map<string, unknown>();
  // Seed-first contract: the gap fetch only runs for symbols the seeded
  // bootstrap does not carry, so seed an unrelated symbol.
  redis.set(BOOTSTRAP_KEY, {
    quotes: [{ symbol: 'SPY', name: 'SPY', display: 'SPY', price: 100, change: 1, sparkline: [] }],
    finnhubSkipped: false,
    skipReason: '',
    rateLimited: false,
    unavailableSymbols: [],
  });
  const harness: Harness = { finnhubCalls: [] };

  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

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
      harness.finnhubCalls.push(symbol);
      const reply = provider.get(symbol);
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
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      return json(reply.body ?? {}, reply.status);
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;

  console.warn = () => {};
  console.info = () => {};
  return harness;
}

const reasonFor = (resp: ListMarketQuotesResponse, symbol: string) =>
  resp.unavailableSymbols.find((u) => u.symbol === symbol)?.reason;

describe('gap-fetch failure provenance (#6475)', () => {
  it('a second call after our own cutoff still reports UPSTREAM_BUDGET_EXHAUSTED, not PROVIDER_ERROR, and actually reaches the provider', async () => {
    const harness = installHarness({ provider: { AAPL: { waitForAbort: true } } });
    __setUpstreamDeadlineForTests(60);

    const first = await listMarketQuotes(CTX, { symbols: ['AAPL'] });
    assert.equal(
      reasonFor(first, 'AAPL'),
      'MARKET_QUOTE_UNAVAILABLE_REASON_UPSTREAM_BUDGET_EXHAUSTED',
      'the first call is cut by our own deadline',
    );
    assert.equal(harness.finnhubCalls.length, 1);

    // Same warm isolate, same symbol, within the 3 s backoff the cutoff used
    // to arm: pre-fix, the backoff throw was classified PROVIDER_ERROR for a
    // provider that was never contacted, and the provider was NOT retried.
    const second = await listMarketQuotes(CTX, { symbols: ['AAPL'] });
    assert.equal(
      harness.finnhubCalls.length, 2,
      'our own cancellation must not arm the unavailable backoff — the retry must reach the provider',
    );
    assert.equal(
      reasonFor(second, 'AAPL'),
      'MARKET_QUOTE_UNAVAILABLE_REASON_UPSTREAM_BUDGET_EXHAUSTED',
      'a lookup our deadline cut is never the provider\'s failure',
    );
  });

  it('a joiner of an in-flight 429 lookup preserves the rate-limit cause and raises rateLimited', async () => {
    installHarness({ provider: { NVDA: { status: 429, delayMs: 40 } } });

    const [a, b] = await Promise.all([
      listMarketQuotes(CTX, { symbols: ['NVDA'] }),
      listMarketQuotes(CTX, { symbols: ['NVDA'] }),
    ]);

    for (const resp of [a, b]) {
      assert.equal(
        reasonFor(resp, 'NVDA'),
        'MARKET_QUOTE_UNAVAILABLE_REASON_PROVIDER_RATE_LIMITED',
        'the 429 is real for BOTH callers — the joiner must not downgrade it to PROVIDER_ERROR',
      );
      assert.equal(resp.rateLimited, true, 'the response-level flag must rise for both callers');
    }
  });

  it('a genuine provider failure still arms the backoff and reports PROVIDER_ERROR', async () => {
    const harness = installHarness({ provider: { MSFT: { status: 500 } } });

    const first = await listMarketQuotes(CTX, { symbols: ['MSFT'] });
    assert.equal(reasonFor(first, 'MSFT'), 'MARKET_QUOTE_UNAVAILABLE_REASON_PROVIDER_ERROR');

    // The provider ANSWERED with a failure — the 3 s backoff is earned, and
    // the immediate retry must be absorbed by it, still as the provider's.
    const second = await listMarketQuotes(CTX, { symbols: ['MSFT'] });
    assert.equal(harness.finnhubCalls.length, 1, 'a real provider failure keeps the backoff');
    assert.equal(reasonFor(second, 'MSFT'), 'MARKET_QUOTE_UNAVAILABLE_REASON_PROVIDER_ERROR');
  });

  it('a second call after a real 429 preserves PROVIDER_RATE_LIMITED and rateLimited', async () => {
    const harness = installHarness({ provider: { TSLA: { status: 429 } } });

    const first = await listMarketQuotes(CTX, { symbols: ['TSLA'] });
    assert.equal(reasonFor(first, 'TSLA'), 'MARKET_QUOTE_UNAVAILABLE_REASON_PROVIDER_RATE_LIMITED');
    assert.equal(first.rateLimited, true);
    assert.equal(harness.finnhubCalls.length, 1);

    const second = await listMarketQuotes(CTX, { symbols: ['TSLA'] });
    assert.equal(harness.finnhubCalls.length, 1, '429 backoff must absorb the immediate retry');
    assert.equal(
      reasonFor(second, 'TSLA'),
      'MARKET_QUOTE_UNAVAILABLE_REASON_PROVIDER_RATE_LIMITED',
      'backoff short-circuit must carry the rate-limit verdict, not PROVIDER_ERROR',
    );
    assert.equal(second.rateLimited, true);
  });
});

describe('provider adapters report caller cancellation as its own outcome (#6475)', () => {
  it('Finnhub maps an aborted fetch to cancelled, never to error', async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, opts?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(opts.signal?.reason), { once: true });
      })) as typeof fetch;

    const controller = new AbortController();
    const provider = new FinnhubQuoteProvider('key');
    const pending = provider.fetchQuote('AAPL', controller.signal);
    controller.abort(new DOMException('caller gone', 'AbortError'));

    assert.deepEqual(await pending, { status: 'cancelled' });
  });

  it('the cascade stops on cancellation instead of consulting the next provider', async () => {
    const controller = new AbortController();
    let secondAsked = 0;
    const first = {
      name: 'first',
      canQuote: () => true,
      fetchQuote: async () => {
        controller.abort(new DOMException('caller gone', 'AbortError'));
        return { status: 'cancelled' } as const;
      },
    };
    const second = {
      name: 'second',
      canQuote: () => true,
      fetchQuote: async () => {
        secondAsked += 1;
        return { status: 'not_found' } as const;
      },
    };

    const cascade = new CascadeQuoteProvider([first, second]);
    const outcome = await cascade.fetchQuote('AAPL', controller.signal);

    assert.deepEqual(outcome, { status: 'cancelled' });
    assert.equal(secondAsked, 0, 'a cancelled caller must not spend the next provider\'s budget');
  });

  it('an already-aborted signal short-circuits the cascade as cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const cascade = new CascadeQuoteProvider([new FinnhubQuoteProvider('key')]);
    assert.deepEqual(await cascade.fetchQuote('AAPL', controller.signal), { status: 'cancelled' });
  });

  it('preserves rate_limited when the caller aborts after an upstream 429', async () => {
    const controller = new AbortController();
    const finnhub = {
      name: 'finnhub',
      canQuote: () => true,
      fetchQuote: async () => {
        controller.abort(new DOMException('deadline', 'AbortError'));
        return { status: 'rate_limited' } as const;
      },
    };
    const second = {
      name: 'second',
      canQuote: () => true,
      fetchQuote: async () => ({ status: 'not_found' } as const),
    };

    const cascade = new CascadeQuoteProvider([finnhub, second]);
    assert.deepEqual(await cascade.fetchQuote('NVDA', controller.signal), { status: 'rate_limited' });
  });

  it('Alpha Vantage maps an aborted fetch to cancelled, never to error', async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, opts?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(opts.signal?.reason), { once: true });
      })) as typeof fetch;

    const controller = new AbortController();
    const provider = new AlphaVantageQuoteProvider('key');
    const pending = provider.fetchQuote('AAPL', controller.signal);
    controller.abort(new DOMException('caller gone', 'AbortError'));

    assert.deepEqual(await pending, { status: 'cancelled' });
  });
});
