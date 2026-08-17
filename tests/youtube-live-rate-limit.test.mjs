// Rate-limit coverage for api/youtube/live.js (#6234).
//
// The route proxies youtube.com from our egress IPs and, before this suite,
// had no meter at all: `isDisallowedOrigin` is a CORS check and does nothing
// against a non-browser caller. A single request can fan out to the Railway
// relay AND a full live-page HTML scrape, so the assertion with teeth here is
// not the 429 status but that a limited request never reaches youtube.com.

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLimiterBudget } from './helpers/upstash-limiter-wire.mjs';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

// Delete before import so the handler cannot memoize a limiter against a
// half-configured environment; each test opts in explicitly.
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.WS_RELAY_URL;

const { default: handler } = await import('../api/youtube/live.js');
const { __resetRateLimitForTest } = await import('../api/_rate-limit.js');

const ENDPOINT = 'https://api.worldmonitor.app/api/youtube/live';

let ipCounter = 0;
/** Distinct caller per test — the limiter memoizes per scope, so a shared IP
 *  would let one test's verdict leak into the next. */
function uniqueCallerIp() {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

function makeRequest(query, ip) {
  return new Request(`${ENDPOINT}?${query}`, {
    headers: { Origin: 'https://worldmonitor.app', 'x-real-ip': ip },
  });
}

/** Records every fetch the handler makes. `respond` decides the reply. */
function spyFetch(respond) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return respond(String(input), init, calls);
  };
  return calls;
}

const youtubeCalls = (calls) => calls.filter((c) => c.url.includes('youtube.com'));

function upstashReply(remaining, limit) {
  return new Response(JSON.stringify([{ result: [remaining, limit] }]), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  __resetRateLimitForTest();
});

test('returns 429 and never reaches youtube.com when the rate limit is exhausted', async () => {
  // Upstash sliding-window EVAL reply shape: [remaining, limit], wrapped in the
  // auto-pipelining envelope. A negative remaining means blocked; 30 is the
  // ENDPOINT_RATE_POLICIES['/api/youtube/live'] budget this handler mirrors.
  const calls = spyFetch(() => upstashReply(-1, 30));

  const res = await handler(makeRequest('videoId=dQw4w9WgXcQ', uniqueCallerIp()));

  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'Too many requests');
  assert.equal(res.headers.get('X-RateLimit-Limit'), '30');
  assert.equal(res.headers.get('X-RateLimit-Remaining'), '0');
  assert.match(res.headers.get('Retry-After') ?? '', /^\d+$/);
  // The headers above echo the mocked reply, so they cannot tell 30 from 5000.
  // Assert what the handler SENT — the only place the configured budget is
  // observable in a mocked run. (#6412 review)
  assertLimiterBudget(assert, calls, { limit: 30, windowSeconds: 60, scope: 'youtube-live' });
  // Without CORS on the 429 the browser client sees an opaque network error
  // instead of a readable rate-limit response.
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://worldmonitor.app');
  assert.deepEqual(
    youtubeCalls(calls).map((c) => c.url),
    [],
    'rate-limited request must not reach youtube.com',
  );
});

test('meters malformed requests too, so a bad parameter is not a free path', async () => {
  // The limit sits before the parameter check on purpose: otherwise a caller
  // could drive unlimited edge invocations by omitting `channel`/`videoId`.
  const calls = spyFetch(() => upstashReply(-1, 30));

  const res = await handler(makeRequest('', uniqueCallerIp()));

  assert.equal(res.status, 429, 'missing-parameter request must be metered, not answered with 400');
  assert.deepEqual(youtubeCalls(calls).map((c) => c.url), []);
});

test('allows the request through when the limiter reports headroom', async () => {
  // Positive control: proves the 429 above comes from the limiter verdict and
  // not merely from Upstash being configured at all.
  const calls = spyFetch((url) => (
    url.includes('fake-upstash')
      ? upstashReply(29, 30)
      : new Response(JSON.stringify({ author_name: 'Test Channel', title: 'Live' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
  ));

  // A malformed Upstash reply also yields a pass — checkRateLimit catches the
  // parse error and fail-opens — so status alone cannot distinguish "granted
  // headroom" from "threw and failed open". Capture the degraded log too.
  const errorLogs = [];
  const originalConsoleError = console.error;
  console.error = (...args) => { errorLogs.push(args.join(' ')); };
  let res;
  try {
    res = await handler(makeRequest('videoId=dQw4w9WgXcQ', uniqueCallerIp()));
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(res.status, 200);
  assert.equal((await res.json()).channelName, 'Test Channel');
  assert.ok(
    youtubeCalls(calls).some((c) => c.url.includes('/oembed')),
    'a request with headroom must reach the oembed fallback',
  );
  assert.ok(
    !errorLogs.some((l) => l.includes('[rate-limit] redis-error')),
    `limiter degraded (fail-open) instead of granting headroom: ${errorLogs.join(' | ')}`,
  );
});

test('stays available when Upstash is unconfigured', async () => {
  // Availability-first posture: this is a read proxy for the live-stream panel,
  // so a missing/blipping Redis must degrade to today's behaviour rather than
  // blanking the panel. Documented in the ENDPOINT_RATE_POLICIES comment.
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;

  const calls = spyFetch(() => new Response(
    JSON.stringify({ author_name: 'Test Channel', title: 'Live' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ));

  // 200 + one upstream call is satisfied by BOTH the intended path (no limiter
  // constructed) and the unintended one (a memoized limiter throws and the
  // handler fails open), so capture the degraded marker to tell them apart —
  // the same probe the positive control above uses. (#6412 review)
  const errorLogs = [];
  const originalConsoleError = console.error;
  console.error = (...args) => { errorLogs.push(args.join(' ')); };
  let res;
  try {
    res = await handler(makeRequest('videoId=dQw4w9WgXcQ', uniqueCallerIp()));
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(res.status, 200);
  assert.ok(youtubeCalls(calls).some((c) => c.url.includes('/oembed')));
  assert.ok(
    !errorLogs.some((l) => l.includes('[rate-limit] redis-error')),
    `unconfigured Upstash must skip the limiter entirely, not construct one and fail open: ${errorLogs.join(' | ')}`,
  );
});
