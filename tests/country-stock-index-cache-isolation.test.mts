import assert from 'node:assert/strict';
import test from 'node:test';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
};

function restoreEnvironment() {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_ENV.url == null) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = ORIGINAL_ENV.url;
  if (ORIGINAL_ENV.token == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = ORIGINAL_ENV.token;
}

test('CN country-index RPC prefers Railway data and leaves its key seed-owned', async (t) => {
  t.after(restoreEnvironment);
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const requested = [] as string[];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    if (url.includes('/get/market%3Astock-index%3Av1%3ACN')) {
      return new Response(JSON.stringify({ result: JSON.stringify({
        available: true,
        code: 'CN',
        symbol: '000001.SS',
        indexName: 'SSE Composite',
        price: 3355,
        weekChangePercent: 1.67,
        currency: 'CNY',
        fetchedAt: '2026-07-14T12:00:00.000Z',
      }) }), { status: 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const { getCountryStockIndex } = await import('../server/worldmonitor/market/v1/get-country-stock-index.ts');
  const result = await getCountryStockIndex({} as never, { countryCode: 'CN' } as never);

  assert.equal(result.available, true);
  assert.equal(result.price, 3355);
  assert.deepEqual(requested, ['https://redis.example.test/get/market%3Astock-index%3Av1%3ACN']);
});
