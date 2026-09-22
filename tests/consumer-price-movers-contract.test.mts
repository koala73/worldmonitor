import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';
import { listConsumerPriceMovers } from '../server/worldmonitor/consumer-prices/v1/list-consumer-price-movers';
import { createConsumerPricesServiceRoutes, ValidationError, type ConsumerPricesServiceHandler } from '../src/generated/server/worldmonitor/consumer_prices/v1/service_server';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const snapshot = { marketCode: 'ae', asOf: '1789344000000', range: '90d', upstreamUnavailable: false,
  risers: Array.from({ length: 12 }, (_, index) => ({ productId: `up-${index}`, category: index % 2 ? 'dairy' : 'fruit' })),
  fallers: Array.from({ length: 12 }, (_, index) => ({ productId: `down-${index}`, category: 'dairy' })) };
const keys: string[] = [];
beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.fixture';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture-token';
  keys.length = 0;
  globalThis.fetch = async (url) => {
    keys.push(decodeURIComponent(String(url).split('/get/')[1]));
    return Response.json({ result: JSON.stringify(snapshot) });
  };
});
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...originalEnv }; });

for (const [query, expected] of [['', 10], ['&limit=0', 10], ['&limit=3', 3], ['&limit=-1', 10], ['&limit=99', 10], ['&limit=', 10], ['&limit=oops', 10]] as const) {
  test(`generated movers GET uses limit ${query || 'omitted'}`, async () => {
    const routes = createConsumerPricesServiceRoutes({ listConsumerPriceMovers } as ConsumerPricesServiceHandler);
    const route = routes.find((entry) => entry.path.endsWith('/list-consumer-price-movers'))!;
    const response = await route.handler(new Request(`https://worldmonitor.app${route.path}?market_code=ae&range=90d${query}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.range, '90d');
    assert.equal(body.risers.length, expected);
    assert.equal(body.fallers.length, expected);
    assert.equal(body.upstreamUnavailable, false);
    assert.deepEqual(keys, ['consumer-prices:movers:ae:90d']);
  });
}

test('uppercase ISO-2 market codes hit the lowercase seed key', async () => {
  const routes = createConsumerPricesServiceRoutes({ listConsumerPriceMovers } as ConsumerPricesServiceHandler);
  const route = routes.find((entry) => entry.path.endsWith('/list-consumer-price-movers'))!;
  const response = await route.handler(new Request(`https://worldmonitor.app${route.path}?market_code=US&range=90d`));
  assert.equal(response.status, 200);
  const body = await response.json();
  // The OpenAPI contract documents ISO 3166-1 alpha-2 ("US"); the seeder
  // writes lowercase keys, so the handler must normalize before the lookup.
  assert.deepEqual(keys, ['consumer-prices:movers:us:90d']);
  assert.equal(body.upstreamUnavailable, false);
  // The cached snapshot echoes its seeded market code; the assertion that
  // matters is the normalized lookup key above.
  assert.equal(body.marketCode, 'ae');
});

test('malformed or unsupported market codes are rejected before any cache read', async () => {
  // #8359 made the market an explicit selection (resolveConsumerPriceSelection):
  // an unusable code is a 400, not a silent fallback to another market's data.
  const routes = createConsumerPricesServiceRoutes({ listConsumerPriceMovers } as ConsumerPricesServiceHandler);
  const route = routes.find((entry) => entry.path.endsWith('/list-consumer-price-movers'))!;
  for (const code of ['%20%20', 'not-a-country', 'zz']) {
    const response = await route.handler(new Request(`https://worldmonitor.app${route.path}?market_code=${code}&range=30d`));
    assert.equal(response.status, 400, code);
  }
  assert.deepEqual(keys, []);
});

const SELECTION_HANDLERS = [
  ['get-consumer-price-overview', 'getConsumerPriceOverview', 'consumer-prices:overview:us'],
  ['list-consumer-price-categories', 'listConsumerPriceCategories', 'consumer-prices:categories:us:30d'],
  ['list-consumer-price-movers', 'listConsumerPriceMovers', 'consumer-prices:movers:us:30d'],
  ['list-retailer-price-spreads', 'listRetailerPriceSpreads', 'consumer-prices:retailer-spread:us:essentials-us'],
] as const;

for (const [file, exportName, expectedKey] of SELECTION_HANDLERS) {
  test(`${file} resolves the market like basket-series and freshness`, async () => {
    const mod = await import(`../server/worldmonitor/consumer-prices/v1/${file}.ts`);
    const handler = mod[exportName] as (ctx: unknown, req: Record<string, unknown>) => Promise<unknown>;
    // The OpenAPI contract documents ISO 3166-1 alpha-2 ("US"); the seeder
    // writes lowercase keys, so the lookup must be normalized.
    await handler({}, { marketCode: 'US', basketSlug: '', range: '30d', limit: 0, categorySlug: '' });
    assert.deepEqual(keys, [expectedKey]);
    keys.length = 0;
    await assert.rejects(
      handler({}, { marketCode: '  ', basketSlug: '', range: '30d', limit: 0, categorySlug: '' }),
      (error: unknown) => error instanceof ValidationError,
    );
    assert.deepEqual(keys, []);
  });
}

test('retailer spreads rejects a basket that is not the market essentials basket', async () => {
  const { listRetailerPriceSpreads } = await import('../server/worldmonitor/consumer-prices/v1/list-retailer-price-spreads.ts');
  await assert.rejects(
    listRetailerPriceSpreads({}, { marketCode: 'ae', basketSlug: 'essentials-us' }),
    (error: unknown) => error instanceof ValidationError,
  );
  assert.deepEqual(keys, []);
});

test('both movers producers include the public 90d range and seed metadata', () => {
  const publish = readFileSync(new URL('../consumer-prices-core/src/jobs/publish.ts', import.meta.url), 'utf8');
  const seed = readFileSync(new URL('../scripts/seed-consumer-prices.mjs', import.meta.url), 'utf8');
  const proto = readFileSync(new URL('../proto/worldmonitor/consumer_prices/v1/list_consumer_price_movers.proto', import.meta.url), 'utf8');
  const documented = [...proto.match(/range is one of ([^.]+)/)![1].matchAll(/"(\d+)d"/g)].map((match) => Number(match[1]));
  const loop = publish.match(/for \(const days of \[([^\]]+)\]\)/)!;
  assert.deepEqual(loop[1].split(',').map(Number), documented);
  for (const days of documented) {
    assert.ok(seed.includes(`fetchSnapshot(\`/wm/consumer-prices/v1/movers?market=\${MARKET}&days=${days}\`)`));
    assert.ok(seed.includes(`key: \`consumer-prices:movers:\${MARKET}:${days}d\``));
    assert.ok(seed.includes(`metaKey: \`seed-meta:consumer-prices:movers:\${MARKET}:${days}d\``));
  }
});

 test('category filtering precedes the limit and cache misses stay unavailable', async () => {
  const response = await listConsumerPriceMovers({}, { marketCode: 'ae', range: '90d', limit: 2, categorySlug: 'dairy' });
  assert.deepEqual(response.risers.map((mover) => mover.productId), ['up-1', 'up-3']);
  globalThis.fetch = async () => Response.json({ result: null });
  const missing = await listConsumerPriceMovers({}, { marketCode: 'ae', range: '90d', limit: 0, categorySlug: '' });
  assert.deepEqual(missing, { marketCode: 'ae', asOf: '0', range: '90d', risers: [], fallers: [], upstreamUnavailable: true });
});
