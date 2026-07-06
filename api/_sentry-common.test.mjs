import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
});

test('custom API Sentry transport is disabled under node:test even with a DSN', async (t) => {
  if (!process.env.NODE_TEST_CONTEXT) {
    t.skip('NODE_TEST_CONTEXT is not set by this test runner mode');
    return;
  }

  process.env.VITE_SENTRY_DSN = 'https://public@example.ingest.sentry.io/12345';

  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(null, { status: 200 });
  };

  const { makeCaptureSilentError } = await import(`./_sentry-common.js?test=${Date.now()}-${Math.random()}`);
  const captureSilentError = makeCaptureSilentError({
    runtime: 'edge',
    platform: 'javascript',
    logPrefix: '[sentry-test]',
  });

  await captureSilentError(new Error('test-only failure'));

  assert.equal(fetchCalls, 0);
});

test('custom API Sentry transport can be exercised by clearing NODE_TEST_CONTEXT', async () => {
  delete process.env.NODE_TEST_CONTEXT;
  process.env.VITE_SENTRY_DSN = 'https://public@example.ingest.sentry.io/12345';

  const fetchCalls = [];
  globalThis.fetch = async (input, init) => {
    fetchCalls.push({ input, init });
    return new Response(null, { status: 200 });
  };

  const { makeCaptureSilentError } = await import(`./_sentry-common.js?test=${Date.now()}-${Math.random()}`);
  const captureSilentError = makeCaptureSilentError({
    runtime: 'edge',
    platform: 'javascript',
    logPrefix: '[sentry-test]',
  });

  await captureSilentError(new Error('test-only failure'));

  assert.equal(fetchCalls.length, 1);
  const [{ input, init }] = fetchCalls;
  assert.equal(String(input), 'https://example.ingest.sentry.io/api/12345/envelope/');
  assert.equal(init?.headers?.['X-Sentry-Auth'], 'Sentry sentry_version=7, sentry_key=public');
});
