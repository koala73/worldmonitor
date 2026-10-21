/**
 * Proves api/rss-proxy.js reports the RIGHT fetch/relay failures to Sentry.
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
 * for its sibling case (#7438). The outer `step: 'fetch'` catch does change
 * the HTTP status, but those response mappings already live in
 * api/rss-proxy.test.mjs; this file owns the Sentry envelope so a deleted
 * `level: relayFailureLevel(...)` cannot stay green.
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
// Same host shape as api/rss-proxy.test.mjs; Origin/CORS checks need a real URL.
const PROXY_ENDPOINT = 'https://api.worldmonitor.app/api/rss-proxy'; // pragma: allowlist secret

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
    `${PROXY_ENDPOINT}?url=${encodeURIComponent(FEED_URL)}`,
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

/** Envelope wire format: header line, item header line, item payload line. */
function parseEnvelope(body) {
  const lines = body.split('\n');
  assert.equal(JSON.parse(lines[1]).type, 'event', 'envelope item must be an event');
  return JSON.parse(lines[2]);
}

test('a non-timeout relay-retry failure is still reported to Sentry at error', async () => {
  // Positive control. Without this, deleting the capture outright would leave
  // the AbortError test above green while silencing a real relay regression.
  // ECONNREFUSED is a defect (never established) — must stay at error, not
  // get pulled into the Network-connection-lost warning bucket.
  const { res, envelopes } = await runRelayRetryFailure(new Error('relay ECONNREFUSED'));

  assert.equal(envelopes.length, 1, 'a real relay failure must still be captured');
  assert.match(envelopes[0], /"step":"relay-retry"/);
  assert.match(envelopes[0], /relay ECONNREFUSED/);
  assert.equal(parseEnvelope(envelopes[0]).level, 'error');
  assert.equal(res.status, 500);
});

test('a Network connection lost relay-retry is reported at warning (WORLDMONITOR-17M)', async () => {
  // Same shape as telegram-feed's R1 canary: established-then-dropped edge
  // transport churn. Still queryable; must not page at error.
  const { res, envelopes } = await runRelayRetryFailure(new Error('Network connection lost.'));

  assert.equal(envelopes.length, 1, 'dropped-connection canary must still reach Sentry');
  const event = parseEnvelope(envelopes[0]);
  assert.equal(event.level, 'warning');
  assert.equal(event.tags?.step, 'relay-retry');
  assert.match(envelopes[0], /Network connection lost/);
  assert.equal(res.status, 500);
});

/**
 * Drive the outer `step: 'fetch'` catch: no relay configured, so a throwing
 * direct fetch rethrows into the handler's top-level catch.
 *
 * @param {Error} directError thrown by the direct fetch
 * @returns {Promise<{ res: Response, envelopes: string[] }>}
 */
async function runOuterFetchFailure(directError) {
  const envelopes = [];
  delete process.env.WS_RELAY_URL;

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith(ENVELOPE_URL)) {
      envelopes.push(String(init.body ?? ''));
      return new Response('', { status: 200 });
    }
    throw directError;
  };

  const res = await handler(new Request(
    `${PROXY_ENDPOINT}?url=${encodeURIComponent(FEED_URL)}`,
    { headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': TEST_KEY } },
  ));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { res, envelopes };
}

test('an outer-catch AbortError is not reported to Sentry', async () => {
  // Same gate as the relay-retry AbortError arm: timeouts stay out of Sentry
  // entirely (`if (!isTimeout)`), not merely downgraded.
  const abort = new Error('The operation was aborted');
  abort.name = 'AbortError';

  const { res, envelopes } = await runOuterFetchFailure(abort);

  assert.deepEqual(envelopes, [], 'AbortError on the outer fetch catch must not reach Sentry');
  assert.equal(res.status, 504);
});

test('an outer-catch ECONNREFUSED is reported to Sentry at error', async () => {
  // Positive control for the outer catch's relayFailureLevel wiring. Without
  // this, deleting `level: relayFailureLevel(error)` on step:fetch would leave
  // the AbortError and Network-connection-lost outer tests green while
  // restoring default error for refuse — or, worse, a silent no-op capture.
  const { res, envelopes } = await runOuterFetchFailure(new Error('connect ECONNREFUSED'));

  assert.equal(envelopes.length, 1, 'a refused outer-fetch failure must still be captured');
  const event = parseEnvelope(envelopes[0]);
  assert.equal(event.level, 'error');
  assert.equal(event.tags?.step, 'fetch');
  assert.match(envelopes[0], /ECONNREFUSED/);
  assert.equal(res.status, 502);
});

test('an outer-catch Network connection lost is reported at warning (WORLDMONITOR-17M)', async () => {
  // The PR wires relayFailureLevel onto both capture sites. relay-retry alone
  // would leave step:fetch paging on the same edge drop shape.
  const { res, envelopes } = await runOuterFetchFailure(new Error('Network connection lost.'));

  assert.equal(envelopes.length, 1, 'dropped-connection outer catch must still reach Sentry');
  const event = parseEnvelope(envelopes[0]);
  assert.equal(event.level, 'warning');
  assert.equal(event.tags?.step, 'fetch');
  assert.match(envelopes[0], /Network connection lost/);
  assert.equal(res.status, 502);
});
