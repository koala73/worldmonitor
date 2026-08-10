import { strict as assert } from 'node:assert';
import test from 'node:test';
import handler from '../api/reverse-geocode.js';
import { __resetRateLimitForTest } from '../api/_rate-limit.js';

const makeRequest = (query) => new Request(`https://api.worldmonitor.app/api/reverse-geocode${query}`);
const ctx = { waitUntil: () => {} };

const originalFetch = globalThis.fetch;
const UPSTASH_HOST = 'https://fake-upstash.example';

// Records which upstreams a request touched, in order. The cache read is a
// plain REST GET (`/get/<key>`); the rate limiter goes through the Ratelimit
// SDK on other paths. Distinguishing them is what lets a test assert ORDER.
function installFetchRecorder({ cacheHit = false } = {}) {
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith(`${UPSTASH_HOST}/get/`)) {
      calls.push('cache-read');
      const result = cacheHit
        ? JSON.stringify({ country: 'France', code: 'FR', displayName: 'France' })
        : null;
      return new Response(JSON.stringify({ result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.startsWith(UPSTASH_HOST)) {
      // Rate limiter: unreachable Redis, so checkRateLimit degrades fail-open.
      calls.push('rate-limit');
      throw new Error('upstash unreachable');
    }
    calls.push('nominatim');
    return new Response(JSON.stringify({ address: { country: 'France', country_code: 'fr' }, display_name: 'France' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return calls;
}

function withUpstashConfigured() {
  process.env.UPSTASH_REDIS_REST_URL = UPSTASH_HOST;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
}

function reset() {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  __resetRateLimitForTest();
  globalThis.fetch = originalFetch;
}

test('rejects out-of-range coordinates before any upstream call', async (t) => {
  withUpstashConfigured();
  const calls = installFetchRecorder();
  t.after(reset);

  assert.equal((await handler(makeRequest('?lat=91&lon=0'), ctx)).status, 400);
  assert.equal((await handler(makeRequest('?lat=0&lon=181'), ctx)).status, 400);
  assert.equal((await handler(makeRequest(''), ctx)).status, 400);
  assert.deepEqual(calls, [], `validation must precede any upstream call, got: ${calls.join(', ')}`);
});

test('the rate limiter is charged on a cache MISS, not ahead of the cache read', async (t) => {
  withUpstashConfigured();
  const calls = installFetchRecorder({ cacheHit: false });
  t.after(reset);

  const res = await handler(makeRequest('?lat=48.85&lon=2.35'), ctx);
  assert.equal(res.status, 200);

  // Order invariant (not an exact sequence — the limiter retries via its
  // fallback and the cache WRITE lands on a non-/get/ path too): the cache read
  // comes first, the limiter is charged after it, and Nominatim last. Moving
  // checkRateLimit back above the cache read makes 'rate-limit' index 0.
  assert.equal(calls[0], 'cache-read', `cache read must come first, got: ${calls.join(', ')}`);
  const firstLimit = calls.indexOf('rate-limit');
  assert.ok(firstLimit > 0, `limiter must be charged on a miss, got: ${calls.join(', ')}`);
  assert.ok(
    calls.indexOf('nominatim') > firstLimit,
    `Nominatim must come after the limiter, got: ${calls.join(', ')}`,
  );
});

test('a cache HIT never consults the rate limiter or Nominatim', async (t) => {
  withUpstashConfigured();
  const calls = installFetchRecorder({ cacheHit: true });
  t.after(reset);

  const res = await handler(makeRequest('?lat=48.85&lon=2.35'), ctx);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).code, 'FR');

  // Exactly one Upstash call (the cache read) and no Nominatim call. If the
  // limiter moves back above the cache read, 'rate-limit' appears and fails.
  assert.deepEqual(calls, ['cache-read'], `cache hit should be a single cache read, got: ${calls.join(', ')}`);
});

test('still serves requests when Upstash is not configured (Tauri sidecar path)', async (t) => {
  // The PR contract: unconfigured Upstash must not break the endpoint.
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  __resetRateLimitForTest();
  const calls = installFetchRecorder();
  t.after(reset);

  const res = await handler(makeRequest('?lat=48.85&lon=2.35'), ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ['nominatim'], `no Upstash traffic expected, got: ${calls.join(', ')}`);
});
