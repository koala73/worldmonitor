import { strict as assert } from 'node:assert';
import test from 'node:test';

// Make this suite independent of the ambient environment. The handler reads
// Redis credentials per-request via getRedisCredentials(); if a developer (or
// CI job) has real UPSTASH_REDIS_REST_URL/TOKEN exported, the GET test below
// would take the live 200 path instead of the deterministic REDIS_DOWN→503
// path and fail spuriously. Clearing the creds before importing the handler
// forces the no-Redis path regardless of env — the CORS headers under test are
// identical on both paths, so this only stabilizes the status code.
for (const k of [
  'UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL', 'REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_TOKEN', 'REDIS_REST_TOKEN',
]) delete process.env[k];

const { default: handler } = await import('./health.js');

function makePreflight(origin) {
  return new Request('https://api.worldmonitor.app/api/health?compact=1', {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'GET',
    },
  });
}

test('health preflight is compatible with credentialed browser fetches', async () => {
  const resp = await handler(makePreflight('https://www.worldmonitor.app'));

  assert.equal(resp.status, 204);
  assert.equal(resp.headers.get('access-control-allow-origin'), 'https://www.worldmonitor.app');
  assert.equal(resp.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(resp.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.equal(resp.headers.get('vary'), 'Origin');
});

test('health GET response is compatible with credentialed browser fetches', async () => {
  const resp = await handler(new Request('https://api.worldmonitor.app/api/health?compact=1', {
    method: 'GET',
    headers: {
      origin: 'https://www.worldmonitor.app',
    },
  }));

  // Redis credentials are cleared at module load (see top of file), so the
  // handler deterministically short-circuits to REDIS_DOWN → HTTP 503 (the one
  // hard-down state with a non-200 code — see api/health.js). The point of this
  // test is that the CORS headers a credentialed browser fetch needs are present
  // on the outage path too, not just the healthy 200 path.
  assert.equal(resp.status, 503);
  const body = await resp.json();
  assert.equal(body.status, 'REDIS_DOWN');
  assert.equal(resp.headers.get('access-control-allow-origin'), 'https://www.worldmonitor.app');
  assert.equal(resp.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(resp.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.equal(resp.headers.get('vary'), 'Origin');
});
