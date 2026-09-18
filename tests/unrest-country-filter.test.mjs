import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUnrestServiceRoutes } from '../src/generated/server/worldmonitor/unrest/v1/service_server.ts';
import { unrestHandler } from '../server/worldmonitor/unrest/v1/handler.ts';

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
