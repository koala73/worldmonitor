import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { searchPricesTravelpayouts } from '../server/worldmonitor/aviation/v1/_providers/travelpayouts_data.ts';
import { createAviationServiceRoutes } from '../src/generated/server/worldmonitor/aviation/v1/service_server.ts';
import { aviationHandler } from '../server/worldmonitor/aviation/v1/handler.ts';
import { createDomainGateway, serverOptions } from '../server/gateway.ts';
import { __resetRateLimitForTest } from '../server/_shared/rate-limit.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const PATH = '/api/aviation/v1/search-flight-prices';
const KEY = 'synthetic-flight-key';
const base = {
  origin: 'IST',
  destination: 'LHR',
  departureDate: '',
  returnDate: '',
  cabin: 'CABIN_CLASS_ECONOMY',
  nonstopOnly: false,
  maxResults: 5,
  currency: 'usd',
  market: 'us',
  token: 'synthetic-provider-token',
};

let calls: URL[];
let upstream: { success: boolean; data: Record<string, unknown>[] };
let redis: ReturnType<typeof installRedis>;

beforeEach(() => {
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.AVIATION_DEMO_PRICES;
  process.env.WORLDMONITOR_VALID_KEYS = KEY;
  process.env.TRAVELPAYOUTS_API_TOKEN = base.token;
  __resetRateLimitForTest();
  calls = [];
  upstream = { success: true, data: [] };
  redis = installRedis({});
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.hostname === 'api.travelpayouts.com') return Response.json(upstream);
    return redis.fetchImpl(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  __resetRateLimitForTest();
});

const providerCalls = () => calls.filter(url => url.hostname === 'api.travelpayouts.com');

function onlyProviderUrl(pathname: string): URL {
  const urls = providerCalls().filter(url => url.pathname === pathname);
  assert.equal(urls.length, 1, `expected one ${pathname} request`);
  return urls[0]!;
}

const ticket = (fields: Record<string, unknown>) => ({
  origin: 'IST',
  destination: 'LHR',
  depart_date: '2030-01-02',
  value: 100,
  ...fields,
});

describe('Travelpayouts v2 cabin and month-matrix price', () => {
  for (const [cabin, tripClass] of [
    ['CABIN_CLASS_ECONOMY', '0'],
    ['CABIN_CLASS_BUSINESS', '1'],
    ['CABIN_CLASS_FIRST', '2'],
    ['CABIN_CLASS_PREMIUM_ECONOMY', '0'],
  ] as const) {
    it(`sends trip_class=${tripClass} for ${cabin} on v2/latest`, async () => {
      await searchPricesTravelpayouts({ ...base, cabin, departureDate: '' });
      assert.equal(onlyProviderUrl('/v2/prices/latest').searchParams.get('trip_class'), tripClass);
    });
  }

  for (const [tripClass, cabin] of [
    [0, 'CABIN_CLASS_ECONOMY'],
    [1, 'CABIN_CLASS_BUSINESS'],
    [2, 'CABIN_CLASS_FIRST'],
  ] as const) {
    it(`maps v2/latest trip_class ${tripClass} to ${cabin}`, async () => {
      upstream = { success: true, data: [ticket({ trip_class: tripClass })] };
      const result = await searchPricesTravelpayouts({ ...base, cabin: 'CABIN_CLASS_BUSINESS', departureDate: '' });
      assert.equal(result.upstreamFailed, false);
      assert.equal(result.quotes.length, 1);
      assert.equal(result.quotes[0]?.cabin, cabin);
    });

    it(`maps v2/month-matrix trip_class ${tripClass} to ${cabin}`, async () => {
      upstream = { success: true, data: [ticket({ trip_class: tripClass, value: 500 })] };
      const result = await searchPricesTravelpayouts({ ...base, departureDate: '2030-01' });
      assert.equal(onlyProviderUrl('/v2/prices/month-matrix').pathname, '/v2/prices/month-matrix');
      assert.equal(result.quotes.length, 1);
      assert.equal(result.quotes[0]?.cabin, cabin);
      assert.equal(result.quotes[0]?.priceAmount, 500);
    });
  }

  for (const [label, fields] of [
    ['missing trip_class', {}],
    ['unexpected trip_class', { trip_class: 9 }],
  ] as const) {
    for (const [path, departureDate] of [
      ['/v2/prices/latest', ''],
      ['/v2/prices/month-matrix', '2030-01'],
    ] as const) {
      it(`labels ${label} as unspecified on ${path}`, async () => {
        upstream = { success: true, data: [ticket(fields)] };
        const result = await searchPricesTravelpayouts({ ...base, cabin: 'CABIN_CLASS_BUSINESS', departureDate });
        assert.equal(onlyProviderUrl(path).pathname, path);
        assert.equal(result.quotes.length, 1);
        assert.equal(result.quotes[0]?.cabin, 'CABIN_CLASS_UNSPECIFIED');
      });
    }
  }

  it('reads month-matrix value as the fare', async () => {
    upstream = {
      success: true,
      data: [{ origin: 'LED', destination: 'HKT', depart_date: '2030-01-02', trip_class: 0, value: 500 }],
    };
    const result = await searchPricesTravelpayouts({ ...base, origin: 'LED', destination: 'HKT', departureDate: '2030-01' });
    assert.equal(result.upstreamFailed, false);
    assert.equal(result.quotes.length, 1);
    assert.equal(result.quotes[0]?.priceAmount, 500);
  });

  it('reads the documented month-matrix example amount', async () => {
    upstream = {
      success: true,
      data: [{ origin: 'LED', destination: 'HKT', depart_date: '2015-10-01', trip_class: 0, value: 29127 }],
    };
    const result = await searchPricesTravelpayouts({ ...base, origin: 'LED', destination: 'HKT', departureDate: '2015-10' });
    assert.equal(result.quotes[0]?.priceAmount, 29127);
  });

  it('prefers value over a legacy price field', async () => {
    upstream = { success: true, data: [ticket({ value: 500, price: 1, trip_class: 0 })] };
    const result = await searchPricesTravelpayouts({ ...base, departureDate: '2030-01' });
    assert.equal(result.quotes[0]?.priceAmount, 500);
  });

  it('uses price only when value is absent', async () => {
    const row = ticket({ trip_class: 0, price: 500 });
    delete row.value;
    upstream = { success: true, data: [row] };
    const result = await searchPricesTravelpayouts({ ...base, departureDate: '2030-01' });
    assert.equal(result.quotes.length, 1);
    assert.equal(result.quotes[0]?.priceAmount, 500);
  });

  for (const [label, row] of [
    ['missing amount', ticket({ trip_class: 0 })],
    ['zero value', ticket({ trip_class: 0, value: 0, price: 80 })],
    ['negative value', ticket({ trip_class: 0, value: -5 })],
  ] as const) {
    it(`drops a month-matrix quote with ${label}`, async () => {
      const fields = { ...row };
      if (label === 'missing amount') delete fields.value;
      upstream = { success: true, data: [fields, ticket({ trip_class: 0, value: 500 })] };
      const result = await searchPricesTravelpayouts({ ...base, departureDate: '2030-01', maxResults: 1 });
      assert.equal(result.upstreamFailed, false);
      assert.deepEqual(result.quotes.map(quote => quote.priceAmount), [500]);
    });
  }
});

describe('public flight-search date boundary', () => {
  const gateway = createDomainGateway(createAviationServiceRoutes(aviationHandler, serverOptions));

  function request(departureDate: string) {
    const params = new URLSearchParams({
      origin: 'IST',
      destination: 'LHR',
      departure_date: departureDate,
      cabin: 'CABIN_CLASS_BUSINESS',
      currency: 'usd',
      market: 'us',
    });
    return new Request(`http://127.0.0.1${PATH}?${params}`, {
      headers: { 'X-WorldMonitor-Key': KEY, 'x-vercel-forwarded-for': '192.0.2.1' },
    });
  }

  it('rejects a month-only departure date before any provider call', async () => {
    const response = await gateway(request('2030-01'));
    assert.equal(response.status, 400);
    assert.equal(providerCalls().length, 0);
  });
});
