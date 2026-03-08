import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  getLatestStockAnalysisSnapshots,
  mergeStockAnalysisHistory,
  type StockAnalysisSnapshot,
} from '../src/services/stock-analysis-history.ts';
import { analyzeStock } from '../server/worldmonitor/market/v1/analyze-stock.ts';
import { getStockAnalysisHistory } from '../server/worldmonitor/market/v1/get-stock-analysis-history.ts';
import { MarketServiceClient } from '../src/generated/client/worldmonitor/market/v1/service_client.ts';

const originalFetch = globalThis.fetch;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

const mockChartPayload = {
  chart: {
    result: [
      {
        meta: {
          currency: 'USD',
          regularMarketPrice: 132,
          previousClose: 131,
        },
        timestamp: Array.from({ length: 80 }, (_, index) => 1_700_000_000 + (index * 86_400)),
        indicators: {
          quote: [
            {
              open: Array.from({ length: 80 }, (_, index) => 100 + (index * 0.4)),
              high: Array.from({ length: 80 }, (_, index) => 101 + (index * 0.4)),
              low: Array.from({ length: 80 }, (_, index) => 99 + (index * 0.4)),
              close: Array.from({ length: 80 }, (_, index) => 100 + (index * 0.4)),
              volume: Array.from({ length: 80 }, (_, index) => 1_000_000 + (index * 5_000)),
            },
          ],
        },
      },
    ],
  },
};

const mockNewsXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss>
  <channel>
    <item>
      <title>Apple expands AI chip roadmap</title>
      <link>https://example.com/apple-ai</link>
      <pubDate>Sat, 08 Mar 2026 10:00:00 GMT</pubDate>
      <source>Reuters</source>
    </item>
  </channel>
</rss>`;

function createRedisAwareFetch() {
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
    if (url.includes('news.google.com')) {
      return new Response(mockNewsXml, { status: 200 });
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

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRedisUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
  if (originalRedisToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
});

function makeSnapshot(
  symbol: string,
  generatedAt: string,
  signalScore: number,
  signal = 'Buy',
): StockAnalysisSnapshot {
  return {
    available: true,
    symbol,
    name: symbol,
    display: symbol,
    currency: 'USD',
    currentPrice: 100 + signalScore,
    changePercent: 1.2,
    signalScore,
    signal,
    trendStatus: 'Bull',
    volumeStatus: 'Normal',
    macdStatus: 'Bullish',
    rsiStatus: 'Neutral',
    summary: `${symbol} summary`,
    action: 'Wait for confirmation.',
    confidence: 'Medium',
    technicalSummary: 'Constructive setup.',
    newsSummary: 'News stable.',
    whyNow: 'Momentum is improving.',
    bullishFactors: ['Trend remains constructive.'],
    riskFactors: ['Setup needs confirmation.'],
    supportLevels: [95],
    resistanceLevels: [110],
    headlines: [],
    ma5: 101,
    ma10: 100,
    ma20: 98,
    ma60: 92,
    biasMa5: 1,
    biasMa10: 2,
    biasMa20: 4,
    volumeRatio5d: 1.1,
    rsi12: 56,
    macdDif: 1.2,
    macdDea: 0.8,
    macdBar: 0.4,
    provider: 'rules',
    model: '',
    fallback: true,
    newsSearched: false,
    generatedAt,
    analysisId: `${symbol}:${generatedAt}`,
    analysisAt: Date.parse(generatedAt),
    stopLoss: 95,
    takeProfit: 110,
    engineVersion: 'v2',
  };
}

describe('stock analysis history helpers', () => {
  it('merges snapshots per symbol, dedupes identical runs, and caps retained history', () => {
    const existing = {
      AAPL: [
        makeSnapshot('AAPL', '2026-03-08T10:00:00.000Z', 70),
        makeSnapshot('AAPL', '2026-03-07T10:00:00.000Z', 66),
      ],
    };

    const incoming = [
      makeSnapshot('AAPL', '2026-03-08T10:00:00.000Z', 70),
      makeSnapshot('AAPL', '2026-03-09T10:00:00.000Z', 74, 'Strong buy'),
      ...Array.from({ length: 35 }, (_, index) =>
        makeSnapshot(
          'MSFT',
          new Date(Date.UTC(2026, 2, index + 1, 12, 0, 0)).toISOString(),
          50 + index,
        )),
    ];

    const merged = mergeStockAnalysisHistory(existing, incoming);

    assert.equal(merged.AAPL?.length, 3);
    assert.deepEqual(
      merged.AAPL?.map((snapshot) => snapshot.generatedAt),
      [
        '2026-03-09T10:00:00.000Z',
        '2026-03-08T10:00:00.000Z',
        '2026-03-07T10:00:00.000Z',
      ],
    );
    assert.equal(merged.MSFT?.length, 32);
    assert.equal(merged.MSFT?.[0]?.generatedAt, '2026-04-04T12:00:00.000Z');
    assert.equal(merged.MSFT?.at(-1)?.generatedAt, '2026-03-04T12:00:00.000Z');
  });

  it('returns the latest snapshot per symbol ordered by recency', () => {
    const history = {
      NVDA: [
        makeSnapshot('NVDA', '2026-03-05T09:00:00.000Z', 71),
        makeSnapshot('NVDA', '2026-03-04T09:00:00.000Z', 68),
      ],
      AAPL: [
        makeSnapshot('AAPL', '2026-03-08T09:00:00.000Z', 74),
      ],
      MSFT: [
        makeSnapshot('MSFT', '2026-03-07T09:00:00.000Z', 69),
      ],
    };

    const latest = getLatestStockAnalysisSnapshots(history, 2);

    assert.equal(latest.length, 2);
    assert.equal(latest[0]?.symbol, 'AAPL');
    assert.equal(latest[1]?.symbol, 'MSFT');
  });
});

describe('server-backed stock analysis history', () => {
  it('stores fresh analysis snapshots in Redis and serves them back in batch', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    globalThis.fetch = createRedisAwareFetch();

    const analysis = await analyzeStock({} as never, {
      symbol: 'AAPL',
      name: 'Apple',
      includeNews: true,
    });

    assert.equal(analysis.available, true);

    const history = await getStockAnalysisHistory({} as never, {
      symbols: 'AAPL,MSFT' as never,
      limitPerSymbol: 4,
      includeNews: true,
    });

    assert.equal(history.items.length, 1);
    assert.equal(history.items[0]?.symbol, 'AAPL');
    assert.equal(history.items[0]?.snapshots.length, 1);
    assert.equal(history.items[0]?.snapshots[0]?.signal, analysis.signal);
  });
});

describe('MarketServiceClient getStockAnalysisHistory', () => {
  it('serializes the shared history batch query parameters using generated names', async () => {
    let requestedUrl = '';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as typeof fetch;

    const client = new MarketServiceClient('');
    await client.getStockAnalysisHistory({
      symbols: ['AAPL', 'MSFT'],
      limitPerSymbol: 4,
      includeNews: true,
    });

    assert.match(requestedUrl, /\/api\/market\/v1\/get-stock-analysis-history\?/);
    assert.match(requestedUrl, /symbols=AAPL%2CMSFT|symbols=AAPL,MSFT/);
    assert.match(requestedUrl, /limit_per_symbol=4/);
    assert.match(requestedUrl, /include_news=true/);
  });
});
