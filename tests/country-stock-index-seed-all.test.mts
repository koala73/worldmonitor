import assert from 'node:assert/strict';
import test from 'node:test';

// #6235: the country-index RPC took its Railway-seeded snapshot only for CN.
// The input is a bounded country enum, so the whole enum is seedable; the rest
// were lazy-fetched from Yahoo at the edge with an in-memory-only fallback,
// which means a cold isolate had no fallback at all. #6240 later removed the
// countries flagged `unavailable` from the seed work-list.

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

function seededSnapshot(code: string, symbol: string, indexName: string, currency: string) {
  return {
    available: true,
    code,
    symbol,
    indexName,
    price: 18234.5,
    weekChangePercent: 0.82,
    currency,
    fetchedAt: '2026-08-05T06:00:00.000Z',
  };
}

test('a seeded non-CN country index is served from Redis without touching Yahoo', async (t) => {
  t.after(restoreEnvironment);
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

  const requested: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    if (url.includes('/get/market%3Astock-index%3Av1%3ADE')) {
      return new Response(JSON.stringify({
        result: JSON.stringify(seededSnapshot('DE', '^GDAXI', 'DAX', 'EUR')),
      }), { status: 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const { getCountryStockIndex } = await import('../server/worldmonitor/market/v1/get-country-stock-index.ts');
  const result = await getCountryStockIndex({} as never, { countryCode: 'DE' } as never);

  assert.equal(result.available, true);
  assert.equal(result.code, 'DE');
  assert.equal(result.price, 18234.5);
  assert.deepEqual(
    requested,
    ['https://redis.example.test/get/market%3Astock-index%3Av1%3ADE'],
    'a seeded country must not trigger a Yahoo fetch',
  );
});

test('a seed row for the wrong country is rejected rather than served', async (t) => {
  t.after(restoreEnvironment);
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

  let yahooCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/get/market%3Astock-index%3Av1%3AFR')) {
      // Wrong code in the payload — a key/paylod mismatch must not be trusted.
      return new Response(JSON.stringify({
        result: JSON.stringify(seededSnapshot('DE', '^GDAXI', 'DAX', 'EUR')),
      }), { status: 200 });
    }
    if (url.startsWith('https://query1.finance.yahoo.com/')) {
      yahooCalls += 1;
      return new Response(JSON.stringify({
        chart: {
          result: [{
            meta: { currency: 'EUR' },
            indicators: { quote: [{ close: [7600, 7620, 7650, 7680, 7700, 7710, 7725] }] },
          }],
        },
      }), { status: 200 });
    }
    if (url.startsWith('https://redis.example.test/')) {
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const { getCountryStockIndex } = await import('../server/worldmonitor/market/v1/get-country-stock-index.ts');
  const result = await getCountryStockIndex({} as never, { countryCode: 'FR' } as never);

  assert.equal(result.code, 'FR', 'a mismatched seed row must not leak another country’s index');
  assert.equal(yahooCalls, 1, 'the handler must fall through to its own fetch instead');
});

test('every country in the public enum has an index definition', async () => {
  const contracts = (await import('../shared/openapi-filter-param-contracts.json', {
    with: { type: 'json' },
  })).default as {
    marketCountryStockIndexes: Record<string, {
      symbol: string;
      name: string;
      unavailable?: { checked: string; reason: string };
    }>;
  };

  const entries = Object.entries(contracts.marketCountryStockIndexes);
  assert.ok(entries.length >= 45, `expected the full country enum, got ${entries.length}`);

  for (const [code, index] of entries) {
    assert.match(code, /^[A-Z]{2}$/, `${code} must be an ISO-3166 alpha-2 code`);
    assert.ok(index.symbol && index.symbol.trim(), `${code} must declare a Yahoo symbol`);
    assert.ok(index.name && index.name.trim(), `${code} must declare an index name`);
    if (index.unavailable) {
      // #6240: a country kept in the enum with a symbol Yahoo cannot serve must
      // say so with dated evidence, so the flag can be revisited rather than
      // rot into a silent `available: false`.
      assert.match(index.unavailable.checked, /^\d{4}-\d{2}-\d{2}$/, `${code}.unavailable.checked must be an ISO date`);
      assert.ok(index.unavailable.reason.trim().length > 20, `${code}.unavailable.reason must explain the gap`);
    }
  }
});

test('the seed work-list excludes flagged countries but the enum keeps them', async () => {
  const registry = await import('../scripts/_country-stock-index-registry.mjs');
  const declared = registry.loadDeclaredCountryStockIndexes();
  const seedable = registry.loadCountryStockIndexes();
  const unavailable = registry.loadUnavailableCountryStockIndexes();

  assert.equal(declared.length, seedable.length + unavailable.length);
  assert.ok(unavailable.length > 0, 'the #6240 flags are expected to be present');
  for (const index of seedable) {
    assert.equal(index.unavailable, undefined, `${index.code} must not be seeded while flagged`);
  }
  for (const index of unavailable) {
    assert.ok(index.unavailable?.checked, `${index.code} must carry its evidence date`);
  }
  // Portugal was one of the eight dead symbols; PSI20.LS is the Euronext Lisbon
  // ticker Yahoo actually serves (24 daily closes over the month to 2026-09-13).
  assert.equal(seedable.find((index) => index.code === 'PT')?.symbol, 'PSI20.LS');
});

test('a flagged country answers available:false without touching Redis or Yahoo', async (t) => {
  t.after(restoreEnvironment);
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

  const requested: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested.push(String(input));
    throw new Error(`unexpected request: ${String(input)}`);
  }) as typeof fetch;

  const { getCountryStockIndex } = await import('../server/worldmonitor/market/v1/get-country-stock-index.ts');
  const result = await getCountryStockIndex({} as never, { countryCode: 'RU' } as never);

  assert.equal(result.available, false);
  assert.equal(result.code, 'RU');
  assert.deepEqual(requested, [], 'a known-dead symbol must not spend a Redis read or a Yahoo request');
});

test('an unknown country code is still rejected ahead of the flag check', async () => {
  const { getCountryStockIndex } = await import('../server/worldmonitor/market/v1/get-country-stock-index.ts');
  const result = await getCountryStockIndex({} as never, { countryCode: 'XX' } as never);
  assert.equal(result.available, false);
  assert.equal(result.code, 'XX');
});
