import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { Ratelimit } from '@upstash/ratelimit';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

// Enable only this worker's Sentry transport, with a synthetic DSN and stubbed IO.
// Sentry captures configuration at import; normal node:test imports disable it.
delete process.env.NODE_TEST_CONTEXT;
process.env.VITE_SENTRY_DSN = 'https://public@example.ingest.sentry.io/12345';
await import('../api/_sentry-edge.js');
Object.assign(process.env, originalEnv);
const { default: handler } = await import('../api/x-feed.js');
const { issueSessionToken } = await import('../api/_session.js');
const { __resetRateLimitForTest } = await import('../api/_rate-limit.js');

afterEach(() => {
  mock.restoreAll();
  __resetRateLimitForTest();
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

for (const failure of ['missing-config', 'redis-error', 'timeout']) {
  test(`x-feed retains ${failure} telemetry after its 503 response`, async () => {
    process.env.WM_SESSION_SECRET = 'x'.repeat(48);
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    if (failure === 'missing-config') delete process.env.UPSTASH_REDIS_REST_URL;
    mock.method(Ratelimit, 'slidingWindow', () => () => ({
      limit: async () => {
        if (failure === 'timeout') return { success: true, reason: 'timeout', pending: Promise.resolve() };
        throw new Error('Redis unavailable');
      },
    }));
    const delivery = Promise.withResolvers();
    const requests = [];
    globalThis.fetch = async (url) => {
      requests.push(String(url));
      await delivery.promise;
      return new Response(null, { status: 200 });
    };
    const pending = [];
    const { token } = await issueSessionToken();
    try {
      const response = await handler(new Request('https://worldmonitor.app/api/x-feed', {
        headers: { origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': token },
      }), { waitUntil: (promise) => pending.push(promise) });
      assert.equal(response.status, 503);
      assert.equal(pending.length, 1);
      assert.deepEqual(requests, ['https://example.ingest.sentry.io/api/12345/envelope/']);
    } finally {
      delivery.resolve();
      await Promise.all(pending);
    }
  });
}
