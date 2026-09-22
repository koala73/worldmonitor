import assert from 'node:assert/strict';
import { test } from 'node:test';

test('notification GET and POST relay failures deliver distinct Sentry fingerprints', async () => {
  const originalEnv = {
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
    VITE_SENTRY_DSN: process.env.VITE_SENTRY_DSN,
    CONVEX_SITE_URL: process.env.CONVEX_SITE_URL,
    CONVEX_TENANT_RELAY_SECRET: process.env.CONVEX_TENANT_RELAY_SECRET,
  };
  const originalFetch = globalThis.fetch;
  const envelopes = [];
  const waits = [];
  let notification;

  delete process.env.NODE_TEST_CONTEXT;
  process.env.VITE_SENTRY_DSN = 'https://public@example.ingest.sentry.io/12345';
  process.env.CONVEX_SITE_URL = 'https://example.convex.site';
  process.env.CONVEX_TENANT_RELAY_SECRET = 'test-secret';
  globalThis.fetch = async (input, init) => {
    envelopes.push({ input, init });
    return new Response(null, { status: 200 });
  };

  try {
    notification = await import('../api/notification-channels.ts');
    const relayFailure = new Error('relay requestId=dynamic-123');
    notification.__setNotificationChannelsDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: 'user-123' }),
      getEntitlements: async () => ({ features: { tier: 1 } }),
      fetch: async () => { throw relayFailure; },
    });

    const requestInit = { headers: { Authorization: 'Bearer test-token' } };
    const getContext = { waitUntil: (promise) => waits.push(promise) };
    const getResponse = await notification.default(
      new Request('https://example.test/api/notification-channels', { method: 'GET', ...requestInit }),
      getContext,
    );
    assert.equal(getResponse.status, 500);

    const postContext = { waitUntil: (promise) => waits.push(promise) };
    const postResponse = await notification.default(
      new Request('https://example.test/api/notification-channels', {
        method: 'POST',
        ...requestInit,
        headers: { ...requestInit.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create-pairing-token' }),
      }),
      postContext,
    );
    assert.equal(postResponse.status, 500);
    await Promise.all(waits);

    assert.equal(envelopes.length, 2, 'GET and POST catches must each deliver one envelope');
    const events = envelopes.map(({ init }) => JSON.parse(String(init.body).split('\n')[2]));
    assert.deepEqual(events.map((event) => event.fingerprint), [
      ['api/notification-channels', 'GET', 'Error'],
      ['api/notification-channels', 'POST', 'Error'],
    ]);
    assert.notDeepEqual(events[0].fingerprint, events[1].fingerprint);
  } finally {
    notification?.__setNotificationChannelsDepsForTests?.(null);
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
