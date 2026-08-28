import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  BACKTEST_STOCK_DAILY_PROVIDER_QUOTA_LIMIT,
  BACKTEST_STOCK_PROVIDER_QUOTA_EXCEEDED_MESSAGE,
  BACKTEST_STOCK_PROVIDER_QUOTA_UNAVAILABLE_MESSAGE,
  backtestStockProviderQuotaKey,
} from '../server/_shared/backtest-stock-quota.ts';
import { TRUSTED_USER_ID_HEADER } from '../server/_shared/mcp-internal-hmac.ts';
import { mapErrorToResponse } from '../server/error-mapper.ts';
import {
  backtestStock,
  stockBacktestCacheKey,
  STOCK_BACKTEST_ENGINE_VERSION,
  STOCK_BACKTEST_RATING_BASIS,
} from '../server/worldmonitor/market/v1/backtest-stock.ts';
import { listStoredStockBacktests } from '../server/worldmonitor/market/v1/list-stored-stock-backtests.ts';
import { ApiError } from '../src/generated/server/worldmonitor/market/v1/service_server.ts';
import { MarketServiceClient } from '../src/generated/client/worldmonitor/market/v1/service_client.ts';

const originalFetch = globalThis.fetch;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

function buildReplaySeries(length = 120) {
  const candles: Array<{
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }> = [];
  let price = 100;

  for (let index = 0; index < length; index++) {
    const drift = 0.28;
    const pullback = index % 14 >= 10 && index % 14 <= 12 ? -0.35 : 0;
    const noise = index % 9 === 0 ? 0.12 : index % 11 === 0 ? -0.08 : 0.04;
    const change = drift + pullback + noise;
    const open = price;
    price = Math.max(20, price + change);
    const close = price;
    const high = Math.max(open, close) + 0.7;
    const low = Math.min(open, close) - 0.6;
    const volume = index % 14 >= 10 && index % 14 <= 12 ? 780_000 : 1_120_000;
    candles.push({
      timestamp: 1_700_000_000 + (index * 86_400),
      open,
      high,
      low,
      close,
      volume,
    });
  }

  return candles;
}

beforeEach(() => {
  // The snapshot environment may already export Upstash credentials. Isolate
  // every case so cache/quota Redis traffic only happens when a test opts in.
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRedisUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
  if (originalRedisToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
});

function makeBacktestCtx(userId?: string) {
  const headers = userId ? { [TRUSTED_USER_ID_HEADER]: userId } : undefined;
  return {
    request: new Request('https://worldmonitor.app/api/market/v1/backtest-stock', { headers }),
    pathParams: {},
    headers: headers ?? {},
  };
}

function createRedisAwareBacktestFetch(mockChartPayload: unknown) {
  const redis = new Map<string, string>();
  const sortedSets = new Map<string, Array<{ member: string; score: number }>>();
  let yahooCalls = 0;
  const llmQuotaKeys = new Set<string>();

  const upsertSortedSet = (key: string, score: number, member: string) => {
    const next = (sortedSets.get(key) ?? []).filter((item) => item.member !== member);
    next.push({ member, score });
    next.sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
    sortedSets.set(key, next);
  };

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes('query1.finance.yahoo.com')) {
      yahooCalls += 1;
      return new Response(JSON.stringify(mockChartPayload), { status: 200 });
    }

    if (url.startsWith(process.env.UPSTASH_REDIS_REST_URL || '')) {
      const parsed = new URL(url);
      if (parsed.pathname.startsWith('/get/')) {
        const key = decodeURIComponent(parsed.pathname.slice('/get/'.length));
        return new Response(JSON.stringify({ result: redis.get(key) ?? null }), { status: 200 });
      }
      if (parsed.pathname.startsWith('/set/')) {
        const parts = parsed.pathname.split('/');
        const key = decodeURIComponent(parts[2] || '');
        const value = decodeURIComponent(parts[3] || '');
        redis.set(key, value);
        return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
      }
      if (parsed.pathname === '/') {
        const command = JSON.parse(typeof init?.body === 'string' ? init.body : '[]') as string[];
        const [verb, key = '', value = ''] = command;
        if (verb === 'SET') {
          redis.set(key, value);
          return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
        }
        throw new Error(`Unexpected POST / command: ${verb}`);
      }
      if (parsed.pathname === '/pipeline') {
        const commands = JSON.parse(typeof init?.body === 'string' ? init.body : '[]') as string[][];
        const result = commands.map((command) => {
          const [verb, key = '', ...args] = command;
          if (verb === 'GET') {
            return { result: redis.get(key) ?? null };
          }
          if (verb === 'SET') {
            redis.set(key, args[0] || '');
            return { result: 'OK' };
          }
          if (verb === 'ZADD') {
            for (let index = 0; index < args.length; index += 2) {
              upsertSortedSet(key, Number(args[index] || 0), args[index + 1] || '');
            }
            return { result: 1 };
          }
          if (verb === 'ZREVRANGE') {
            const items = [...(sortedSets.get(key) ?? [])].sort((a, b) => b.score - a.score || a.member.localeCompare(b.member));
            const start = Number(args[0] || 0);
            const stop = Number(args[1] || 0);
            return { result: items.slice(start, stop + 1).map((item) => item.member) };
          }
          if (verb === 'ZREM') {
            const removals = new Set(args);
            sortedSets.set(key, (sortedSets.get(key) ?? []).filter((item) => !removals.has(item.member)));
            return { result: removals.size };
          }
          if (verb === 'INCR') {
            if (key.startsWith('llm:')) llmQuotaKeys.add(key);
            const next = Number(redis.get(key) || '0') + 1;
            redis.set(key, String(next));
            return { result: next };
          }
          if (verb === 'DECR') {
            const next = Number(redis.get(key) || '0') - 1;
            redis.set(key, String(next));
            return { result: next };
          }
          if (verb === 'EXPIRE') {
            return { result: 1 };
          }
          throw new Error(`Unexpected pipeline command: ${verb}`);
        });
        return new Response(JSON.stringify(result), { status: 200 });
      }
    }

    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    redis,
    yahooCallCount: () => yahooCalls,
    llmQuotaKeyCount: () => llmQuotaKeys.size,
  };
}

describe('backtestStock handler', () => {
  it('replays actionable stock-analysis signals over recent Yahoo history', async () => {
    const candles = buildReplaySeries();
    const mockChartPayload = {
      chart: {
        result: [
          {
            meta: {
              currency: 'USD',
              regularMarketPrice: 148,
              previousClose: 147,
            },
            timestamp: candles.map((candle) => candle.timestamp),
            indicators: {
              quote: [
                {
                  open: candles.map((candle) => candle.open),
                  high: candles.map((candle) => candle.high),
                  low: candles.map((candle) => candle.low),
                  close: candles.map((candle) => candle.close),
                  volume: candles.map((candle) => candle.volume),
                },
              ],
            },
          },
        ],
      },
    };

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('query1.finance.yahoo.com')) {
        return new Response(JSON.stringify(mockChartPayload), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const response = await backtestStock({} as never, {
      symbol: 'AAPL',
      name: 'Apple',
      evalWindowDays: 10,
    });

    assert.equal(response.available, true);
    assert.equal(response.symbol, 'AAPL');
    assert.equal(response.currency, 'USD');
    assert.ok(response.actionableEvaluations > 0);
    assert.ok(response.evaluations.length > 0);
    assert.match(response.evaluations[0]?.analysisId || '', /^ledger:v3-technical-only:/);
    assert.match(response.latestSignal, /buy/i);
    assert.match(response.summary, /technical-only signal/i);
    assert.match(response.summary, /fundamentals are not included/i);
    assert.equal(response.ratingBasis, STOCK_BACKTEST_RATING_BASIS);
    assert.equal(response.engineVersion, STOCK_BACKTEST_ENGINE_VERSION);
  });
});

describe('server-backed stored stock backtests', () => {
  it('stores fresh backtests in Redis and serves them back in batch', async () => {
    const candles = buildReplaySeries();
    const mockChartPayload = {
      chart: {
        result: [
          {
            meta: {
              currency: 'USD',
              regularMarketPrice: 148,
              previousClose: 147,
            },
            timestamp: candles.map((candle) => candle.timestamp),
            indicators: {
              quote: [
                {
                  open: candles.map((candle) => candle.open),
                  high: candles.map((candle) => candle.high),
                  low: candles.map((candle) => candle.low),
                  close: candles.map((candle) => candle.close),
                  volume: candles.map((candle) => candle.volume),
                },
              ],
            },
          },
        ],
      },
    };

    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    const redisFetch = createRedisAwareBacktestFetch(mockChartPayload);
    globalThis.fetch = redisFetch.fetch;

    const response = await backtestStock(makeBacktestCtx('user_pro'), {
      symbol: 'AAPL',
      name: 'Apple',
      evalWindowDays: 10,
    });

    assert.equal(response.available, true);

    const stored = await listStoredStockBacktests({} as never, {
      symbols: 'AAPL,MSFT' as never,
      evalWindowDays: 10,
    });

    assert.equal(stored.items.length, 1);
    assert.equal(stored.items[0]?.symbol, 'AAPL');
    assert.equal(stored.items[0]?.latestSignal, response.latestSignal);
    assert.equal(stored.items[0]?.ratingBasis, 'technical_only');
    assert.equal(stored.items[0]?.engineVersion, 'v3-technical-only');
    assert.equal(redisFetch.llmQuotaKeyCount(), 0);
    assert.equal(
      redisFetch.redis.get(backtestStockProviderQuotaKey('user_pro')),
      '1',
    );
  });
});

describe('backtestStock provider-work quota', () => {
  function mockChartPayload() {
    const candles = buildReplaySeries();
    return {
      chart: {
        result: [
          {
            meta: {
              currency: 'USD',
              regularMarketPrice: 148,
              previousClose: 147,
            },
            timestamp: candles.map((candle) => candle.timestamp),
            indicators: {
              quote: [
                {
                  open: candles.map((candle) => candle.open),
                  high: candles.map((candle) => candle.high),
                  low: candles.map((candle) => candle.low),
                  close: candles.map((candle) => candle.close),
                  volume: candles.map((candle) => candle.volume),
                },
              ],
            },
          },
        ],
      },
    };
  }

  it('does not consume the provider-work budget for an empty symbol', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    const redisFetch = createRedisAwareBacktestFetch(mockChartPayload());
    globalThis.fetch = redisFetch.fetch;

    const response = await backtestStock(makeBacktestCtx('user_pro'), {
      symbol: '   ',
      name: 'Apple',
      evalWindowDays: 10,
    });

    assert.equal(response.available, false);
    assert.equal(response.summary, 'No symbol provided.');
    assert.equal(redisFetch.yahooCallCount(), 0);
    assert.equal(redisFetch.redis.get(backtestStockProviderQuotaKey('user_pro')), undefined);
  });

  it('does not consume the provider-work budget on a cache hit', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    const redisFetch = createRedisAwareBacktestFetch(mockChartPayload());
    globalThis.fetch = redisFetch.fetch;
    const cached = {
      available: true,
      symbol: 'AAPL',
      name: 'Apple',
      display: 'AAPL',
      currency: 'USD',
      evalWindowDays: 10,
      evaluationsRun: 1,
      actionableEvaluations: 1,
      winRate: 50,
      directionAccuracy: 50,
      avgSimulatedReturnPct: 1,
      cumulativeSimulatedReturnPct: 1,
      latestSignal: 'buy',
      latestSignalScore: 1,
      summary: 'cached',
      generatedAt: '2026-08-20T00:00:00.000Z',
      evaluations: [],
      engineVersion: STOCK_BACKTEST_ENGINE_VERSION,
      ratingBasis: STOCK_BACKTEST_RATING_BASIS,
    };
    redisFetch.redis.set(stockBacktestCacheKey('AAPL', 10), JSON.stringify(cached));

    const response = await backtestStock(makeBacktestCtx('user_pro'), {
      symbol: 'AAPL',
      name: 'Apple',
      evalWindowDays: 10,
    });

    assert.equal(response.available, true);
    assert.equal(response.summary, 'cached');
    assert.equal(redisFetch.yahooCallCount(), 0);
    assert.equal(redisFetch.redis.get(backtestStockProviderQuotaKey('user_pro')), undefined);
  });

  // `name` is a caller-supplied display label, and the cache key is only
  // symbol + window — deliberately, so two callers watching the same ticker
  // share one Yahoo fetch. That sharing must not extend to the label: whoever
  // populated the entry first would otherwise have their spelling echoed back
  // at every later caller. Custom watchlist entries make differing labels for
  // one symbol reachable in production (src/services/stock-backtest.ts:24-27
  // sends each target's own name).
  it('echoes the requesting caller name on an entry cached by another caller', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    const redisFetch = createRedisAwareBacktestFetch(mockChartPayload());
    globalThis.fetch = redisFetch.fetch;
    const cachedByFirstCaller = {
      available: true,
      symbol: 'AAPL',
      name: 'Apple Inc.',
      display: 'AAPL',
      currency: 'USD',
      evalWindowDays: 10,
      evaluationsRun: 1,
      actionableEvaluations: 1,
      winRate: 50,
      directionAccuracy: 50,
      avgSimulatedReturnPct: 1,
      cumulativeSimulatedReturnPct: 1,
      latestSignal: 'buy',
      latestSignalScore: 1,
      summary: 'cached',
      generatedAt: '2026-08-20T00:00:00.000Z',
      evaluations: [],
      engineVersion: STOCK_BACKTEST_ENGINE_VERSION,
      ratingBasis: STOCK_BACKTEST_RATING_BASIS,
    };
    redisFetch.redis.set(stockBacktestCacheKey('AAPL', 10), JSON.stringify(cachedByFirstCaller));

    const response = await backtestStock(makeBacktestCtx('user_pro'), {
      symbol: 'AAPL',
      name: 'Apple Computer',
      evalWindowDays: 10,
    });

    // Served from the shared entry — no second Yahoo fetch...
    assert.equal(response.summary, 'cached');
    assert.equal(redisFetch.yahooCallCount(), 0);
    // ...but labelled with THIS caller's name.
    assert.equal(response.name, 'Apple Computer');
    // The shared entry itself stays canonical; the re-stamp is per-response.
    assert.equal(
      JSON.parse(redisFetch.redis.get(stockBacktestCacheKey('AAPL', 10)) || '{}').name,
      'Apple Inc.',
    );
  });

  it('falls back to the symbol when a cache-hit caller sends no name', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    const redisFetch = createRedisAwareBacktestFetch(mockChartPayload());
    globalThis.fetch = redisFetch.fetch;
    redisFetch.redis.set(stockBacktestCacheKey('AAPL', 10), JSON.stringify({
      available: true,
      symbol: 'AAPL',
      name: 'Apple Inc.',
      display: 'AAPL',
      currency: 'USD',
      evalWindowDays: 10,
      evaluationsRun: 1,
      actionableEvaluations: 1,
      winRate: 50,
      directionAccuracy: 50,
      avgSimulatedReturnPct: 1,
      cumulativeSimulatedReturnPct: 1,
      latestSignal: 'buy',
      latestSignalScore: 1,
      summary: 'cached',
      generatedAt: '2026-08-20T00:00:00.000Z',
      evaluations: [],
      engineVersion: STOCK_BACKTEST_ENGINE_VERSION,
      ratingBasis: STOCK_BACKTEST_RATING_BASIS,
    }));

    const response = await backtestStock(makeBacktestCtx('user_pro'), {
      symbol: 'AAPL',
      evalWindowDays: 10,
    } as never);

    // Same rule the fresh-compute and unavailable paths already apply
    // (`req.name || symbol`), so a caller's echo does not depend on whether
    // someone else happened to warm the cache first.
    assert.equal(response.name, 'AAPL');
  });

  it('returns a deterministic 429 with reset guidance when the daily budget is exceeded', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    const redisFetch = createRedisAwareBacktestFetch(mockChartPayload());
    globalThis.fetch = redisFetch.fetch;
    redisFetch.redis.set(
      backtestStockProviderQuotaKey('user_pro'),
      String(BACKTEST_STOCK_DAILY_PROVIDER_QUOTA_LIMIT),
    );

    let quotaError: ApiError | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(
        () => backtestStock(makeBacktestCtx('user_pro'), {
          symbol: 'AAPL',
          name: 'Apple',
          evalWindowDays: 10,
        }),
        (error: unknown) => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.statusCode, 429);
          assert.equal(error.message, BACKTEST_STOCK_PROVIDER_QUOTA_EXCEEDED_MESSAGE);
          assert.equal((error as ApiError & { retryAfter: number }).retryAfter > 0, true);
          quotaError = error;
          return true;
        },
      );
    }
    assert.equal(redisFetch.yahooCallCount(), 0);
    assert.equal(
      redisFetch.redis.get(backtestStockProviderQuotaKey('user_pro')),
      String(BACKTEST_STOCK_DAILY_PROVIDER_QUOTA_LIMIT),
    );
    assert.equal(redisFetch.llmQuotaKeyCount(), 0);

    assert.ok(quotaError);
    const response = mapErrorToResponse(quotaError, makeBacktestCtx('user_pro').request);
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), {
      error: BACKTEST_STOCK_PROVIDER_QUOTA_EXCEEDED_MESSAGE,
    });
    assert.equal(response.headers.get('RateLimit-Policy'), '"default";q=200;w=86400');
    assert.equal(response.headers.get('RateLimit-Limit'), '200');
    assert.equal(response.headers.get('RateLimit-Remaining'), '0');
    assert.equal(Number(response.headers.get('RateLimit-Reset')) > 0, true);
    assert.equal(response.headers.get('X-RateLimit-Limit'), '200');
    assert.equal(response.headers.get('X-RateLimit-Remaining'), '0');
    assert.equal(Number(response.headers.get('X-RateLimit-Reset')) > Date.now(), true);
    assert.equal(Number(response.headers.get('Retry-After')) > 0, true);
  });

  it('fails closed with 503 when the quota store cannot prove a reservation', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    let yahooCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('query1.finance.yahoo.com')) {
        yahooCalls += 1;
        return new Response(JSON.stringify(mockChartPayload()), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    let quotaError: ApiError | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(
        () => backtestStock(makeBacktestCtx('user_pro'), {
          symbol: 'IBM',
          name: 'IBM',
          evalWindowDays: 10,
        }),
        (error: unknown) => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.statusCode, 503);
          assert.equal(error.message, BACKTEST_STOCK_PROVIDER_QUOTA_UNAVAILABLE_MESSAGE);
          quotaError = error;
          return true;
        },
      );
    }
    assert.equal(yahooCalls, 0);

    assert.ok(quotaError);
    const response = mapErrorToResponse(quotaError, makeBacktestCtx('user_pro').request);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: BACKTEST_STOCK_PROVIDER_QUOTA_UNAVAILABLE_MESSAGE,
    });
    assert.equal(response.headers.get('Retry-After'), '30');
    assert.equal(response.headers.get('RateLimit-Limit'), null);
  });

  it('retries admission after each caller-local in-flight leader failure', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    const redisFetch = createRedisAwareBacktestFetch(mockChartPayload());
    const firstCappedUserId = 'user_capped_first';
    const secondCappedUserId = 'user_capped_second';
    const eligibleUserId = 'user_eligible';
    const firstCappedQuotaKey = backtestStockProviderQuotaKey(firstCappedUserId);
    const secondCappedQuotaKey = backtestStockProviderQuotaKey(secondCappedUserId);
    const cacheKey = stockBacktestCacheKey('TSLA', 10);
    redisFetch.redis.set(firstCappedQuotaKey, String(BACKTEST_STOCK_DAILY_PROVIDER_QUOTA_LIMIT));
    redisFetch.redis.set(secondCappedQuotaKey, String(BACKTEST_STOCK_DAILY_PROVIDER_QUOTA_LIMIT));

    let releaseCappedReservation = () => {};
    const cappedReservationGate = new Promise<void>((resolve) => {
      releaseCappedReservation = resolve;
    });
    let signalCappedReservationStarted = () => {};
    const cappedReservationStarted = new Promise<void>((resolve) => {
      signalCappedReservationStarted = resolve;
    });
    let signalSecondCappedReservationStarted = () => {};
    const secondCappedReservationStarted = new Promise<void>((resolve) => {
      signalSecondCappedReservationStarted = resolve;
    });
    let signalSecondCallerCacheRead = () => {};
    const secondCallerCacheRead = new Promise<void>((resolve) => {
      signalSecondCallerCacheRead = resolve;
    });
    let signalEligibleCacheRead = () => {};
    const eligibleCacheRead = new Promise<void>((resolve) => {
      signalEligibleCacheRead = resolve;
    });
    let cacheReads = 0;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === `https://redis.example/get/${encodeURIComponent(cacheKey)}`) {
        cacheReads += 1;
        if (cacheReads === 2) signalSecondCallerCacheRead();
        if (cacheReads === 3) signalEligibleCacheRead();
      }
      if (url === 'https://redis.example/pipeline') {
        const commands = JSON.parse(typeof init?.body === 'string' ? init.body : '[]') as string[][];
        if (commands.some(([verb, key]) => verb === 'INCR' && key === firstCappedQuotaKey)) {
          signalCappedReservationStarted();
          await cappedReservationGate;
        }
        if (commands.some(([verb, key]) => verb === 'INCR' && key === secondCappedQuotaKey)) {
          signalSecondCappedReservationStarted();
        }
      }
      return redisFetch.fetch(input, init);
    }) as typeof fetch;

    const firstCappedResult = backtestStock(makeBacktestCtx(firstCappedUserId), {
      symbol: 'TSLA',
      name: 'Tesla',
      evalWindowDays: 10,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    await cappedReservationStarted;

    const secondCappedResult = backtestStock(makeBacktestCtx(secondCappedUserId), {
      symbol: 'TSLA',
      name: 'Tesla',
      evalWindowDays: 10,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    await secondCallerCacheRead;
    await new Promise<void>((resolve) => setImmediate(resolve));

    const eligibleResult = backtestStock(makeBacktestCtx(eligibleUserId), {
      symbol: 'TSLA',
      name: 'Tesla',
      evalWindowDays: 10,
    });
    await eligibleCacheRead;
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseCappedReservation();
    await secondCappedReservationStarted;

    const [firstCappedError, secondCappedError, eligibleResponse] = await Promise.all([
      firstCappedResult,
      secondCappedResult,
      eligibleResult,
    ]);
    assert.ok(firstCappedError instanceof ApiError);
    assert.equal(firstCappedError.statusCode, 429);
    assert.ok(secondCappedError instanceof ApiError);
    assert.equal(secondCappedError.statusCode, 429);
    assert.equal(eligibleResponse.available, true);
    assert.equal(redisFetch.yahooCallCount(), 1);
    assert.equal(
      redisFetch.redis.get(firstCappedQuotaKey),
      String(BACKTEST_STOCK_DAILY_PROVIDER_QUOTA_LIMIT),
    );
    assert.equal(
      redisFetch.redis.get(secondCappedQuotaKey),
      String(BACKTEST_STOCK_DAILY_PROVIDER_QUOTA_LIMIT),
    );
    assert.equal(redisFetch.redis.get(backtestStockProviderQuotaKey(eligibleUserId)), '1');
  });

  it('refunds a definitive invalid Yahoo symbol', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    const redisFetch = createRedisAwareBacktestFetch({
      chart: {
        result: null,
        error: {
          code: 'Not Found',
          description: 'No data found, symbol may be delisted',
        },
      },
    });
    globalThis.fetch = redisFetch.fetch;

    const response = await backtestStock(makeBacktestCtx('user_pro'), {
      symbol: 'NOTREALZZZZ',
      name: 'Invalid symbol',
      evalWindowDays: 10,
    });

    assert.equal(response.available, false);
    assert.equal(redisFetch.yahooCallCount(), 1);
    assert.equal(
      Number(redisFetch.redis.get(backtestStockProviderQuotaKey('user_pro')) || '0'),
      0,
    );
  });

  it('does not consume the provider-work budget without a trusted user id', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    const redisFetch = createRedisAwareBacktestFetch(mockChartPayload());
    globalThis.fetch = redisFetch.fetch;

    const response = await backtestStock(makeBacktestCtx(), {
      symbol: 'NVDA',
      name: 'NVIDIA',
      evalWindowDays: 10,
    });

    assert.equal(response.available, true);
    assert.ok(redisFetch.yahooCallCount() > 0);
    assert.equal(
      [...redisFetch.redis.keys()].some((key) => key.startsWith('provider:backtest-yahoo:')),
      false,
    );
  });

  it('rolls back the reservation when Yahoo work throws after a cache miss', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    const redisFetch = createRedisAwareBacktestFetch(mockChartPayload());
    let yahooAttempts = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('query1.finance.yahoo.com')) {
        yahooAttempts += 1;
        throw new Error('yahoo unavailable');
      }
      return redisFetch.fetch(input, init);
    }) as typeof fetch;

    const response = await backtestStock(makeBacktestCtx('user_pro'), {
      symbol: 'AMD',
      name: 'AMD',
      evalWindowDays: 10,
    });

    assert.equal(response.available, false);
    assert.equal(yahooAttempts, 1);
    assert.equal(
      Number(redisFetch.redis.get(backtestStockProviderQuotaKey('user_pro')) || '0'),
      0,
    );
  });
});

describe('technical-only backtest disclosure', () => {
  it('labels the panel and persistent namespaces independently from live composite ratings', () => {
    const panelSource = readFileSync(
      new URL('../src/components/StockBacktestPanel.ts', import.meta.url),
      'utf8',
    );
    const storeSource = readFileSync(
      new URL('../server/worldmonitor/market/v1/premium-stock-store.ts', import.meta.url),
      'utf8',
    );

    assert.match(panelSource, /technical signal model/i);
    assert.match(panelSource, /Point-in-time fundamentals are not included/i);
    assert.match(panelSource, /ratingBasis === 'technical_only'/);
    assert.match(storeSource, /market:stock-backtest-store:v3:/);
    assert.match(storeSource, /market:stock-analysis-ledger:index:v2:/);
    assert.match(storeSource, /market:stock-analysis-ledger:item:v2:/);
  });
});

describe('backtest-stock rate-limit documentation', () => {
  it('describes the per-user daily Yahoo provider-work budget', () => {
    const docs = readFileSync(
      new URL('../docs/usage-rate-limits.mdx', import.meta.url),
      'utf8',
    );
    const zhDocs = readFileSync(
      new URL('../docs/zh/usage-rate-limits.mdx', import.meta.url),
      'utf8',
    );
    assert.match(docs, /GET \/api\/market\/v1\/backtest-stock/);
    assert.match(
      docs,
      new RegExp(`\\*\\*${BACKTEST_STOCK_DAILY_PROVIDER_QUOTA_LIMIT}\\*\\* uncached Yahoo-history fetches`),
    );
    assert.match(docs, /llm:direct-usage/);
    assert.match(zhDocs, /GET \/api\/market\/v1\/backtest-stock/);
    assert.match(
      zhDocs,
      new RegExp(`\\*\\*${BACKTEST_STOCK_DAILY_PROVIDER_QUOTA_LIMIT}\\*\\* 次未缓存 Yahoo 历史抓取`),
    );
  });
});

describe('MarketServiceClient backtestStock', () => {
  it('serializes the backtest-stock query parameters using generated names', async () => {
    let requestedUrl = '';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return new Response(JSON.stringify({ available: false, evaluations: [] }), { status: 200 });
    }) as typeof fetch;

    const client = new MarketServiceClient('');
    await client.backtestStock({ symbol: 'MSFT', name: 'Microsoft', evalWindowDays: 7 });

    assert.match(requestedUrl, /\/api\/market\/v1\/backtest-stock\?/);
    assert.match(requestedUrl, /symbol=MSFT/);
    assert.match(requestedUrl, /name=Microsoft/);
    assert.match(requestedUrl, /eval_window_days=7/);
  });
});

describe('MarketServiceClient listStoredStockBacktests', () => {
  it('serializes the stored backtest batch query parameters using generated names', async () => {
    let requestedUrl = '';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as typeof fetch;

    const client = new MarketServiceClient('');
    await client.listStoredStockBacktests({ symbols: ['MSFT', 'NVDA'], evalWindowDays: 7 });

    assert.match(requestedUrl, /\/api\/market\/v1\/list-stored-stock-backtests\?/);
    assert.match(requestedUrl, /symbols=MSFT&symbols=NVDA/);
    assert.match(requestedUrl, /eval_window_days=7/);
  });
});
