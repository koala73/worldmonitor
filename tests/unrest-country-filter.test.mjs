import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUnrestServiceRoutes } from '../src/generated/server/worldmonitor/unrest/v1/service_server.ts';
import { unrestHandler } from '../server/worldmonitor/unrest/v1/handler.ts';
import { mapErrorToResponse } from '../server/error-mapper.ts';

test('unrest country filtering uses country identity and retains date and sort behavior', async (t) => {
  const env = { ...process.env };
  t.after(() => { process.env = env; });
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.fixture';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  process.env.VERCEL_ENV = 'production';
  const events = ['United States', 'Russia', 'Australia', 'United Kingdom', 'Nowhere', 'United States'].map((country, i) => ({
    id: String(i), title: `Event ${i}`, summary: '', eventType: 'UNREST_EVENT_TYPE_PROTEST', city: '', country, region: '',
    occurredAt: (i + 1) * 1000, severity: 'SEVERITY_LEVEL_LOW', fatalities: 0, sources: [],
    sourceType: 'UNREST_SOURCE_TYPE_ACLED', tags: [], actors: [], confidence: 'CONFIDENCE_LEVEL_HIGH', sourceUrls: [],
  }));
  events[0].severity = 'SEVERITY_LEVEL_HIGH';
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(String(url), 'https://redis.fixture/get/unrest%3Aevents%3Av1');
    return Response.json({ result: JSON.stringify({ events }) });
  });
  const route = createUnrestServiceRoutes(unrestHandler).find(r => r.path.endsWith('/list-unrest-events'));
  for (const [query, ids] of [['country=US', ['0', '5']], ['country=United%20States', ['0', '5']], ['country=us&start=2000&end=6000', ['5']], ['country=UK', ['3']], ['country=Nowhere', []], ['country=constructor', []], ['', ['0', '5', '4', '3', '2', '1']]]) {
    const response = await route.handler(new Request(`https://app.fixture${route.path}?${query}`));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).events.map(e => e.id), ids, query);
  }
});

test('unrest seed decode drops malformed events instead of failing the feed', async (t) => {
  const env = { ...process.env };
  t.after(() => { process.env = env; });
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.fixture';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  process.env.VERCEL_ENV = 'production';
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const event = (id, extra = {}) => ({
    id, title: `Event ${id}`, summary: '', eventType: 'UNREST_EVENT_TYPE_PROTEST', city: '', country: 'US', region: '',
    location: { latitude: 1, longitude: 2 }, occurredAt: 1000, severity: 'SEVERITY_LEVEL_LOW', fatalities: 0, sources: [],
    sourceType: 'UNREST_SOURCE_TYPE_ACLED', tags: [], actors: [], confidence: 'CONFIDENCE_LEVEL_HIGH', sourceUrls: [], ...extra,
  });
  let payload;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ result: payload === undefined ? null : JSON.stringify(payload) }));
  const route = createUnrestServiceRoutes(unrestHandler, { onError: mapErrorToResponse }).find(r => r.path.endsWith('/list-unrest-events'));
  const call = async () => {
    const response = await route.handler(new Request(`https://app.fixture${route.path}`));
    return { status: response.status, body: response.status === 200 ? await response.json() : null };
  };

  // The seeder serializes an unparseable ACLED event_date as occurredAt: null (NaN -> JSON null).
  payload = { events: [event('good'), event('bad-date', { occurredAt: null }), event('bad-geo', { location: { latitude: 'x', longitude: 2 } }), null] };
  const mixed = await call();
  assert.equal(mixed.status, 200);
  assert.deepEqual(mixed.body.events.map(e => e.id), ['good']);

  payload = { events: [] };
  assert.equal((await call()).status, 200, 'a confirmed empty seed is still a valid response');

  for (const bad of [undefined, {}, { events: null }, { events: [{}] }, { events: [event('x', { occurredAt: null })] }]) {
    payload = bad;
    assert.equal((await call()).status, 503, JSON.stringify(bad));
  }
});
