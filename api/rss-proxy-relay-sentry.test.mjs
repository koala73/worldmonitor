/**
 * Proves api/rss-proxy.js reports the RIGHT relay-retry failures to Sentry.
 *
 * Lives in its own file, not api/rss-proxy.test.mjs, because the seam is the
 * envelope fetch: `_sentry-common.js` parses the DSN ONCE at module load and
 * short-circuits under `NODE_TEST_CONTEXT`, so making `captureSilentError`
 * observable means owning the environment before the first import of the
 * chain. Doing that inside the main suite would add an envelope POST to the
 * `calls` array every other test counts.
 *
 * Why the envelope and not the status code: the relay-retry error is
 * SWALLOWED — the handler falls through to the original non-ok direct
 * response either way — so the response is byte-identical whether or not the
 * capture fires. A status assertion here would be a test that cannot fail,
 * which is exactly the limit tests/telegram-feed-contract.test.mjs documents
 * for its sibling case (#7438).
 */

// MUST precede the rss-proxy import: `parseDsn()` in api/_sentry-common.js is
// a load-time IIFE. 127.0.0.1 keeps a misconfigured run off the real ingest
// host; the fetch spy below intercepts the request before it leaves anyway.
delete process.env.NODE_TEST_CONTEXT;
process.env.VITE_SENTRY_DSN = 'https://testkey@127.0.0.1/4242';

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const TEST_KEY = 'rss-proxy-relay-sentry-key';
const ENVELOPE_URL = 'https://127.0.0.1/api/4242/envelope/';
const FEED_URL = 'https://techcrunch.com/feed';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

process.env.WORLDMONITOR_VALID_KEYS = TEST_KEY;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const { default: handler } = await import('./rss-proxy.js');
const { __resetRateLimitForTest } = await import('./_rate-limit.js');

beforeEach(() => {
  process.env.WORLDMONITOR_VALID_KEYS = TEST_KEY;
  process.env.WS_RELAY_URL = 'wss://relay.example.com';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  __resetRateLimitForTest();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

/**
 * Drive the relay-retry branch: the direct fetch answers non-ok, so the
 * handler retries via Railway, and that retry throws `relayError`.
 *
 * @param {unknown} relayError thrown by the relay leg
 * @returns {Promise<{ res: Response, envelopes: string[] }>} envelope request
 *   bodies captured by the fetch spy, in order.
 */
async function runRelayRetryFailure(relayError) {
  const envelopes = [];
  let upstreamCalls = 0;

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith(ENVELOPE_URL)) {
      envelopes.push(String(init.body ?? ''));
      return new Response('', { status: 200 });
    }
    upstreamCalls += 1;
    // First upstream hit is the direct fetch; second is the Railway relay retry.
    if (upstreamCalls === 1) return new Response('upstream boom', { status: 500 });
    throw relayError;
  };

  const res = await handler(new Request(
    `https://api.worldmonitor.app/api/rss-proxy?url=${encodeURIComponent(FEED_URL)}`,
    { headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': TEST_KEY } },
  ));
  // The capture is fire-and-forget; give its microtask chain a turn to run so
  // a missing assertion is a real absence, not a race we sampled too early.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { res, envelopes };
}

test('a relay-retry AbortError is not reported to Sentry (WORLDMONITOR-11G)', async () => {
  // fetchViaRailway aborts on the feed timeout budget. That AbortError is
  // routine upstream latency on a best-effort SECOND attempt whose failure the
  // caller never sees — the same judgement the outer catch already makes for
  // `step: 'fetch'` and #7438 made for api/telegram-feed.js.
  const abort = new Error('The operation was aborted');
  abort.name = 'AbortError';

  const { res, envelopes } = await runRelayRetryFailure(abort);

  assert.deepEqual(envelopes, [], 'AbortError on the relay retry must not reach Sentry');
  // The swallowed retry still leaves the original direct response intact.
  assert.equal(res.status, 500);
});

test('a non-timeout relay-retry failure is still reported to Sentry', async () => {
  // Positive control. Without this, deleting the capture outright would leave
  // the AbortError test above green while silencing a real relay regression.
  const { res, envelopes } = await runRelayRetryFailure(new Error('relay ECONNREFUSED'));

  assert.equal(envelopes.length, 1, 'a real relay failure must still be captured');
  assert.match(envelopes[0], /"step":"relay-retry"/);
  assert.match(envelopes[0], /relay ECONNREFUSED/);
  assert.equal(res.status, 500);
});
