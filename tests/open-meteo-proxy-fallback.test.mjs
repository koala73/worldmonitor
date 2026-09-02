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

const VALID_NORMALS_DAILY = {
  time: Array.from({ length: 12 }, (_, index) => `2020-${String(index + 1).padStart(2, '0')}-15`),
  temperature_2m_mean: Array(12).fill(10),
  precipitation_sum: Array(12).fill(1),
};

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

// The helper accepts `_connectProxyResolver` / `_curlProxyResolver` /
// `_proxyFetcher` / `_proxyCurlFetcher` opt overrides specifically for tests
// — production callers leave them unset and get the real Decodo paths from
// _seed-utils.mjs. This lets us exercise the cascade without spinning up
// real CONNECT tunnels or curl execs.
//
// IMPORTANT: every test that exercises the proxy cascade injects BOTH
// resolvers, because production defaults route the two legs through
// DIFFERENT Decodo endpoints (gate.decodo.com vs us.decodo.com). The
// "production defaults" test below locks that wiring at the helper level.

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

  let directCalls = 0;
  globalThis.fetch = async () => {
    directCalls += 1;
    return {
      ok: false, status: 429,
      headers: { get: () => null },
      json: async () => ({}),
    };
  };

  let proxyCalls = 0;
  let receivedProxyAuth = null;
  const result = await fetchOpenMeteoArchiveBatch(ZONES, {
    ...ARCHIVE_OPTS,
    _connectProxyResolver: () => 'user:pass@gate.decodo.com:7000',
    _curlProxyResolver:    () => 'user:pass@us.decodo.com:10001',
    _proxyFetcher: async (url, proxyAuth, _opts) => {
      proxyCalls += 1;
      receivedProxyAuth = proxyAuth;
      assert.match(url, /archive-api\.open-meteo\.com\/v1\/archive\?/);
      return { buffer: Buffer.from(JSON.stringify(VALID_PAYLOAD), 'utf8'), contentType: 'application/json' };
    },
  });

  assert.equal(directCalls, 1, 'a configured proxy should own the next attempt after a throttle');
  assert.equal(proxyCalls, 1);
  assert.equal(receivedProxyAuth, 'user:pass@gate.decodo.com:7000');
  assert.equal(result.length, 2);
  assert.equal(result[1].latitude, 80);
});

test('multiple throttled batches transfer directly to CONNECT without retry waits', async () => {
  const { fetchOpenMeteoArchiveBatch } = await import(`../scripts/_open-meteo-archive.mjs?t=${Date.now()}`);

  let status = 429;
  let directCalls = 0;
  globalThis.fetch = async () => {
    directCalls += 1;
    return {
      ok: false, status,
      headers: { get: () => null },
      json: async () => ({}),
    };
  };

  let nowMs = 0;
  let connectCalls = 0;
  const retryWaits = [];
  for (const throttleStatus of [429, 503, 429]) {
    status = throttleStatus;
    const result = await fetchOpenMeteoArchiveBatch(ZONES, {
      ...ARCHIVE_OPTS,
      maxRetries: 4,
      retryBaseMs: 1,
      deadlineAtMs: 225_000,
      _now: () => nowMs,
      _sleep: async (waitMs) => {
        retryWaits.push(waitMs);
        nowMs += waitMs;
      },
      _connectProxyResolver: () => 'user:pass@gate.decodo.com:7000',
      _curlProxyResolver: () => 'user:pass@us.decodo.com:10001',
      _proxyFetcher: async () => {
        connectCalls += 1;
        nowMs += 1_000;
        return { buffer: Buffer.from(JSON.stringify(VALID_PAYLOAD), 'utf8'), contentType: 'application/json' };
      },
    });
    assert.equal(result.length, ZONES.length);
  }

  assert.equal(directCalls, 3, 'each batch should make one direct attempt');
  assert.equal(connectCalls, 3, 'each throttled batch should reach CONNECT');
  assert.deepEqual(retryWaits, [], 'the helper should not wait before changing egress routes');
  assert.ok(nowMs < 225_000, 'the proxy cascade should finish inside the shared soft deadline');
});

test('shared deadline clamps CONNECT and rejects a response that finishes after expiry', async () => {
  const { OPEN_METEO_DEADLINE_CODE, fetchOpenMeteoArchiveBatch } = await import(`../scripts/_open-meteo-archive.mjs?t=${Date.now()}`);

  let nowMs = 5;
  globalThis.fetch = async () => ({
    ok: false, status: 503,
    headers: { get: () => null },
    json: async () => ({}),
  });

  let connectCalls = 0;
  await assert.rejects(
    () => fetchOpenMeteoArchiveBatch(ZONES, {
      ...ARCHIVE_OPTS,
      deadlineAtMs: 100,
      _now: () => nowMs,
      _connectProxyResolver: () => 'user:pass@gate.decodo.com:7000',
      _curlProxyResolver: () => null,
      _proxyFetcher: async (_url, _proxyAuth, options) => {
        connectCalls += 1;
        assert.equal(options.timeoutMs, 95);
        assert.ok(options.signal instanceof AbortSignal, 'CONNECT should share one abort signal across tunnel and response work');
        nowMs = 101;
        return { buffer: Buffer.from(JSON.stringify(VALID_PAYLOAD), 'utf8'), contentType: 'application/json' };
      },
    }),
    (err) => {
      assert.equal(err.code, OPEN_METEO_DEADLINE_CODE);
      return true;
    },
  );
  assert.equal(connectCalls, 1);
});

test('shared deadline gives CONNECT failure time to reach the curl route', async () => {
  const { fetchOpenMeteoArchiveBatch } = await import(`../scripts/_open-meteo-archive.mjs?t=${Date.now()}`);

  let nowMs = 100;
  let directCalls = 0;
  globalThis.fetch = async () => {
    directCalls += 1;
    return {
      ok: false, status: 429,
      headers: { get: () => null },
      json: async () => ({}),
    };
  };

  let connectCalls = 0;
  let curlCalls = 0;
  const result = await fetchOpenMeteoArchiveBatch(ZONES, {
    ...ARCHIVE_OPTS,
    deadlineAtMs: 1_000,
    _now: () => nowMs,
    _connectProxyResolver: () => 'user:pass@gate.decodo.com:7000',
    _curlProxyResolver: () => 'user:pass@us.decodo.com:10001',
    _proxyFetcher: async (_url, _proxyAuth, options) => {
      connectCalls += 1;
      assert.equal(options.timeoutMs, 900);
      nowMs = 400;
      throw new Error('CONNECT 502');
    },
    _proxyCurlFetcher: (_url, _proxyAuth, _headers, options) => {
      curlCalls += 1;
      assert.equal(options.timeoutMs, 600);
      return JSON.stringify(VALID_PAYLOAD);
    },
  });

  assert.equal(directCalls, 1);
  assert.equal(connectCalls, 1);
  assert.equal(curlCalls, 1);
  assert.equal(result.length, ZONES.length);
});

test('normals caller shares one run-anchored deadline across every batch', async () => {
  const { CLIMATE_ZONES } = await import('../scripts/_climate-zones.mjs');
  const {
    NORMALS_FETCH_PHASE_SOFT_DEADLINE_MS,
    fetchClimateZoneNormals,
  } = await import(`../scripts/seed-climate-zone-normals.mjs?t=${Date.now()}`);

  const runStartedAtMs = 10_000;
  let nowMs = runStartedAtMs;
  const deadlines = [];
  const result = await fetchClimateZoneNormals({
    runStartedAtMs,
    _now: () => nowMs,
    _sleep: async (waitMs) => { nowMs += waitMs; },
    _fetchArchiveBatch: async (batch, options) => {
      deadlines.push(options.deadlineAtMs);
      nowMs += 100;
      return batch.map((zone) => ({
        latitude: zone.lat,
        longitude: zone.lon,
        daily: VALID_NORMALS_DAILY,
      }));
    },
  });

  const expectedDeadlineAtMs = runStartedAtMs + NORMALS_FETCH_PHASE_SOFT_DEADLINE_MS;
  assert.equal(deadlines.length, Math.ceil(CLIMATE_ZONES.length / 2));
  assert.ok(deadlines.every((deadlineAtMs) => deadlineAtMs === expectedDeadlineAtMs));
  assert.equal(result.normals.length, CLIMATE_ZONES.length);
  assert.ok(result.fetchedAt < expectedDeadlineAtMs);
});

test('normals caller stops launching batches when the soft deadline expires', async () => {
  const {
    NORMALS_FETCH_PHASE_SOFT_DEADLINE_MS,
    fetchClimateZoneNormals,
  } = await import(`../scripts/seed-climate-zone-normals.mjs?t=${Date.now()}`);

  const runStartedAtMs = 20_000;
  let nowMs = runStartedAtMs;
  let batchCalls = 0;
  await assert.rejects(
    () => fetchClimateZoneNormals({
      runStartedAtMs,
      _now: () => nowMs,
      _sleep: async (waitMs) => { nowMs += waitMs; },
      _fetchArchiveBatch: async (batch) => {
        batchCalls += 1;
        nowMs = runStartedAtMs + NORMALS_FETCH_PHASE_SOFT_DEADLINE_MS;
        return batch.map((zone) => ({
          latitude: zone.lat,
          longitude: zone.lon,
          daily: VALID_NORMALS_DAILY,
        }));
      },
    }),
    /Only 2\/25 zones returned normals \(23 errors\)/,
  );
  assert.equal(batchCalls, 1);
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
    _connectProxyResolver: () => 'user:pass@proxy.test:8000',
    _curlProxyResolver:    () => 'user:pass@proxy-curl.test:8000',
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

  let connectCalls = 0;
  let curlCalls = 0;
  await assert.rejects(
    () => fetchOpenMeteoArchiveBatch(ZONES, {
      ...ARCHIVE_OPTS,
      _connectProxyResolver: () => 'user:pass@proxy.test:8000',
    _curlProxyResolver:    () => 'user:pass@proxy-curl.test:8000',
      _proxyFetcher: async () => {
        connectCalls += 1;
        throw new Error('proxy 502');
      },
      // Stub curl path too (CONNECT failure now cascades to curl). Without
      // this stub the test would shell out to real curl since the helper's
      // default is the production curlFetch.
      _proxyCurlFetcher: () => {
        curlCalls += 1;
        throw new Error('proxy curl 502');
      },
    }),
    (err) => {
      assert.match(err.message, /Open-Meteo retries exhausted/);
      assert.match(err.message, /HTTP 429/);
      return true;
    },
  );
  assert.equal(connectCalls, 1);
  assert.equal(curlCalls, 1);
});

// ─── Production defaults: lock the resolver wiring ──────────────────────
//
// Without this test, the proxy-cascade tests would all pass even if the
// helper accidentally routed BOTH legs through the same resolver
// (collapsing the gate.decodo.com vs us.decodo.com pool redundancy this
// helper exists to provide). The defaults are exported via _PROXY_DEFAULTS
// for exactly this lock.

test('production defaults: CONNECT leg uses resolveProxyForConnect, curl leg uses resolveProxy', async () => {
  // No `?t=` cache-buster on these two imports — reference equality across
  // modules requires both imports to resolve to the SAME module instance.
  // Cache-busting forces re-evaluation and breaks the reference comparison.
  const { _PROXY_DEFAULTS } = await import('../scripts/_open-meteo-archive.mjs');
  const { resolveProxy, resolveProxyForConnect, httpsProxyFetchRaw, curlFetch } = await import('../scripts/_seed-utils.mjs');

  // Reference equality: the helper must wire the EXACT functions from
  // _seed-utils.mjs. Anything else (a wrapper, a different resolver, the
  // wrong direction) means the cascade is misconfigured.
  assert.equal(_PROXY_DEFAULTS.connectProxyResolver, resolveProxyForConnect, 'CONNECT leg MUST use resolveProxyForConnect (gate.decodo.com pool)');
  assert.equal(_PROXY_DEFAULTS.curlProxyResolver,    resolveProxy,            'curl leg MUST use resolveProxy (us.decodo.com pool)');
  assert.equal(_PROXY_DEFAULTS.connectFetcher,       httpsProxyFetchRaw,      'CONNECT leg MUST use httpsProxyFetchRaw');
  assert.equal(_PROXY_DEFAULTS.curlFetcher,          curlFetch,               'curl leg MUST use curlFetch');
});

test('production defaults: connect/curl resolvers are different functions (no single point of failure)', async () => {
  const { _PROXY_DEFAULTS } = await import('../scripts/_open-meteo-archive.mjs');
  assert.notEqual(_PROXY_DEFAULTS.connectProxyResolver, _PROXY_DEFAULTS.curlProxyResolver,
    'Same resolver for both legs would collapse the cascade into one Decodo egress pool');
  assert.notEqual(_PROXY_DEFAULTS.connectFetcher, _PROXY_DEFAULTS.curlFetcher,
    'Same fetcher for both legs is incoherent (CONNECT vs curl-x are different transport mechanisms)');
});

// ─── Second-choice curl proxy fallback ──────────────────────────────────
//
// Decodo's CONNECT and curl egress reach DIFFERENT IP pools (per
// scripts/_proxy-utils.cjs:67). Some hosts only accept one path — Yahoo
// Finance returns 404 to Decodo's CONNECT egress but 200 to curl. Probed
// 2026-04-16: Open-Meteo works through both today, but pinning to one path
// is a single point of failure if Decodo rebalances pools. The helper
// tries CONNECT first, falls through to curl only when CONNECT errors.

test('CONNECT proxy fails → curl proxy succeeds: returns curl data, never throws', async () => {
  const { fetchOpenMeteoArchiveBatch } = await import(`../scripts/_open-meteo-archive.mjs?t=${Date.now()}`);

  globalThis.fetch = async () => ({
    ok: false, status: 429,
    headers: { get: () => null },
    json: async () => ({}),
  });

  let connectCalls = 0;
  let curlCalls = 0;
  const result = await fetchOpenMeteoArchiveBatch(ZONES, {
    ...ARCHIVE_OPTS,
    _connectProxyResolver: () => 'user:pass@gate.decodo.com:7000',
    _curlProxyResolver:    () => 'user:pass@us.decodo.com:10001',
    _proxyFetcher: async () => { connectCalls += 1; throw new Error('HTTP 404'); },
    _proxyCurlFetcher: (url, _proxyAuth, _headers) => {
      curlCalls += 1;
      assert.match(url, /open-meteo/);
      return JSON.stringify(VALID_PAYLOAD);
    },
  });

  assert.equal(connectCalls, 1, 'CONNECT path attempted exactly once');
  assert.equal(curlCalls, 1, 'curl path attempted as second choice');
  assert.equal(result.length, 2);
});

test('CONNECT succeeds: curl never invoked', async () => {
  const { fetchOpenMeteoArchiveBatch } = await import(`../scripts/_open-meteo-archive.mjs?t=${Date.now()}`);

  globalThis.fetch = async () => ({
    ok: false, status: 429,
    headers: { get: () => null },
    json: async () => ({}),
  });

  let curlCalls = 0;
  const result = await fetchOpenMeteoArchiveBatch(ZONES, {
    ...ARCHIVE_OPTS,
    _connectProxyResolver: () => 'user:pass@gate.decodo.com:7000',
    _curlProxyResolver:    () => 'user:pass@us.decodo.com:10001',
    _proxyFetcher: async () => ({
      buffer: Buffer.from(JSON.stringify(VALID_PAYLOAD), 'utf8'),
      contentType: 'application/json',
    }),
    _proxyCurlFetcher: () => { curlCalls += 1; throw new Error('should not be called'); },
  });

  assert.equal(curlCalls, 0, 'CONNECT succeeded — curl path must be skipped');
  assert.equal(result.length, 2);
});

test('CONNECT fails AND curl fails: throws exhausted with both errors visible', async () => {
  const { fetchOpenMeteoArchiveBatch } = await import(`../scripts/_open-meteo-archive.mjs?t=${Date.now()}`);

  globalThis.fetch = async () => ({
    ok: false, status: 429,
    headers: { get: () => null },
    json: async () => ({}),
  });

  await assert.rejects(
    () => fetchOpenMeteoArchiveBatch(ZONES, {
      ...ARCHIVE_OPTS,
      _connectProxyResolver: () => 'user:pass@gate.decodo.com:7000',
    _curlProxyResolver:    () => 'user:pass@us.decodo.com:10001',
      _proxyFetcher: async () => { throw new Error('CONNECT 404'); },
      _proxyCurlFetcher: () => { throw new Error('curl 502'); },
    }),
    (err) => {
      assert.match(err.message, /Open-Meteo retries exhausted/);
      assert.match(err.message, /HTTP 429/);     // direct error in cause-chain
      assert.match(err.message, /curl 502/);     // last proxy error appended
      return true;
    },
  );
});

test('curl returns malformed JSON: caught + warns, throws exhausted', async () => {
  const { fetchOpenMeteoArchiveBatch } = await import(`../scripts/_open-meteo-archive.mjs?t=${Date.now()}`);

  globalThis.fetch = async () => ({
    ok: false, status: 429,
    headers: { get: () => null },
    json: async () => ({}),
  });

  await assert.rejects(
    () => fetchOpenMeteoArchiveBatch(ZONES, {
      ...ARCHIVE_OPTS,
      _connectProxyResolver: () => 'user:pass@gate.decodo.com:7000',
    _curlProxyResolver:    () => 'user:pass@us.decodo.com:10001',
      _proxyFetcher: async () => { throw new Error('CONNECT failed'); },
      _proxyCurlFetcher: () => 'not-valid-json',
    }),
    /Open-Meteo retries exhausted/,
  );
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
      _connectProxyResolver: () => 'user:pass@proxy.test:8000',
    _curlProxyResolver:    () => 'user:pass@proxy-curl.test:8000',
      _proxyFetcher: async () => ({
        buffer: Buffer.from(JSON.stringify([VALID_PAYLOAD[0]]), 'utf8'),  // 1 instead of 2
        contentType: 'application/json',
      }),
      // CONNECT fails with mismatched batch size → cascades to curl;
      // stub curl so it also fails so the test deterministically hits the
      // final exhausted-throw branch.
      _proxyCurlFetcher: () => JSON.stringify([VALID_PAYLOAD[0]]),
    }),
    /Open-Meteo retries exhausted/,
  );
});
