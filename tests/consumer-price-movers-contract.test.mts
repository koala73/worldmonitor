import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';
import { listConsumerPriceMovers } from '../server/worldmonitor/consumer-prices/v1/list-consumer-price-movers';
import { createConsumerPricesServiceRoutes, type ConsumerPricesServiceHandler } from '../src/generated/server/worldmonitor/consumer_prices/v1/service_server';

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
