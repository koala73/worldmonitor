import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { getFoodPrices } from '../server/worldmonitor/economic/v1/get-food-prices';
import { buildFoodPriceSource } from '../server/worldmonitor/economic/v1/food-prices';
import sources from '../shared/food-price-sources.json';
import { drainResponseHeaders } from '../server/_shared/response-headers';

const now = Date.parse('2026-10-29T12:00:00Z');
const source = sources.find(source => source.id === 'da')!;
const row = { item: 'Rice', market: 'Market', marketType: 'retail', unit: 'kg', currency: 'PHP', origin: '', date: '2026-10-29', price: 55 };
const snapshot = (observations = [row]) => ({ fetchedAt: '2026-10-29T10:00:00Z', observations, contexts: [], reportUrl: source.url });

test('weekly price compares the same market, product, origin, currency and unit exactly seven days earlier', () => {
  const baseline = { ...row, date: '2026-10-22', price: 50 };
  const data = buildFoodPriceSource(source, snapshot([row, baseline,
    { ...baseline, unit: '20 kg', price: 1000 }, { ...baseline, origin: 'Imported', price: 40 },
    { ...baseline, market: 'Other market', price: 1 }, { ...baseline, currency: 'USD', price: 1 },
    { ...baseline, marketType: 'wholesale', price: 10 },
  ]), now);
  assert.equal(data.prices.length, 1);
  assert.equal(data.prices[0].wowAvailable, true);
  assert.equal(data.prices[0].wowPct, 10);
  assert.equal(data.prices[0].previousDate, '2026-10-22');
  assert.equal(data.status, 'current');
});

test('a missing or invalid baseline is unavailable, including zero prices and dates outside the exact week', () => {
  for (const baseline of [
    { ...row, date: '2026-10-21', price: 50 }, { ...row, date: '2026-10-22', price: 0 },
    { ...row, date: '2026-10-22', price: NaN }, { ...row, date: '2026-02-30', price: 50 },
  ]) {
    const data = buildFoodPriceSource(source, snapshot([row, baseline]), now);
    assert.equal(data.prices[0].wowAvailable, false);
    assert.equal(data.prices[0].previousDate, '');
  }
});

test('fresh fetch cannot make an old report current, and missing source data is explicit', () => {
  const data = buildFoodPriceSource(source, snapshot([{ ...row, date: '2026-09-01' }]), now);
  assert.equal(data.status, 'stale');
  assert.equal(data.latestReportDate, '2026-09-01');
  const oldFetch = buildFoodPriceSource(source, { ...snapshot(), fetchedAt: '2026-10-20T00:00:00Z' }, now);
  assert.equal(oldFetch.status, 'stale');
  assert.equal(buildFoodPriceSource(source, null, now).status, 'unavailable');
});

test('context-only Tunisia prices never receive weekly changes', () => {
  const tn = sources.find(source => source.id === 'onagri')!;
  const data = buildFoodPriceSource(tn, snapshot([row, { ...row, date: '2026-10-22', price: 50 }]), now);
  assert.equal(data.contextOnly, true);
  assert.equal(data.prices[0].wowAvailable, false);
});

test('a dropped or future observation cannot appear as a current price', () => {
  const data = buildFoodPriceSource(source, snapshot([row, { ...row, item: 'Dropped', date: '2026-10-28' }, { ...row, date: '2026-11-01', price: 100 }]), now);
  assert.deepEqual(data.prices.map(price => price.item), ['Rice']);
});

const originalFetch = globalThis.fetch;
const env = Object.fromEntries(['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'LOCAL_API_MODE'].map(key => [key, process.env[key]]));
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('RPC uses the real Redis batch reader and preserves unavailable source slots', async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://food-redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test';
  delete process.env.LOCAL_API_MODE;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/pipeline$/);
    calls++;
    const commands = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(commands.map(([, key]) => ({ result: key === 'economic:food-prices:da:v1' ? JSON.stringify({ _seed: { fetchedAt: now, recordCount: 1, sourceVersion: 'test', schemaVersion: 1, state: 'OK' }, data: snapshot() }) : null }))));
  };
  const request = new Request('https://www.worldmonitor.app/api/economic/v1/get-food-prices');
  const result = await getFoodPrices({ request } as never, {});
  assert.equal(calls, 1);
  assert.equal(result.sources.length, 7);
  assert.equal(result.sources.find(source => source.id === 'da')?.prices[0]?.price, 55);
  assert.equal(result.sources.find(source => source.id === 'pihps')?.status, 'unavailable');
  assert.equal(result.unavailable, false);
  assert.equal(drainResponseHeaders(request)?.['X-No-Cache'], '1');
});

test('missing Redis returns a non-cacheable unavailable result rather than invented prices', async () => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const request = new Request('https://www.worldmonitor.app/api/economic/v1/get-food-prices');
  const result = await getFoodPrices({ request } as never, {});
  assert.equal(result.unavailable, true);
  assert.ok(result.sources.every(source => source.status === 'unavailable' && source.prices.length === 0));
  assert.equal(drainResponseHeaders(request)?.['X-No-Cache'], '1');
});

test('each country brief retains its own fetch age and incomplete GIEWS coverage is partial', () => {
  const giews = sources.find(source => source.id === 'giews')!;
  const contexts = [
    { countryCode: 'AFG', country: 'Afghanistan', referenceDate: '2026-09-15', title: 'Brief', url: source.url, fetchedAt: '2026-10-01T00:00:00Z', fetchFailed: true },
    { countryCode: 'BGD', country: 'Bangladesh', referenceDate: '2026-09-04', title: 'Brief', url: giews.url, fetchedAt: '2026-10-29T10:00:00Z' },
    { countryCode: 'MYS', country: 'Malaysia', referenceDate: '', title: 'Brief', url: giews.url, fetchedAt: '' },
  ];
  const data = buildFoodPriceSource(giews, { ...snapshot([]), contexts }, now);
  assert.equal(data.status, 'partial');
  assert.deepEqual(data.contexts.map(context => context.status), ['stale', 'current', 'unavailable']);
  assert.equal(data.contexts[0].fetchedAt, '2026-10-01T00:00:00Z');
  assert.equal(data.contexts[0].url, giews.url);
});
