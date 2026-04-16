// Locks the proxy-fallback behavior added to _open-meteo-archive.mjs after
// Railway 2026-04-16 logs showed seed-climate-zone-normals failing every
// batch with HTTP 429 from Open-Meteo's per-IP free-tier throttle, with no
// proxy retry.
//
// All HTTP is mocked — no real fetch / Decodo calls.

import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

const ZONES = [
  { name: 'Tropical', lat: 0,   lon: 0 },
  { name: 'Polar',    lat: 80, lon: 0 },
];

const VALID_PAYLOAD = ZONES.map((z) => ({
  latitude: z.lat,
  longitude: z.lon,
  daily: { time: ['2020-01-01'], temperature_2m_mean: [10] },
}));

const ARCHIVE_OPTS = {
  startDate: '2020-01-01',
  endDate: '2020-01-02',
  daily: ['temperature_2m_mean'],
  maxRetries: 1,
  retryBaseMs: 10,
  timeoutMs: 1000,
};

const originalFetch = globalThis.fetch;
let capturedProxyCalls;

beforeEach(() => {
  capturedProxyCalls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.PROXY_USER;
  delete process.env.PROXY_PASS;
  delete process.env.PROXY_HOST;
  delete process.env.PROXY_PORT;
  delete process.env.SEED_PROXY_AUTH;
});

// The helper accepts `_proxyResolver` and `_proxyFetcher` opt overrides
// specifically for tests — production callers leave them unset and get the
// real Decodo path from _seed-utils.mjs. This lets us exercise the proxy
// branch without spinning up a real CONNECT tunnel.

test('429 with no proxy configured: throws after exhausting retries (preserves pre-fix behavior)', async () => {
  // Re-import per-test so module-level state (none currently) is fresh.
  const { fetchOpenMeteoArchiveBatch } = await import(`../scripts/_open-meteo-archive.mjs?t=${Date.now()}`);

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: false, status: 429,
      headers: { get: () => null },
      json: async () => ({}),
    };
  };

  await assert.rejects(
    () => fetchOpenMeteoArchiveBatch(ZONES, ARCHIVE_OPTS),
    /Open-Meteo retries exhausted/,
  );
  // 1 initial + 1 retry (maxRetries=1) = 2 direct calls
  assert.equal(calls, 2);
});

test('200 OK: returns parsed batch without touching proxy path', async () => {
  const { fetchOpenMeteoArchiveBatch } = await import(`../scripts/_open-meteo-archive.mjs?t=${Date.now()}`);

  globalThis.fetch = async () => ({
    ok: true, status: 200,
    headers: { get: () => null },
    json: async () => VALID_PAYLOAD,
  });

  const result = await fetchOpenMeteoArchiveBatch(ZONES, ARCHIVE_OPTS);
  assert.equal(result.length, 2);
  assert.equal(result[0].latitude, 0);
});

test('batch size mismatch: throws even on 200', async () => {
  const { fetchOpenMeteoArchiveBatch } = await import(`../scripts/_open-meteo-archive.mjs?t=${Date.now()}`);
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    headers: { get: () => null },
    json: async () => [VALID_PAYLOAD[0]], // only 1, not 2
  });
  await assert.rejects(
    () => fetchOpenMeteoArchiveBatch(ZONES, ARCHIVE_OPTS),
    /batch size mismatch/,
  );
});

test('non-retryable status (500): falls through to proxy attempt without extra retry', async () => {
  const { fetchOpenMeteoArchiveBatch } = await import(`../scripts/_open-meteo-archive.mjs?t=${Date.now()}`);

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: false, status: 500,
      headers: { get: () => null },
      json: async () => ({}),
    };
  };

  await assert.rejects(
    () => fetchOpenMeteoArchiveBatch(ZONES, ARCHIVE_OPTS),
    /Open-Meteo retries exhausted/,
  );
  // Non-retryable status: no further retries — break out of the loop after
  // first attempt, then the proxy-fallback block runs (no proxy env →
  // skipped) → throws exhausted.
  assert.equal(calls, 1);
});

// ─── Proxy fallback path — actually exercised via _proxyResolver/_proxyFetcher ───

test('429 + proxy configured + proxy succeeds: returns proxy data, never throws', async () => {
  const { fetchOpenMeteoArchiveBatch } = await import(`../scripts/_open-meteo-archive.mjs?t=${Date.now()}`);

  globalThis.fetch = async () => ({
    ok: false, status: 429,
    headers: { get: () => null },
    json: async () => ({}),
  });

  let proxyCalls = 0;
  let receivedProxyAuth = null;
  const result = await fetchOpenMeteoArchiveBatch(ZONES, {
    ...ARCHIVE_OPTS,
    _proxyResolver: () => 'user:pass@gate.decodo.com:7000',
    _proxyFetcher: async (url, proxyAuth, _opts) => {
      proxyCalls += 1;
      receivedProxyAuth = proxyAuth;
      assert.match(url, /archive-api\.open-meteo\.com\/v1\/archive\?/);
      return { buffer: Buffer.from(JSON.stringify(VALID_PAYLOAD), 'utf8'), contentType: 'application/json' };
    },
  });

  assert.equal(proxyCalls, 1);
  assert.equal(receivedProxyAuth, 'user:pass@gate.decodo.com:7000');
  assert.equal(result.length, 2);
  assert.equal(result[1].latitude, 80);
});

test('thrown fetch error (timeout/ECONNRESET) on final direct attempt → proxy fallback runs (P1 fix)', async () => {
  // Pre-fix bug: the catch block did `throw err` after the final direct retry,
  // which silently bypassed proxy fallback for thrown-error cases (timeout,
  // ECONNRESET, DNS). Lock the new control flow: thrown error → break →
  // proxy fallback runs.
  const { fetchOpenMeteoArchiveBatch } = await import(`../scripts/_open-meteo-archive.mjs?t=${Date.now()}`);

  let directCalls = 0;
  globalThis.fetch = async () => {
    directCalls += 1;
    throw Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
  };

  let proxyCalls = 0;
  const result = await fetchOpenMeteoArchiveBatch(ZONES, {
    ...ARCHIVE_OPTS,
    _proxyResolver: () => 'user:pass@proxy.test:8000',
    _proxyFetcher: async () => {
      proxyCalls += 1;
      return { buffer: Buffer.from(JSON.stringify(VALID_PAYLOAD), 'utf8'), contentType: 'application/json' };
    },
  });

  assert.equal(directCalls, 2, 'direct attempts should exhaust retries before proxy');
  assert.equal(proxyCalls, 1, 'proxy fallback MUST run on thrown-error path (regression guard)');
  assert.equal(result.length, 2);
});

test('429 + proxy configured + proxy ALSO fails: throws exhausted with last direct error in cause', async () => {
  const { fetchOpenMeteoArchiveBatch } = await import(`../scripts/_open-meteo-archive.mjs?t=${Date.now()}`);

  globalThis.fetch = async () => ({
    ok: false, status: 429,
    headers: { get: () => null },
    json: async () => ({}),
  });

  let proxyCalls = 0;
  await assert.rejects(
    () => fetchOpenMeteoArchiveBatch(ZONES, {
      ...ARCHIVE_OPTS,
      _proxyResolver: () => 'user:pass@proxy.test:8000',
      _proxyFetcher: async () => {
        proxyCalls += 1;
        throw new Error('proxy 502');
      },
    }),
    (err) => {
      assert.match(err.message, /Open-Meteo retries exhausted/);
      assert.match(err.message, /HTTP 429/);
      return true;
    },
  );
  assert.equal(proxyCalls, 1);
});

test('proxy fallback returns wrong batch size: caught + warns, throws exhausted', async () => {
  const { fetchOpenMeteoArchiveBatch } = await import(`../scripts/_open-meteo-archive.mjs?t=${Date.now()}`);

  globalThis.fetch = async () => ({
    ok: false, status: 429,
    headers: { get: () => null },
    json: async () => ({}),
  });

  await assert.rejects(
    () => fetchOpenMeteoArchiveBatch(ZONES, {
      ...ARCHIVE_OPTS,
      _proxyResolver: () => 'user:pass@proxy.test:8000',
      _proxyFetcher: async () => ({
        buffer: Buffer.from(JSON.stringify([VALID_PAYLOAD[0]]), 'utf8'),  // 1 instead of 2
        contentType: 'application/json',
      }),
    }),
    /Open-Meteo retries exhausted/,
  );
});
