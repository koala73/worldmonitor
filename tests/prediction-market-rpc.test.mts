import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { listPredictionMarkets } from '../server/worldmonitor/prediction/v1/list-prediction-markets.ts';

const originalFetch = globalThis.fetch;
const originalEnv = {
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
};

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEnv.url === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalEnv.url;
  if (originalEnv.token === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalEnv.token;
});

describe('listPredictionMarkets legacy bootstrap compatibility', () => {
  it('dedupes the old three-pool payload and keeps the highest-volume copy', async () => {
    const base = {
      title: 'Will Iran strike Israel?',
      yesPrice: 70,
      volume: 10,
      url: 'https://polymarket.com/event/iran-strike-israel',
      endDate: '2099-01-01T00:00:00Z',
      source: 'polymarket',
    } as const;
    const payload = {
      geopolitical: [base],
      tech: [{ ...base, volume: 30 }],
      finance: [{ ...base, volume: 20 }],
      fetchedAt: 123,
    };

    globalThis.fetch = async () => new Response(JSON.stringify({
      result: JSON.stringify(payload),
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    const response = await listPredictionMarkets({} as never, {
      category: '',
      query: '',
      pageSize: 100,
      cursor: '',
    });

    assert.equal(response.dataAvailable, true);
    assert.equal(response.markets.length, 1);
    assert.equal(response.markets[0].volume, 30);
    assert.equal(response.fetchedAt, 123);
  });

  it('reads the country index directly for a country category', async () => {
    const payload = {
      countries: {
        US: [{
          title: 'Will United States GDP grow in 2027?',
          yesPrice: 61,
          volume: 25_000,
          url: 'https://kalshi.com/markets/USGDP-27',
          endDate: '2027-12-31T00:00:00Z',
          source: 'kalshi',
        }],
      },
      fetchedAt: 456,
    };
    const requestedKeys: string[] = [];
    globalThis.fetch = async (input) => {
      requestedKeys.push(decodeURIComponent(new URL(String(input)).pathname.split('/').pop() || ''));
      return new Response(JSON.stringify({ result: JSON.stringify(payload) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const response = await listPredictionMarkets({} as never, {
      category: 'country:US',
      query: '',
      pageSize: 5,
      cursor: '',
    } as never);

    assert.deepEqual(requestedKeys, ['prediction:markets-country-index:v1']);
    assert.equal(response.dataAvailable, true);
    assert.equal(response.markets.length, 1);
    assert.equal(response.markets[0].source, 'MARKET_SOURCE_KALSHI');
    assert.equal(response.fetchedAt, 456);
  });

  it('filters country markets by query before applying page size', async () => {
    const payload = {
      countries: {
        US: [
          {
            title: 'Will the Fed cut rates in 2026?',
            yesPrice: 40,
            volume: 50_000,
            url: 'https://kalshi.com/markets/FEDCUT-26',
            endDate: '2026-12-31T00:00:00Z',
            source: 'kalshi',
          },
          {
            title: 'Will United States GDP grow in 2027?',
            yesPrice: 61,
            volume: 25_000,
            url: 'https://kalshi.com/markets/USGDP-27',
            endDate: '2027-12-31T00:00:00Z',
            source: 'kalshi',
          },
          {
            title: 'Will US GDP exceed 30T in 2028?',
            yesPrice: 55,
            volume: 12_000,
            url: 'https://kalshi.com/markets/USGDP-28',
            endDate: '2028-12-31T00:00:00Z',
            source: 'kalshi',
          },
        ],
      },
      fetchedAt: 456,
    };
    globalThis.fetch = async () => new Response(JSON.stringify({
      result: JSON.stringify(payload),
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    const response = await listPredictionMarkets({} as never, {
      category: 'country:US',
      query: 'GDP',
      pageSize: 1,
      cursor: '',
    } as never);

    assert.equal(response.dataAvailable, true);
    assert.equal(response.markets.length, 1);
    assert.match(response.markets[0].title, /GDP/i);
    assert.equal(response.markets[0].url, 'https://kalshi.com/markets/USGDP-27');
  });

  it('fails closed for a malformed country category', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return Response.json({ result: null });
    };

    const response = await listPredictionMarkets({} as never, {
      category: 'country:USA',
      query: '',
      pageSize: 5,
      cursor: '',
    });

    assert.equal(fetchCalls, 0);
    assert.equal(response.dataAvailable, false);
    assert.deepEqual(response.markets, []);
  });
});
