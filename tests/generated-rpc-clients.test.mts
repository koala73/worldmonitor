import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLazyRpcClientConstructor, MarketServiceClient } from '../src/services/generated-rpc-clients';

test('lazy generated RPC client constructor preserves generated method behavior', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ quotes: [], finnhubSkipped: false, skipReason: '', rateLimited: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const client = new MarketServiceClient('https://example.test', {
    fetch: fetchMock,
    defaultHeaders: { 'X-Test': 'lazy' },
  });

  const response = await client.listMarketQuotes({ symbols: ['AAPL', 'MSFT'] }, {
    headers: { 'X-Call': 'one' },
  });

  assert.deepEqual(response.quotes, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.test/api/market/v1/list-market-quotes?symbols=AAPL&symbols=MSFT');
  assert.equal(calls[0].init?.method, 'GET');
  assert.deepEqual(calls[0].init?.headers, {
    'Content-Type': 'application/json',
    'X-Test': 'lazy',
    'X-Call': 'one',
  });
});


test('lazy generated RPC client retries after a rejected constructor load', async () => {
  let attempts = 0;

  class TestClient {
    constructor(private readonly baseURL: string) {}

    async ping(): Promise<string> {
      return 'pong:' + this.baseURL;
    }
  }

  const LazyTestClient = createLazyRpcClientConstructor<TestClient>(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error('chunk load failed');
    }
    return TestClient;
  });

  const client = new LazyTestClient('https://example.test');

  await assert.rejects(() => client.ping(), /chunk load failed/);
  assert.equal(attempts, 1);

  assert.equal(await client.ping(), 'pong:https://example.test');
  assert.equal(attempts, 2);

  assert.equal(await client.ping(), 'pong:https://example.test');
  assert.equal(attempts, 2);
});

test('lazy generated RPC client ignores symbol lookups without loading constructor', () => {
  let attempts = 0;

  class TestClient {
    async ping(): Promise<string> {
      return 'pong';
    }
  }

  const LazyTestClient = createLazyRpcClientConstructor<TestClient>(async () => {
    attempts += 1;
    return TestClient;
  });

  const client = new LazyTestClient('https://example.test');
  const symbolValue = (client as unknown as Record<PropertyKey, unknown>)[Symbol.toPrimitive];

  assert.equal(symbolValue, undefined);
  assert.equal(attempts, 0);
});
