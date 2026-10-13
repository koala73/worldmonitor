/**
 * Envelope-level coverage for intel-history AbortSignal.timeout captures.
 *
 * Sentry WORLDMONITOR-187: Convex read TimeoutError was captured at default
 * error level while the handler fails open as upstreamUnavailable. Same gate
 * as api/miit-news and api/notification-channels.
 *
 * Clears NODE_TEST_CONTEXT so api/_sentry-common.js actually builds envelopes;
 * stubs fetch to the fake Convex site and the fake Sentry ingest URL.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

test('intel-history Convex read TimeoutError / AbortError captures are downgraded to warning', async (t) => {
  const originalEnv = {
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
    VITE_SENTRY_DSN: process.env.VITE_SENTRY_DSN,
    CONVEX_SITE_URL: process.env.CONVEX_SITE_URL,
    CONVEX_SERVER_SHARED_SECRET: process.env.CONVEX_SERVER_SHARED_SECRET,
  };
  const originalFetch = globalThis.fetch;
  const envelopes = [];

  delete process.env.NODE_TEST_CONTEXT;
  process.env.VITE_SENTRY_DSN = 'https://public@example.ingest.sentry.io/12345';
  process.env.CONVEX_SITE_URL = 'https://fake-convex.convex.site';
  // Synthetic fixture only — not a live credential.
  process.env.CONVEX_SERVER_SHARED_SECRET = 'test-shared-secret'; // pragma: allowlist secret

  // Bust the module graph so _sentry-common.js re-parses the DSN after we
  // cleared NODE_TEST_CONTEXT (its IIFE runs once per module identity).
  const bust = Date.now();
  const { intelHistoryTimeline } = await import(
    `../server/_shared/intel-history-client.ts?sentry=${bust}`
  );

  try {
    for (const errorName of ['TimeoutError', 'AbortError']) {
      await t.test(`convex-read ${errorName}`, async () => {
        envelopes.length = 0;
        globalThis.fetch = async (input, init) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (url.includes('example.ingest.sentry.io')) {
            envelopes.push({ init });
            return new Response(null, { status: 200 });
          }
          if (url.includes('/api/internal-intel-timeline')) {
            throw new DOMException('The operation was aborted due to timeout', errorName);
          }
          throw new Error(`unstubbed fetch: ${url}`);
        };

        const result = await intelHistoryTimeline({
          domain: 'conflict',
          limit: 10,
        });
        assert.equal(result, null);

        assert.equal(envelopes.length, 1, 'timeout must deliver one Sentry envelope');
        const event = JSON.parse(String(envelopes[0].init.body).split('\n')[2]);
        assert.equal(event.level, 'warning');
        assert.equal(event.tags.component, 'intel-history');
        assert.equal(event.tags.stage, 'convex-read');
        assert.deepEqual(event.fingerprint, [
          'intel-history',
          'convex-read-error',
          '/api/internal-intel-timeline',
        ]);
      });
    }

    await t.test('non-timeout Convex throw stays at error', async () => {
      envelopes.length = 0;
      globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('example.ingest.sentry.io')) {
          envelopes.push({ init });
          return new Response(null, { status: 200 });
        }
        if (url.includes('/api/internal-intel-timeline')) {
          throw new TypeError('unexpected parse failure');
        }
        throw new Error(`unstubbed fetch: ${url}`);
      };

      const result = await intelHistoryTimeline({
        domain: 'conflict',
        limit: 10,
      });
      assert.equal(result, null);

      assert.equal(envelopes.length, 1);
      const event = JSON.parse(String(envelopes[0].init.body).split('\n')[2]);
      assert.equal(event.level, 'error');
      assert.equal(event.tags.stage, 'convex-read');
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
