// Rate-limit and cache coverage for api/skills/fetch-agentskills.ts (#6234).
//
// The route is an anonymous POST that makes our edge fetch arbitrary paths on
// agentskills.io. Its SSRF defences (a fixed three-host allowlist and
// redirect: 'manual') are sound and untouched here; what was missing was any
// meter and any cache, so a scripted caller could drive unlimited outbound
// requests to a host we do not control.

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLimiterBudget } from './helpers/upstash-limiter-wire.mjs';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const { default: handler } = await import('../api/skills/fetch-agentskills.ts');
const { __resetRateLimitForTest } = await import('../server/_shared/rate-limit.ts');

const ENDPOINT = 'https://worldmonitor.app/api/skills/fetch-agentskills';
const SKILL_URL = 'https://agentskills.io/skills/demo';

let ipCounter = 0;
/** Distinct caller per test — checkScopedRateLimit memoizes a limiter per
 *  scope, so a shared IP would let one verdict leak into the next test. */
function uniqueCallerIp() {
  ipCounter += 1;
  return `192.0.2.${ipCounter}`;
}

function makeRequest(body, ip) {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: {
      Origin: 'https://worldmonitor.app',
      'Content-Type': 'application/json',
      'x-real-ip': ip,
    },
    body: JSON.stringify(body),
  });
}

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

// Host-prefixed, not a substring match: the Redis cache key embeds the skill
// host, so the Upstash GET URL also contains "agentskills.io" and a naive
// includes() would count a cache read as an upstream fetch.
const skillCalls = (calls) => calls.filter((c) => c.url.startsWith('https://agentskills.io'));
const cacheReads = (calls) => calls.filter((c) => c.url.includes('/get/'));

function upstashReply(remaining, limit) {
  return new Response(JSON.stringify([{ result: [remaining, limit] }]), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function cacheMiss() {
  return new Response(JSON.stringify({ result: null }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const SKILL_BODY = {
  name: 'Demo Skill',
  description: 'A demo',
  instructions: 'Do the thing.',
};

function skillResponse() {
  return new Response(JSON.stringify(SKILL_BODY), {
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

test('returns 429 and never reaches agentskills.io when the rate limit is exhausted', async () => {
  // Sliding-window EVAL reply [remaining, limit]; 30 is the
  // ENDPOINT_RATE_POLICIES['/api/skills/fetch-agentskills'] budget the handler
  // reads at module load.
  const calls = spyFetch(() => upstashReply(-1, 30));
  const { ctx } = makeCtx();

  const res = await handler(makeRequest({ url: SKILL_URL }, uniqueCallerIp()), ctx);

  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'Too many requests');
  assert.equal(res.headers.get('X-RateLimit-Limit'), '30');
  assert.equal(res.headers.get('X-RateLimit-Remaining'), '0');
  assert.match(res.headers.get('Retry-After') ?? '', /^\d+$/);
  assert.ok(Number(res.headers.get('Retry-After')) >= 1, 'Retry-After must be at least 1s');
  // Shared 429 contract: the IETF RateLimit-* fields are what api/_cors.js
  // exposes cross-origin for agent self-throttling, and every other
  // rate-limited route in the repo emits them. (#6412 review)
  assert.equal(res.headers.get('RateLimit-Limit'), '30');
  assert.equal(res.headers.get('RateLimit-Remaining'), '0');
  assert.match(res.headers.get('RateLimit-Reset') ?? '', /^\d+$/);
  assert.match(res.headers.get('RateLimit-Policy') ?? '', /^"default";q=30;w=60$/);
  assert.match(res.headers.get('RateLimit') ?? '', /^"default";r=0;t=\d+$/);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://worldmonitor.app');
  // The headers above echo the mocked reply, so they cannot tell 30 from 5000.
  // Assert what the handler SENT. (#6412 review)
  assertLimiterBudget(assert, calls, {
    limit: 30,
    windowSeconds: 60,
    scope: 'scope:/api/skills/fetch-agentskills',
  });
  assert.deepEqual(
    skillCalls(calls).map((c) => c.url),
    [],
    'rate-limited request must not reach agentskills.io',
  );
});

test('meters a malformed body too, so an invalid payload is not a free path', async () => {
  // The limit sits before req.json(): otherwise a caller could drive unlimited
  // edge invocations by posting garbage and never be metered.
  const calls = spyFetch(() => upstashReply(-1, 30));
  const { ctx } = makeCtx();

  const req = new Request(ENDPOINT, {
    method: 'POST',
    headers: { Origin: 'https://worldmonitor.app', 'x-real-ip': uniqueCallerIp() },
    body: 'not json',
  });
  const res = await handler(req, ctx);

  assert.equal(res.status, 429, 'malformed body must be metered, not answered with 400');
  assert.deepEqual(skillCalls(calls).map((c) => c.url), []);
});

test('fetches and caches the skill when the limiter reports headroom', async () => {
  // Positive control: proves the 429 above comes from the limiter verdict and
  // not merely from Upstash being configured at all.
  const calls = spyFetch((url) => {
    if (url.includes('/get/')) return cacheMiss();
    if (url.includes('fake-upstash')) return upstashReply(29, 30);
    return skillResponse();
  });
  const { ctx, waited } = makeCtx();

  const errorLogs = [];
  const originalConsoleError = console.error;
  console.error = (...args) => { errorLogs.push(args.join(' ')); };
  let res;
  try {
    res = await handler(makeRequest({ url: SKILL_URL }, uniqueCallerIp()), ctx);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.name, 'Demo Skill');
  assert.equal(payload.instructions, 'Do the thing.');
  assert.equal(payload.truncated, false);
  assert.equal(skillCalls(calls).length, 1, 'a request with headroom must reach agentskills.io');
  assert.ok(
    !errorLogs.some((l) => l.includes('redis-error')),
    `limiter degraded instead of granting headroom: ${errorLogs.join(' | ')}`,
  );

  // Fire-and-forget: the write is handed to ctx.waitUntil rather than awaited,
  // so a slow Redis never delays the import response.
  assert.equal(waited.length, 1, 'the cache fill must be handed to ctx.waitUntil');
  await waited[0];
  const setCall = calls.find((c) => c.init?.body && String(c.init.body).includes('SET'));
  assert.ok(setCall, 'the payload must be written back to Redis');
  assert.match(
    String(setCall.init.body),
    /agentskills:v1:agentskills\.io\/skills\/demo/,
    'cache key must derive from the resolved skill URL, after the host allowlist check',
  );
});

test('serves a cached skill without touching agentskills.io', async () => {
  const cached = {
    name: 'Cached Skill',
    description: '',
    instructions: 'From cache.',
    truncated: false,
  };
  const calls = spyFetch((url) => {
    if (url.includes('/get/')) {
      return new Response(JSON.stringify({ result: JSON.stringify(cached) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('fake-upstash')) return upstashReply(29, 30);
    return skillResponse();
  });
  const { ctx } = makeCtx();

  const res = await handler(makeRequest({ url: SKILL_URL }, uniqueCallerIp()), ctx);

  assert.equal(res.status, 200);
  assert.equal((await res.json()).name, 'Cached Skill');
  assert.deepEqual(
    skillCalls(calls).map((c) => c.url),
    [],
    'a cache hit must not leave our edge',
  );
});

test('rejects an over-long URL before it can mint a cache key', async () => {
  const calls = spyFetch((url) => (url.includes('fake-upstash') ? upstashReply(29, 30) : skillResponse()));
  const { ctx } = makeCtx();

  const longSuffix = 'a'.repeat(600);
  const longUrl = `https://agentskills.io/skills/${longSuffix}`;
  const res = await handler(makeRequest({ url: longUrl }, uniqueCallerIp()), ctx);

  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'URL too long');
  assert.deepEqual(skillCalls(calls).map((c) => c.url), []);
  assert.deepEqual(cacheReads(calls).map((c) => c.url), [], 'an over-long URL must mint no cache key');
});

test('keeps the host allowlist ahead of the cache so an unapproved host mints no key', async () => {
  const calls = spyFetch((url) => (url.includes('fake-upstash') ? upstashReply(29, 30) : skillResponse()));
  const { ctx } = makeCtx();

  const res = await handler(makeRequest({ url: 'https://evil.example/skills/x' }, uniqueCallerIp()), ctx);

  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /agentskills\.io/);
  assert.deepEqual(
    cacheReads(calls).map((c) => c.url),
    [],
    'a disallowed host must be rejected before any cache read',
  );
});

test('rejects a cross-origin caller before metering or fetching', async () => {
  // A cross-origin POST with Content-Type: text/plain is a CORS simple request,
  // so no preflight blocks it: without an Origin gate a third-party page could
  // drive its visitors' browsers to make our edge fetch agentskills.io, and
  // because every victim is a different IP the per-IP budget cannot bound it.
  // (#6412 review)
  const calls = spyFetch((url) => (url.includes('fake-upstash') ? upstashReply(29, 30) : skillResponse()));
  const { ctx } = makeCtx();

  const req = new Request(ENDPOINT, {
    method: 'POST',
    headers: {
      Origin: 'https://evil.example',
      'Content-Type': 'text/plain',
      'x-real-ip': uniqueCallerIp(),
    },
    body: JSON.stringify({ url: SKILL_URL }),
  });
  const res = await handler(req, ctx);

  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'Origin not allowed');
  assert.deepEqual(skillCalls(calls).map((c) => c.url), [], 'a disallowed origin must not reach agentskills.io');
  assert.deepEqual(cacheReads(calls).map((c) => c.url), [], 'a disallowed origin must mint no cache key');
});

test('a same-origin caller with no Origin header is still allowed', async () => {
  // The settings importer posts same-origin; isDisallowedOrigin passes an absent
  // Origin, so the new gate must not break it.
  const calls = spyFetch((url) => {
    if (url.includes('/get/')) return cacheMiss();
    if (url.includes('fake-upstash')) return upstashReply(29, 30);
    return skillResponse();
  });
  const { ctx } = makeCtx();

  const req = new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-real-ip': uniqueCallerIp() },
    body: JSON.stringify({ url: SKILL_URL }),
  });
  const res = await handler(req, ctx);

  assert.equal(res.status, 200);
  assert.equal(skillCalls(calls).length, 1);
});

test('a query string never mints its own cache key', async () => {
  // agentskills.io returns the same payload regardless of unknown query params,
  // so folding `search` into the key let one caller mint unbounded 1-hour
  // entries on the Upstash instance every rate limiter shares. Query-bearing
  // URLs skip the cache in both directions. (#6412 review)
  const calls = spyFetch((url) => {
    if (url.includes('/get/')) return cacheMiss();
    if (url.includes('fake-upstash')) return upstashReply(29, 30);
    return skillResponse();
  });
  const { ctx, waited } = makeCtx();

  const res = await handler(makeRequest({ url: `${SKILL_URL}?nonce=1` }, uniqueCallerIp()), ctx);

  assert.equal(res.status, 200);
  assert.deepEqual(cacheReads(calls).map((c) => c.url), [], 'a query-bearing URL must not read the cache');
  assert.equal(waited.length, 0, 'a query-bearing URL must not write the cache');
  const setCall = calls.find((c) => c.init?.body && String(c.init.body).includes('SET'));
  assert.equal(setCall, undefined, 'no cache entry may be minted for a query-bearing URL');
});

test('stays available when Upstash is unconfigured', async () => {
  // Availability-first: the upstream is one public host behind a fixed
  // allowlist, so Redis degradation must not break skill import.
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;

  const calls = spyFetch(() => skillResponse());
  const { ctx } = makeCtx();

  // Distinguish "no limiter constructed" from "limiter threw and failed open" —
  // both otherwise satisfy the assertions below. checkScopedRateLimit logs a
  // distinct `missing-config` stage on the unconfigured path, so assert that it
  // is the one that fired and that no runtime Redis error did. (#6412 review)
  const errorLogs = [];
  const originalConsoleError = console.error;
  console.error = (...args) => { errorLogs.push(args.join(' ')); };
  let res;
  try {
    res = await handler(makeRequest({ url: SKILL_URL }, uniqueCallerIp()), ctx);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(res.status, 200);
  assert.equal((await res.json()).name, 'Demo Skill');
  assert.equal(skillCalls(calls).length, 1);
  assert.ok(
    errorLogs.some((l) => l.includes('missing-config')),
    `unconfigured Upstash must report the missing-config stage: ${errorLogs.join(' | ')}`,
  );
  assert.ok(
    !errorLogs.some((l) => l.includes('redis-error') && !l.includes('missing-config')),
    `no limiter should have been constructed, so no runtime Redis error may fire: ${errorLogs.join(' | ')}`,
  );
});
