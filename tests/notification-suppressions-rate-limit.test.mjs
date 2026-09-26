// Per-IP rate limit on the anonymous link-suppression endpoint
// (api/notification-suppressions.js, #8401 / #8416 follow-up).
//
// The endpoint is unauthenticated and every CDN miss is an Upstash SMEMBERS.
// It refuses query strings, but a caller can still miss the shared cache
// (varying headers, hitting fresh PoPs), so origin invocations need a budget.
// The limiter must fail OPEN: a limiter outage must not change what the
// service worker sees, because the endpoint's contract is that suppression
// reads never strand a notification click.

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLimiterBudget, readLimiterRequest } from './helpers/upstash-limiter-wire.mjs';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const originalError = console.error;

const { default: handler } = await import('../api/notification-suppressions.js');
const { __resetRateLimitForTest } = await import('../api/_rate-limit.js');

const ENDPOINT = 'https://worldmonitor.app/api/notification-suppressions';

let ipCounter = 0;
function uniqueCallerIp() {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

function makeRequest(ip, path = ENDPOINT) {
  return new Request(path, { headers: { 'x-real-ip': ip } });
}

function makeCtx() {
  return { waitUntil: () => {} };
}

function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const isSmembers = (url) => url.includes('/SMEMBERS/');

function spyFetch(respond) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return respond(String(input), init);
  };
  return calls;
}

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalError;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  __resetRateLimitForTest();
});

test('over the per-IP budget returns an uncacheable 429 and never reads the suppression set', async () => {
  // [remaining, limit] sliding-window EVAL reply: budget exhausted.
  const calls = spyFetch((url) => (isSmembers(url) ? json({ result: [] }) : json([{ result: [-1, 60] }])));

  const res = await handler(makeRequest(uniqueCallerIp()), makeCtx());

  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'Too many requests');
  assert.match(res.headers.get('Retry-After') ?? '', /^\d+$/);
  // A shared-cache 429 would be served to every service worker, turning one
  // caller's exhausted budget into a global suppression bypass.
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assertLimiterBudget(assert, calls, { limit: 60, windowSeconds: 60, scope: 'notification-suppressions' });
  assert.deepEqual(calls.filter((c) => isSmembers(c.url)), [], 'a limited request must not reach Redis SMEMBERS');
});

test('under the budget the snapshot is served with the 60s shared cache', async () => {
  const errors = [];
  console.error = (...args) => errors.push(args.join(' '));
  const calls = spyFetch((url) => (isSmembers(url) ? json({ result: ['host:evil.example'] }) : json([{ result: [59, 60] }])));

  const res = await handler(makeRequest(uniqueCallerIp()), makeCtx());

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.hosts, ['evil.example']);
  assert.equal(body.unavailable, undefined);
  assert.match(res.headers.get('Cache-Control') ?? '', /s-maxage=60/);
  assertLimiterBudget(assert, calls, { limit: 60, windowSeconds: 60, scope: 'notification-suppressions' });
  // A malformed limiter reply also passes (fail-open); prove this one was a real allow.
  assert.deepEqual(errors.filter((line) => line.includes('[rate-limit]')), []);
});

test('keeps limiter buckets isolated by caller IP', async () => {
  // assertLimiterBudget only reads the first limiter command and its scope
  // prefix. A handler that stored every caller under one Redis key would
  // still pass that check, so this test spends one IP's bucket and requires
  // a second IP to keep its own.
  const bucketHits = new Map();
  const calls = spyFetch((url, init) => {
    if (isSmembers(url)) return json({ result: ['host:evil.example'] });
    const keys = readLimiterRequest([{ init }])?.keys;
    if (!keys?.length) return json([{ result: [59, 60] }]);
    const bucket = keys.join('\0');
    const hit = (bucketHits.get(bucket) ?? 0) + 1;
    bucketHits.set(bucket, hit);
    const remaining = hit === 1 ? 59 : -1;
    return json([{ result: [remaining, 60] }]);
  });

  const first = await handler(makeRequest('198.51.100.10'), makeCtx());
  const exhausted = await handler(makeRequest('198.51.100.10'), makeCtx());
  const isolated = await handler(makeRequest('198.51.100.11'), makeCtx());

  assert.equal(first.status, 200);
  assert.equal(exhausted.status, 429);
  assert.equal(isolated.status, 200);

  const limiterCalls = calls.filter((call) => readLimiterRequest([call]));
  const keysFor = (index) => readLimiterRequest(limiterCalls.slice(index))?.keys;
  const firstKeys = keysFor(0);
  const secondKeys = keysFor(1);
  const thirdKeys = keysFor(2);
  assert.deepEqual(firstKeys, secondKeys);
  assert.notDeepEqual(secondKeys, thirdKeys);
  assert.ok(firstKeys?.some((key) => key.includes('198.51.100.10')));
  assert.ok(thirdKeys?.some((key) => key.includes('198.51.100.11')));
});

test('a limiter outage fails open: the suppression snapshot is still served', async () => {
  const errors = [];
  console.error = (...args) => errors.push(args.join(' '));
  const calls = spyFetch((url) => {
    if (isSmembers(url)) return json({ result: ['host:evil.example'] });
    throw new TypeError('fetch failed');
  });

  const res = await handler(makeRequest(uniqueCallerIp()), makeCtx());

  assert.equal(res.status, 200, 'a limiter outage must not break notification clicks');
  const body = await res.json();
  assert.deepEqual(body.hosts, ['evil.example'], 'the real snapshot, not the unavailable shape');
  assert.equal(body.unavailable, undefined);
  assert.ok(calls.some((c) => isSmembers(c.url)));
  assert.ok(errors.some((line) => line.includes('[rate-limit] redis-error')), 'the degraded limiter is logged');
});

test('a query-string refusal is answered before the limiter, so it spends no Redis call', async () => {
  const calls = spyFetch(() => json([{ result: [-1, 60] }]));

  const res = await handler(makeRequest(uniqueCallerIp(), `${ENDPOINT}?bust=1`), makeCtx());

  assert.equal(res.status, 400);
  assert.deepEqual(calls, []);
});
