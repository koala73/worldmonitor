// Rate-limit coverage for api/reverse-geocode.js (#6234).
//
// The route reaches Nominatim, whose usage policy is the strictest in our
// stack and whose enforcement is an egress-IP ban. It is Upstash-cached on a
// 0.1-degree grid, but the cache write is conditional on a resolved country
// (api/reverse-geocode.js), so ocean and Antarctic coordinates never populate
// it — a scripted sweep of those cells was 100% passthrough with no meter.

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLimiterBudget } from './helpers/upstash-limiter-wire.mjs';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const { default: handler } = await import('../api/reverse-geocode.js');
const { __resetRateLimitForTest } = await import('../api/_rate-limit.js');

const ENDPOINT = 'https://api.worldmonitor.app/api/reverse-geocode';

let ipCounter = 0;
/** Distinct caller per test — the limiter memoizes per scope. */
function uniqueCallerIp() {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

function makeRequest(query, ip) {
  return new Request(`${ENDPOINT}?${query}`, {
    headers: { Origin: 'https://worldmonitor.app', 'x-real-ip': ip },
  });
}

/** Vercel edge context stub; the handler forwards it to checkRateLimit so the
 *  degraded-path Sentry envelope survives isolate teardown, and uses it for the
 *  fire-and-forget cache write. */
function makeCtx() {
  const waited = [];
  return { ctx: { waitUntil: (p) => { waited.push(p); } }, waited };
}

function spyFetch(respond) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return respond(String(input), init, calls);
  };
  return calls;
}

const nominatimCalls = (calls) => calls.filter((c) => c.url.includes('nominatim'));

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

test('returns 429 and never reaches Nominatim when the rate limit is exhausted', async () => {
  // [remaining, limit] sliding-window EVAL reply; 60 is the
  // ENDPOINT_RATE_POLICIES['/api/reverse-geocode'] budget this handler mirrors.
  const calls = spyFetch(() => upstashReply(-1, 60));
  const { ctx } = makeCtx();

  const res = await handler(makeRequest('lat=40.7&lon=-74.0', uniqueCallerIp()), ctx);

  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'Too many requests');
  assert.equal(res.headers.get('X-RateLimit-Limit'), '60');
  assert.equal(res.headers.get('X-RateLimit-Remaining'), '0');
  assert.match(res.headers.get('Retry-After') ?? '', /^\d+$/);
  // The headers above echo the mocked reply, so they cannot tell 60 from 5000.
  // Assert what the handler SENT. (#6412 review)
  assertLimiterBudget(assert, calls, { limit: 60, windowSeconds: 60, scope: 'reverse-geocode' });
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://worldmonitor.app');
  assert.deepEqual(
    nominatimCalls(calls).map((c) => c.url),
    [],
    'rate-limited request must not reach Nominatim',
  );
});

test('meters invalid coordinates too, so a bad parameter is not a free path', async () => {
  // The limit sits before coordinate validation: otherwise a caller could drive
  // unlimited edge invocations with out-of-range values and never be metered.
  const calls = spyFetch(() => upstashReply(-1, 60));
  const { ctx } = makeCtx();

  const res = await handler(makeRequest('lat=999&lon=999', uniqueCallerIp()), ctx);

  assert.equal(res.status, 429, 'invalid-coordinate request must be metered, not answered with 400');
  assert.deepEqual(nominatimCalls(calls).map((c) => c.url), []);
});

test('allows the request through when the limiter reports headroom', async () => {
  // Positive control. The Upstash base URL serves the limiter EVAL; `/get/` is
  // the cache read, answered as a miss so the request reaches Nominatim.
  const calls = spyFetch((url) => {
    if (url.includes('/get/')) {
      return new Response(JSON.stringify({ result: null }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('fake-upstash')) return upstashReply(59, 60);
    return new Response(JSON.stringify({
      address: { country: 'United States', country_code: 'us' },
      display_name: 'New York, United States',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const { ctx } = makeCtx();

  // A malformed Upstash reply also yields a pass (checkRateLimit fail-opens),
  // so assert the degraded log never fired or this control has no teeth.
  const errorLogs = [];
  const originalConsoleError = console.error;
  console.error = (...args) => { errorLogs.push(args.join(' ')); };
  let res;
  try {
    res = await handler(makeRequest('lat=40.7&lon=-74.0', uniqueCallerIp()), ctx);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(res.status, 200);
  assert.equal((await res.json()).code, 'US');
  assert.equal(nominatimCalls(calls).length, 1, 'a request with headroom must reach Nominatim');
  assert.ok(
    !errorLogs.some((l) => l.includes('[rate-limit] redis-error')),
    `limiter degraded (fail-open) instead of granting headroom: ${errorLogs.join(' | ')}`,
  );
});

test('stays available when Upstash is unconfigured', async () => {
  // Availability-first: the map degrades to an unlabelled country rather than
  // failing, so a missing/blipping Redis must not black-hole the route.
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;

  const calls = spyFetch(() => new Response(JSON.stringify({
    address: { country: 'United States', country_code: 'us' },
    display_name: 'New York, United States',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const { ctx } = makeCtx();

  // 200 + one upstream call is satisfied by BOTH the intended path (no limiter
  // constructed) and the unintended one (a memoized limiter throws and the
  // handler fails open), so capture the degraded marker to tell them apart —
  // the same probe the positive control above uses. (#6412 review)
  const errorLogs = [];
  const originalConsoleError = console.error;
  console.error = (...args) => { errorLogs.push(args.join(' ')); };
  let res;
  try {
    res = await handler(makeRequest('lat=40.7&lon=-74.0', uniqueCallerIp()), ctx);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(res.status, 200);
  assert.equal(nominatimCalls(calls).length, 1);
  assert.ok(
    !errorLogs.some((l) => l.includes('[rate-limit] redis-error')),
    `unconfigured Upstash must skip the limiter entirely, not construct one and fail open: ${errorLogs.join(' | ')}`,
  );
});
