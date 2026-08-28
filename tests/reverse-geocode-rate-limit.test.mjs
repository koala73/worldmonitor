// Rate-limit coverage for api/reverse-geocode.js (#6234).
//
// The route reaches Nominatim, whose usage policy is the strictest in our
// stack and whose enforcement is an egress-IP ban. It shares an Upstash-backed
// 0.001-degree grid with the gateway RPC and caches normalized empty results, so
// repeated ocean and Antarctic lookups do not remain provider passthrough.

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

function readLimiterWire(init = {}) {
  let parsed;
  try { parsed = JSON.parse(String(init.body)); } catch { return null; }
  const command = Array.isArray(parsed?.[0]) ? parsed[0] : parsed;
  if (!Array.isArray(command) || !['eval', 'evalsha'].includes(String(command[0]).toLowerCase())) return null;
  const numKeys = Number(command[2]);
  const rest = command.slice(3);
  return {
    keys: rest.slice(0, numKeys),
    limit: Number(rest[numKeys]),
  };
}

function allowLimiter(init) {
  const wire = readLimiterWire(init);
  assert.ok(wire, 'expected an Upstash limiter command');
  return upstashReply(wire.limit - 1, wire.limit);
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
  const calls = spyFetch((url, init) => {
    if (url.includes('/get/')) {
      return new Response(JSON.stringify({ result: null }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('fake-upstash')) return allowLimiter(init);
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

test('normalizes an RPC-shaped shared cache hit in the same preview namespace', async () => {
  process.env.VERCEL_ENV = 'preview';
  process.env.VERCEL_GIT_COMMIT_SHA = 'deadbeefcafebabe';
  const calls = spyFetch((url) => {
    if (url.includes('/get/')) {
      return new Response(JSON.stringify({
        result: JSON.stringify({
          country: 'United States',
          code: 'US',
          displayName: 'New York, United States',
        }),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('fake-upstash')) return upstashReply(59, 60);
    throw new Error(`unexpected fetch: ${url}`);
  });
  const { ctx } = makeCtx();

  const res = await handler(makeRequest('lat=40.7&lon=-74.0', uniqueCallerIp()), ctx);

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    country: 'United States',
    code: 'US',
    displayName: 'New York, United States',
    error: '',
  });
  assert.equal(nominatimCalls(calls).length, 0, 'a shared cache hit must not reach Nominatim');
  assert.equal(
    calls.some((call) => readLimiterWire(call.init)?.keys.some((key) => key.includes('reverse-geocode:global'))),
    false,
    'a shared cache hit must bypass the provider-wide bucket',
  );
  assert.ok(
    calls.some((call) => call.url === 'https://fake-upstash.example/get/preview%3Adeadbeef%3Ageocode%3A40.700%2C-74.000'),
    'the edge route must read the same deployment-prefixed key as the gateway RPC',
  );
});

test('caches ocean and Antarctic results too — a sweep of empty cells must not be 100% passthrough (#6432)', async () => {
  // #6412 deliberately left the cache write conditional on a resolved country,
  // so ocean/Antarctic cells returned Nominatim's "no place" answer on every
  // request. The parallel gateway RPC writes those cells unconditionally and
  // both share the geocode: namespace, so this route must too. The mutation
  // is one line: no `if (country && code)` around the write.
  const calls = spyFetch((url, init) => {
    if (url.includes('/get/')) {
      // First request is a cache miss; the write is fire-and-forget so no
      // read-back occurs.
      return new Response(JSON.stringify({ result: null }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('fake-upstash')) return allowLimiter(init);
    // Ocean in the middle of the Pacific — Nominatim returns no address.
    return new Response(JSON.stringify({
      display_name: '',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const { ctx, waited } = makeCtx();
  const res = await handler(makeRequest('lat=0&lon=-150', uniqueCallerIp()), ctx);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).country, '');
  assert.equal(nominatimCalls(calls).length, 1);
  // The cache write is fire-and-forget; flush it.
  await Promise.all(waited);
  const writes = calls.filter((c) => c.url.includes('fake-upstash'));
  assert.ok(writes.length > 0, 'an ocean-resolved response must be written to the shared geocode: cache');
  const cacheWrite = writes.map((c) => {
    try { return JSON.parse(String(c.init.body)); } catch { return null; }
  }).find((entries) => Array.isArray(entries)
    && entries.some((entry) => Array.isArray(entry)
      && String(entry[0]).toLowerCase() === 'set'
      && entry[1] === 'geocode:0.000,-150.000'));
  assert.ok(cacheWrite, 'the cache write must target the shared geocode:0.000,-150.000 key');
  const setCommand = cacheWrite.find((entry) => Array.isArray(entry)
    && String(entry[0]).toLowerCase() === 'set');
  assert.deepEqual(setCommand, [
    'SET',
    'geocode:0.000,-150.000',
    JSON.stringify({ country: '', code: '', displayName: '', error: '' }),
    'EX',
    '604800',
  ]);
});

test('does not reuse a 0.1-degree cache cell across a country border (#7279)', async () => {
  // Same US/Canada pair as tests/reverse-geocode-cache-contract.test.mts: both
  // round to geocode:49.0,-97.0 under toFixed(1), but Nominatim at zoom=3
  // returns different countries. The edge route must keep the same key/value
  // contract as the gateway RPC.
  process.env.VERCEL_ENV = 'preview';
  process.env.VERCEL_GIT_COMMIT_SHA = 'deadbeefcafebabe';

  const store = new Map();
  const nominatimUrls = [];
  spyFetch((url, init) => {
    if (url.includes('/get/')) {
      const encoded = url.slice(url.indexOf('/get/') + '/get/'.length);
      const key = decodeURIComponent(encoded);
      const value = store.get(key);
      return new Response(JSON.stringify({ result: value ?? null }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/pipeline')) {
      const commands = JSON.parse(String(init.body));
      const writes = commands.filter((command) => (
        Array.isArray(command) && String(command[0]).toLowerCase() === 'set'
      ));
      if (writes.length > 0) {
        for (const command of writes) store.set(command[1], command[2]);
        return new Response(JSON.stringify(commands.map(() => ({ result: 'OK' }))), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    if (url.includes('fake-upstash')) return allowLimiter(init);
    nominatimUrls.push(url);
    const parsed = new URL(url);
    const lat = Number(parsed.searchParams.get('lat'));
    if (lat >= 49) {
      return new Response(JSON.stringify({
        address: { country: 'Canada', country_code: 'ca' },
        display_name: 'Manitoba, Canada',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      address: { country: 'United States', country_code: 'us' },
      display_name: 'North Dakota, United States',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const first = makeCtx();
  const us = await handler(makeRequest('lat=48.96&lon=-97.04', uniqueCallerIp()), first.ctx);
  await Promise.all(first.waited);
  const second = makeCtx();
  const canada = await handler(makeRequest('lat=49.04&lon=-97.04', uniqueCallerIp()), second.ctx);
  await Promise.all(second.waited);

  assert.equal(us.status, 200);
  assert.deepEqual(await us.json(), {
    country: 'United States',
    code: 'US',
    displayName: 'North Dakota, United States',
    error: '',
  });
  assert.equal(canada.status, 200);
  assert.deepEqual(await canada.json(), {
    country: 'Canada',
    code: 'CA',
    displayName: 'Manitoba, Canada',
    error: '',
  });
  assert.equal(nominatimUrls.length, 2, 'each side of the border must miss independently');
  assert.equal(store.has('preview:deadbeef:geocode:49.0,-97.0'), false);
  assert.equal(store.get('preview:deadbeef:geocode:48.960,-97.040'), JSON.stringify({
    country: 'United States',
    code: 'US',
    displayName: 'North Dakota, United States',
    error: '',
  }));
  assert.equal(store.get('preview:deadbeef:geocode:49.040,-97.040'), JSON.stringify({
    country: 'Canada',
    code: 'CA',
    displayName: 'Manitoba, Canada',
    error: '',
  }));
});

test('fails closed before Nominatim when the provider-wide limiter is unconfigured', async () => {
  // The caller-level budget remains availability-first, but the aggregate
  // Nominatim budget is a provider safety boundary and must fail closed.
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;

  const calls = spyFetch(() => new Response(JSON.stringify({
    address: { country: 'United States', country_code: 'us' },
    display_name: 'New York, United States',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const { ctx } = makeCtx();

  const errorLogs = [];
  const originalConsoleError = console.error;
  console.error = (...args) => { errorLogs.push(args.join(' ')); };
  let res;
  try {
    res = await handler(makeRequest('lat=40.7&lon=-74.0', uniqueCallerIp()), ctx);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(res.status, 503);
  assert.equal(res.headers.get('X-RateLimit-Mode'), 'degraded');
  assert.equal(nominatimCalls(calls).length, 0);
  assert.ok(
    errorLogs.some((l) => l.includes('checkRateLimit:missing-config')),
    `the fail-closed provider limiter must report its degraded decision: ${errorLogs.join(' | ')}`,
  );
});

test('fails closed before Nominatim when provider limiter storage errors', async () => {
  const calls = spyFetch((url, init) => {
    if (url.includes('/get/')) return new Response(JSON.stringify({ result: null }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
    const wire = readLimiterWire(init);
    if (wire?.keys.some((key) => key.includes('reverse-geocode:global'))) {
      throw new Error('Redis unavailable');
    }
    if (url.includes('fake-upstash')) return allowLimiter(init);
    return new Response(JSON.stringify({
      address: { country: 'United States', country_code: 'us' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const { ctx } = makeCtx();
  const originalConsoleError = console.error;
  console.error = () => {};
  let res;
  try {
    res = await handler(makeRequest('lat=40.7&lon=-74.0', uniqueCallerIp()), ctx);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(res.status, 503);
  assert.equal(res.headers.get('X-RateLimit-Mode'), 'degraded');
  assert.equal(nominatimCalls(calls).length, 0);
});
