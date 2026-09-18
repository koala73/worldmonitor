import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadNotamClosures } from '../server/worldmonitor/aviation/v1/_shared.ts';
import { listAirportDelays } from '../server/worldmonitor/aviation/v1/list-airport-delays.ts';
import { getAirportOpsSummary } from '../server/worldmonitor/aviation/v1/get-airport-ops-summary.ts';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis.ts';

const originalFetch = globalThis.fetch;
const key = 'aviation:notam:closures:v2';
const meta = 'seed-meta:aviation:notam';
const seed = { closedIcaos: ['EGLL'], restrictedIcaos: [], reasons: { EGLL: 'Airport closed' } };
let values, failures, reads, providerCalls;
beforeEach(() => {
  values = new Map(); failures = new Set(); reads = new Map(); providerCalls = 0;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test';
  process.env.ICAO_API_KEY = 'test';
  process.env.VERCEL_ENV = 'production';
  delete process.env.SEED_FALLBACK_NOTAM;
  __resetKeyPrefixCacheForTests();
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('https://redis.test/get/')) {
      const name = decodeURIComponent(url.split('/get/')[1]);
      const count = (reads.get(name) ?? 0) + 1;
      reads.set(name, count);
      if (failures.has(name) || failures.has(`${name}:${count}`)) return new Response('', { status: 503 });
      return Response.json({ result: values.has(name) ? JSON.stringify(values.get(name)) : null });
    }
    if (url.startsWith('https://redis.test/')) return Response.json({ result: 'OK' });
    providerCalls++;
    return Response.json([]);
  };
});
after(() => { globalThis.fetch = originalFetch; });

for (const [name, handler] of [['delays', listAirportDelays], ['ops', getAirportOpsSummary]]) {
  for (const failure of [key, meta, `${key}:2`]) {
    test(`${name}: ${failure} failure must not authorize NOTAM work`, async () => {
      failures.add(failure);
      await handler({}, { airports: 'LHR' });
      assert.equal(providerCalls, 0);
    });
  }
  test(`${name}: readable last-good seed survives metadata failure`, async () => {
    values.set(key, seed); failures.add(meta);
    process.env.SEED_FALLBACK_NOTAM = '1';
    const response = await handler({}, { airports: 'LHR' });
    assert.equal(providerCalls, 0);
    if (name === 'ops') assert.equal(response.summaries[0].closureStatus, true);
    else assert.ok(response.alerts.some(row => row.iata === 'LHR' && row.reason.includes('Airport closed')));
  });
}
test('healthy misses retain provider fallback and coalesce concurrent consumers', async () => {
  await Promise.all([listAirportDelays({}, {}), getAirportOpsSummary({}, { airports: 'LHR' })]);
  assert.equal(providerCalls, 1);
});
for (const stale of [false, true]) {
  test(`readable ${stale ? 'stale' : 'fresh'} seed remains usable`, async () => {
    values.set(key, seed);
    values.set(meta, { fetchedAt: stale ? 1 : Date.now() });
    assert.deepEqual(await loadNotamClosures(), seed);
    assert.equal(providerCalls, 0);
  });
}
test('healthy stale seed opt-in retains prefixed live-cache fallback', async () => {
  process.env.SEED_FALLBACK_NOTAM = '1';
  process.env.VERCEL_ENV = 'preview';
  __resetKeyPrefixCacheForTests();
  values.set(key, seed); values.set(meta, { fetchedAt: 1 });
  await loadNotamClosures();
  assert.equal(providerCalls, 1);
});
test('write failure keeps local closures visible through later Redis read errors without new provider work', async () => {
  const fetchImpl = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://redis.test/') && !url.includes('/get/')) return new Response('', { status: 503 });
    if (!url.startsWith('https://redis.test/')) {
      providerCalls++;
      return Response.json([{ itema: 'EGLL', iteme: 'Airport closed' }]);
    }
    return fetchImpl(input, init);
  };
  assert.deepEqual((await loadNotamClosures()).closedIcaos, ['EGLL']);
  failures.add(key); failures.add(meta);
  const ops = await getAirportOpsSummary({}, { airports: 'LHR' });
  assert.equal(ops.summaries[0].closureStatus, true);
  const delays = await listAirportDelays({}, {});
  assert.ok(delays.alerts.some(row => row.iata === 'LHR' && row.reason.includes('Airport closed')));
  assert.equal(providerCalls, 1);
});
