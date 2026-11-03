import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConflictServiceRoutes } from '../src/generated/server/worldmonitor/conflict/v1/service_server.ts';
import { listUcdpEvents } from '../server/worldmonitor/conflict/v1/list-ucdp-events.ts';

test('UCDP ISO2 filters resolve seeded names and historical aliases', async (t) => {
  const env = { ...process.env };
  t.after(() => { process.env = env; });
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.fixture';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  process.env.VERCEL_ENV = 'production';
  const events = ['Ukraine', 'Russia (Soviet Union)', 'Bosnia-Herzegovina', 'DR Congo (Zaire)', 'Nowhere'].map((country, i) => ({ id: String(i), country }));
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(String(url), 'https://redis.fixture/get/conflict%3Aucdp-events%3Av1');
    return Response.json({ result: JSON.stringify({ events }) });
  });
  const route = createConflictServiceRoutes({ listUcdpEvents }).find(r => r.path.endsWith('/list-ucdp-events'));
  for (const [country, ids] of [['UA', ['0']], ['ua', ['0']], ['Ukraine', ['0']], ['RU', ['1']], ['BA', ['2']], ['CD', ['3']], ['Nowhere', []], ['constructor', []], ['', ['0', '1', '2', '3', '4']]]) {
    const response = await route.handler(new Request(`https://app.fixture${route.path}?country=${encodeURIComponent(country)}`));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).events.map(e => e.id), ids, country);
  }
});
