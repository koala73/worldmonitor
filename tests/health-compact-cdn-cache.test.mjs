import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Compact /api/health is the public keyless form polled by every dashboard
// tab. #4907 makes its 200s CDN-cacheable (short s-maxage) so per-tab polling
// collapses onto ~one origin Redis pipeline per cache window per edge region.
// Everything else must STAY no-store: caching the key-gated detailed response
// could leak an operator view across the shared cache, caching a 401 would
// pin an auth failure, and caching the REDIS_DOWN 503 would mask recovery
// from HTTP monitors.
//
// Run: node --test tests/health-compact-cdn-cache.test.mjs

process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
process.env.WORLDMONITOR_VALID_KEYS = 'test-health-admin-key';

const { default: handler } = await import('../api/health.js');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// redisPipeline POSTs `${url}/pipeline` with a JSON array of commands and
// expects a same-length array of { result } entries (api/_upstash-json.js).
function mockRedisPipeline() {
  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(init.body);
    const results = commands.map(([op]) => {
      if (op === 'STRLEN') return { result: 100 }; // non-sentinel data present
      if (op === 'GET') return { result: null };
      return { result: 'OK' };
    });
    return new Response(JSON.stringify(results), { status: 200 });
  };
}

test('compact 200 is CDN-cacheable with a short shared TTL', async () => {
  mockRedisPipeline();
  const res = await handler(new Request('https://api.worldmonitor.app/api/health?compact=1'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('CDN-Cache-Control'), 'public, s-maxage=60');
  const cacheControl = res.headers.get('Cache-Control');
  assert.match(cacheControl, /public/, 'shared caches must be allowed to store the compact form');
  assert.doesNotMatch(cacheControl, /no-store/);
  assert.match(cacheControl, /max-age=0/, 'browsers must revalidate so a tab sees recovery within one poll');
  assert.equal(res.headers.get('CF-Cache-Status'), null, 'no hardcoded BYPASS marker on the cacheable response');
});

test('detailed (key-authenticated) 200 stays no-store', async () => {
  mockRedisPipeline();
  const res = await handler(new Request('https://api.worldmonitor.app/api/health', {
    headers: { 'x-worldmonitor-key': 'test-health-admin-key' },
  }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Cache-Control'), /no-store/);
  assert.equal(res.headers.get('CDN-Cache-Control'), 'no-store');
});

test('keyless detailed 401 stays no-store', async () => {
  mockRedisPipeline();
  const res = await handler(new Request('https://api.worldmonitor.app/api/health'));
  assert.equal(res.status, 401);
  assert.match(res.headers.get('Cache-Control'), /no-store/);
  assert.equal(res.headers.get('CDN-Cache-Control'), 'no-store');
});

test('compact REDIS_DOWN 503 stays no-store', async () => {
  globalThis.fetch = async () => { throw new Error('upstash unreachable'); };
  const res = await handler(new Request('https://api.worldmonitor.app/api/health?compact=1'));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.status, 'REDIS_DOWN');
  assert.match(res.headers.get('Cache-Control'), /no-store/);
  assert.equal(res.headers.get('CDN-Cache-Control'), 'no-store');
});
