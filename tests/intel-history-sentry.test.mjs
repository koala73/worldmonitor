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
          if (new URL(url).hostname === 'example.ingest.sentry.io') {
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
        if (new URL(url).hostname === 'example.ingest.sentry.io') {
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

// The embeddings gate was pinned only by a source-regex test, which proves the
// strings exist but not that the level reaches the envelope (Greptile on
// #9127). Drive embedQueryText through the same stubbed delivery path.
test('intel-history embeddings TimeoutError / AbortError captures are downgraded to warning', async (t) => {
  const originalEnv = {
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
    VITE_SENTRY_DSN: process.env.VITE_SENTRY_DSN,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  };
  const originalFetch = globalThis.fetch;
  const envelopes = [];

  delete process.env.NODE_TEST_CONTEXT;
  // No Redis: the embed cache reads miss locally and never reach fetch.
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.VITE_SENTRY_DSN = 'https://public@example.ingest.sentry.io/12345';
  // Synthetic fixture only — not a live credential.
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key'; // pragma: allowlist secret

  const { OPENROUTER_EMBEDDINGS_URL } = await import('../scripts/lib/brief-dedup-consts.mjs');
  const providerHost = new URL(OPENROUTER_EMBEDDINGS_URL).hostname;
  const bust = Date.now();
  const { embedQueryText } = await import(
    `../server/_shared/intel-history-embed.ts?sentry=${bust}`
  );

  const stubFetch = (providerFailure) => async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const hostname = new URL(url).hostname;
    if (hostname === 'example.ingest.sentry.io') {
      envelopes.push({ init });
      return new Response(null, { status: 200 });
    }
    if (hostname === providerHost) throw providerFailure();
    throw new Error(`unstubbed fetch: ${url}`);
  };

  try {
    for (const errorName of ['TimeoutError', 'AbortError']) {
      await t.test(`embed ${errorName}`, async () => {
        envelopes.length = 0;
        globalThis.fetch = stubFetch(
          () => new DOMException('The operation was aborted due to timeout', errorName),
        );

        const result = await embedQueryText(`embed probe ${errorName}`);
        assert.equal(result, null);

        assert.equal(envelopes.length, 1, 'timeout must deliver one Sentry envelope');
        const event = JSON.parse(String(envelopes[0].init.body).split('\n')[2]);
        assert.equal(event.level, 'warning');
        assert.equal(event.tags.component, 'intel-history');
        assert.equal(event.tags.stage, 'embed');
        assert.deepEqual(event.fingerprint, ['intel-history', 'embed-error']);
      });
    }

    await t.test('non-timeout embeddings throw stays at error', async () => {
      envelopes.length = 0;
      globalThis.fetch = stubFetch(() => new TypeError('fetch failed'));

      const result = await embedQueryText('embed probe TypeError');
      assert.equal(result, null);

      assert.equal(envelopes.length, 1);
      const event = JSON.parse(String(envelopes[0].init.body).split('\n')[2]);
      assert.equal(event.level, 'error');
      assert.equal(event.tags.stage, 'embed');
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
