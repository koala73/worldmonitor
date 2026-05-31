import { strict as assert } from 'node:assert';
import test from 'node:test';
import handler from './health.js';

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

  // No Upstash credentials in the test env → the handler short-circuits to
  // REDIS_DOWN, which returns HTTP 503 (the one hard-down state with a non-200
  // code — see api/health.js). The point of this test is that the CORS headers
  // a credentialed browser fetch needs are present on the outage path too, not
  // just the healthy 200 path.
  assert.equal(resp.status, 503);
  const body = await resp.json();
  assert.equal(body.status, 'REDIS_DOWN');
  assert.equal(resp.headers.get('access-control-allow-origin'), 'https://www.worldmonitor.app');
  assert.equal(resp.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(resp.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.equal(resp.headers.get('vary'), 'Origin');
});
