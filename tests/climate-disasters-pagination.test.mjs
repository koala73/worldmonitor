import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClimateServiceRoutes } from '../src/generated/server/worldmonitor/climate/v1/service_server.ts';
import { listClimateDisasters } from '../server/worldmonitor/climate/v1/list-climate-disasters.ts';

test('climate disasters use the default page when page_size is omitted', async (t) => {
  const env = { ...process.env };
  t.after(() => { process.env = env; });
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.fixture';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  process.env.VERCEL_ENV = 'production';
  const disasters = Array.from({ length: 105 }, (_, i) => ({ id: `disaster-${i}` }));
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(String(url), 'https://redis.fixture/get/climate%3Adisasters%3Av1');
    return Response.json({ result: JSON.stringify({ disasters }) });
  });
  const route = createClimateServiceRoutes({ listClimateDisasters }).find(r => r.path.endsWith('/list-climate-disasters'));
  for (const [query, count, cursor] of [['', 100, '100'], ['?page_size=0', 100, '100'], ['?page_size=2', 2, '2'], ['?page_size=1000', 100, '100'], ['?cursor=100', 5, '']]) {
    const response = await route.handler(new Request(`https://app.fixture${route.path}${query}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.disasters.length, count, query || 'omitted page_size');
    assert.equal(body.pagination.nextCursor, cursor);
    assert.equal(Number(body.pagination.totalCount), 105);
  }
});
