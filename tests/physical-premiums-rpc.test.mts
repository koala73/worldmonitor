import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { createMarketServiceRoutes, ValidationError } from '../src/generated/server/worldmonitor/market/v1/service_server.ts';
import { marketHandler } from '../server/worldmonitor/market/v1/handler.ts';
import { resolvePhysicalPremiumMetals } from '../server/worldmonitor/market/v1/get-physical-premiums.ts';
import { serverOptions } from '../server/gateway.ts';

const seed = {
  premiums: [
    {
      metal: 'gold',
      physical: {
        price: 953.88,
        currency: 'CNY',
        unit: 'gram',
        source: 'Shanghai Gold Exchange SHAU PM benchmark',
        asOf: '2026-08-18',
      },
      paper: {
        price: 4455.6,
        source: 'COMEX GC=F futures snapshot',
        asOf: '2026-08-18T12:22:24.000Z',
      },
      premiumUsdPerOz: -46.7889,
      premiumPct: -1.0501,
      computedAt: '2026-08-18T12:30:00.000Z',
    },
    {
      metal: 'silver',
      physical: {
        price: 15941,
        currency: 'CNY',
        unit: 'kilogram',
        source: 'Shanghai Gold Exchange SHAG PM benchmark',
        asOf: '2026-08-18',
      },
      paper: {
        price: 65.31,
        source: 'COMEX SI=F futures snapshot',
        asOf: '2026-08-18T12:22:16.000Z',
      },
      premiumUsdPerOz: 8.3689,
      premiumPct: 12.8142,
      computedAt: '2026-08-18T12:30:00.000Z',
    },
  ],
  fx: {
    pair: 'CNY/USD',
    rate: 0.1486,
    source: 'shared:fx-rates:v1',
    asOf: '2026-08-18T12:28:48.000Z',
  },
};

const ENV_KEYS = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'] as const;
const originalEnv = new Map<string, string | undefined>();

function routeHandler() {
  const descriptor = createMarketServiceRoutes(marketHandler, serverOptions)
    .find((route) => route.path === '/api/market/v1/get-physical-premiums');
  assert.ok(descriptor);
  return descriptor.handler;
}

function installRedisMock(payload: unknown, status = 200) {
  mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith('https://redis.test/get/')) throw new Error(`unexpected fetch: ${url}`);
    if (status !== 200) return new Response(JSON.stringify({ error: 'boom' }), { status });
    return new Response(JSON.stringify({ result: payload == null ? null : JSON.stringify(payload) }));
  });
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
});

afterEach(() => {
  mock.restoreAll();
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
});

describe('GetPhysicalPremiums contract', () => {
  it('normalizes, deduplicates, and validates metal filters', () => {
    assert.deepEqual(resolvePhysicalPremiumMetals([]), []);
    assert.deepEqual(resolvePhysicalPremiumMetals([' GOLD ', 'silver', 'gold']), ['gold', 'silver']);
    assert.throws(() => resolvePhysicalPremiumMetals(['platinum']), ValidationError);
    assert.throws(() => resolvePhysicalPremiumMetals([' ']), ValidationError);
  });

  it('bounds the echoed unsupported labels for oversized filter lists', () => {
    const labels = Array.from({ length: 5_000 }, (_, index) => `metal-${index}-${'x'.repeat(100)}`);
    let caught: unknown;
    try {
      resolvePhysicalPremiumMetals(labels);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof ValidationError);
    const [violation] = caught.violations;
    assert.equal(violation?.field, 'metals');
    assert.ok(violation.description.length <= 256, `description is ${violation.description.length} chars`);
    assert.match(violation.description, /and 4995 more/);
  });

  it('rejects oversized, duplicate, and non-canonical metal filters before Redis access', async () => {
    let redisCalls = 0;
    mock.method(globalThis, 'fetch', async () => {
      redisCalls += 1;
      return new Response(JSON.stringify({ result: null }));
    });
    const oversized = Array.from({ length: 500 }, () => 'metals=gold').join('&');
    for (const query of [
      'metals=Gold',
      'metals=%20GOLD%20',
      'metals=gold&metals=gold',
      'metals=gold&metals=silver&metals=gold',
      'metals=gold,silver',
      oversized,
    ]) {
      const response = await routeHandler()(
        new Request(`https://worldmonitor.app/api/market/v1/get-physical-premiums?${query}`),
      );
      assert.equal(response.status, 400, query.slice(0, 60));
      const body = await response.json();
      assert.match(body.violations[0].field, /^metals(?:\[\d+\])?$/, query.slice(0, 60));
    }
    assert.equal(redisCalls, 0);
  });

  it('accepts both canonical metals in one request', async () => {
    installRedisMock(seed);
    const response = await routeHandler()(
      new Request('https://worldmonitor.app/api/market/v1/get-physical-premiums?metals=silver&metals=gold'),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.premiums.map((premium: { metal: string }) => premium.metal), ['gold', 'silver']);
  });

  it('returns auditable physical, paper, premium, and FX fields', async () => {
    installRedisMock(seed);
    const response = await routeHandler()(new Request('https://worldmonitor.app/api/market/v1/get-physical-premiums'));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.premiums.length, 2);
    assert.deepEqual(body.premiums[0].paper, {
      price: 4455.6,
      currency: 'USD',
      unit: 'troy ounce',
      source: 'COMEX GC=F futures snapshot',
      asOf: '2026-08-18T12:22:24.000Z',
    });
    assert.deepEqual(body.fx, seed.fx);
  });

  it('filters the response to a requested metal', async () => {
    installRedisMock(seed);
    const response = await routeHandler()(
      new Request('https://worldmonitor.app/api/market/v1/get-physical-premiums?metals=silver'),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.premiums.map((premium: { metal: string }) => premium.metal), ['silver']);
    assert.deepEqual(body.fx, seed.fx);
  });

  it('returns a generated validation 400 before reading Redis', async () => {
    installRedisMock(null, 500);
    const response = await routeHandler()(
      new Request('https://worldmonitor.app/api/market/v1/get-physical-premiums?metals=platinum'),
    );
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.violations[0].field, /^metals(?:\[\d+\])?$/);
  });

  it('degrades a missing or malformed snapshot to an empty response', async () => {
    installRedisMock({ premiums: seed.premiums, fx: null });
    const response = await routeHandler()(new Request('https://worldmonitor.app/api/market/v1/get-physical-premiums'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { premiums: [] });
  });

  it('fails closed when cached legs or derived values are semantically inconsistent', async () => {
    for (const corrupted of [
      { ...seed, premiums: seed.premiums.map((premium, index) => index === 0 ? { ...premium, physical: { ...premium.physical, unit: 'kilogram' } } : premium) },
      { ...seed, premiums: seed.premiums.map((premium, index) => index === 0 ? { ...premium, premiumPct: 99 } : premium) },
      { ...seed, premiums: [seed.premiums[0], { ...seed.premiums[0] }] },
    ]) {
      installRedisMock(corrupted);
      const response = await routeHandler()(new Request('https://worldmonitor.app/api/market/v1/get-physical-premiums'));
      assert.deepEqual(await response.json(), { premiums: [] });
      mock.restoreAll();
    }
  });
});
