import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { backtestStock } from '../server/worldmonitor/market/v1/backtest-stock.ts';
import { listStoredStockBacktests } from '../server/worldmonitor/market/v1/list-stored-stock-backtests.ts';
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

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRedisUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
  if (originalRedisToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
});

function createRedisAwareBacktestFetch(mockChartPayload: unknown) {
  const redis = new Map<string, string>();
  const sortedSets = new Map<string, Array<{ member: string; score: number }>>();

  const upsertSortedSet = (key: string, score: number, member: string) => {
    const next = (sortedSets.get(key) ?? []).filter((item) => item.member !== member);
    next.push({ member, score });
    next.sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
    sortedSets.set(key, next);
  };

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes('query1.finance.yahoo.com')) {
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
    assert.match(response.evaluations[0]?.analysisId || '', /^ledger:/);
    assert.match(response.latestSignal, /buy/i);
    assert.match(response.summary, /stored analysis/i);
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
    globalThis.fetch = createRedisAwareBacktestFetch(mockChartPayload);

    const response = await backtestStock({} as never, {
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
    assert.match(requestedUrl, /symbols=MSFT%2CNVDA|symbols=MSFT,NVDA/);
    assert.match(requestedUrl, /eval_window_days=7/);
  });
});
