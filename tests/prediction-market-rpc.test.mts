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
});
