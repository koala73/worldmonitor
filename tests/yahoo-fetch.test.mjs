// Tests for scripts/_yahoo-fetch.mjs.
//
// Locks every learning from PR #3118 + #3119 review cycles:
//
//   1. Direct retries → proxy fallback cascade with `lastError` accumulator.
//   2. Catch block uses `break` (NOT `throw`) so thrown errors also reach
//      the proxy path. Includes explicit P1 regression guard.
//   3. Final exhausted-throw embeds last upstream signal (HTTP status or
//      thrown error message) + `Error.cause`.
//   4. Production defaults locked at the helper level (_PROXY_DEFAULTS).
//      Without this lock, the cascade tests would all pass even if the
//      helper accidentally wired the wrong resolver/fetcher.
//   5. DI seams (`_curlProxyResolver`, `_proxyCurlFetcher`) — production
//      callers leave unset; tests inject mocks.
//   6. Sync-curl-future-safety covered indirectly via the await-resolve
//      wrap in the helper (no test needed; the wrap is a no-op today and
//      adapts automatically if curlFetch becomes async).
//
// Yahoo-specific: NO CONNECT leg (Decodo CONNECT 404s on Yahoo per probe).
// Production defaults must NOT include a connectProxyResolver.

import { test, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

const URL = 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL';
const VALID_PAYLOAD = { chart: { result: [{ meta: { symbol: 'AAPL', regularMarketPrice: 150 } }] } };

const COMMON_OPTS = {
  label: 'AAPL',
  maxRetries: 1,
  retryBaseMs: 10,
  timeoutMs: 1000,
};

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

// ─── Production defaults: lock the wiring ───────────────────────────────

test('production defaults: curl leg uses resolveProxy (us.decodo.com pool) and curlFetch', async () => {
  // No `?t=` cache-buster — reference equality across modules requires
  // same module instance.
  const { _PROXY_DEFAULTS } = await import('../scripts/_yahoo-fetch.mjs');
  const { resolveProxy, curlFetch } = await import('../scripts/_seed-utils.mjs');
  assert.equal(_PROXY_DEFAULTS.curlProxyResolver, resolveProxy, 'curl leg MUST use resolveProxy (us.decodo.com pool — Yahoo accepts this egress)');
  assert.equal(_PROXY_DEFAULTS.curlFetcher, curlFetch, 'curl leg MUST use curlFetch (sync, future-wrapped with await Promise.resolve)');
});

test('production defaults: NO CONNECT leg (Yahoo blocks Decodo CONNECT egress with 404)', async () => {
  const { _PROXY_DEFAULTS } = await import('../scripts/_yahoo-fetch.mjs');
  // Asserting absence prevents a future "let's add CONNECT for redundancy"
  // refactor from silently re-introducing the 404 cascade. If you need to
  // add CONNECT, also re-probe Yahoo and update the comment in the helper.
  assert.equal(_PROXY_DEFAULTS.connectProxyResolver, undefined, 'No CONNECT leg — see helper module header for why');
  assert.equal(_PROXY_DEFAULTS.connectFetcher, undefined, 'No CONNECT fetcher');
});

// ─── Direct path ────────────────────────────────────────────────────────

test('200 OK: returns parsed JSON, never touches proxy', async () => {
  const { fetchYahooJson } = await import('../scripts/_yahoo-fetch.mjs');
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    headers: { get: () => null },
    json: async () => VALID_PAYLOAD,
  });

  let proxyCalls = 0;
  const result = await fetchYahooJson(URL, {
    ...COMMON_OPTS,
    _curlProxyResolver: () => 'should-not-be-used',
    _proxyCurlFetcher: () => { proxyCalls += 1; throw new Error('not reached'); },
  });
  assert.deepEqual(result, VALID_PAYLOAD);
  assert.equal(proxyCalls, 0);
});

test('429 with no proxy configured: throws after exhausting retries (HTTP 429 in message)', async () => {
  const { fetchYahooJson } = await import('../scripts/_yahoo-fetch.mjs');
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
  };

  await assert.rejects(
    () => fetchYahooJson(URL, { ...COMMON_OPTS, _curlProxyResolver: () => null }),
    (err) => {
      assert.match(err.message, /Yahoo retries exhausted/);
      assert.match(err.message, /HTTP 429/, 'last direct status MUST appear in message');
      return true;
    },
  );
  assert.equal(calls, 2, 'maxRetries=1 → 2 direct attempts');
});

test('Retry-After header parsed: backoff respects upstream hint (DI _sleep capture)', async () => {
  // Pre-fix bug: this test used Retry-After: '0', but parseRetryAfterMs()
  // treats non-positive seconds as null → helper falls back to default
  // backoff. So the test was named "Retry-After parsed" but actually
  // exercised the default-backoff branch. Fix: use a positive header value
  // that's distinctly different from `retryBaseMs * (attempt+1)`, AND
  // capture the _sleep call so we can assert which branch ran.
  const { fetchYahooJson } = await import('../scripts/_yahoo-fetch.mjs');
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: calls > 1,
      status: calls > 1 ? 200 : 429,
      headers: { get: (name) => name.toLowerCase() === 'retry-after' ? '7' : null },
      json: async () => VALID_PAYLOAD,
    };
  };
  const sleepDurations = [];
  const result = await fetchYahooJson(URL, {
    ...COMMON_OPTS,
    _curlProxyResolver: () => null,
    _sleep: async (ms) => { sleepDurations.push(ms); },  // capture, never actually sleep
  });
  assert.deepEqual(result, VALID_PAYLOAD);
  assert.equal(calls, 2);
  assert.deepEqual(sleepDurations, [7000], 'Retry-After: 7 must produce a 7000ms sleep, not retryBaseMs default (10ms)');
});

test('Retry-After absent: falls back to linear backoff retryBaseMs * (attempt+1)', async () => {
  // Companion to the test above — locks the OTHER branch of the if so
  // they're not collapsed into one path silently.
  const { fetchYahooJson } = await import('../scripts/_yahoo-fetch.mjs');
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: calls > 1,
      status: calls > 1 ? 200 : 429,
      headers: { get: () => null },  // no Retry-After
      json: async () => VALID_PAYLOAD,
    };
  };
  const sleepDurations = [];
  await fetchYahooJson(URL, {
    ...COMMON_OPTS,                             // retryBaseMs: 10
    _curlProxyResolver: () => null,
    _sleep: async (ms) => { sleepDurations.push(ms); },
  });
  assert.deepEqual(sleepDurations, [10], 'no Retry-After → retryBaseMs * 1 = 10ms');
});

// ─── Curl proxy fallback path ───────────────────────────────────────────

test('429 + curl proxy succeeds: returns proxy data', async () => {
  const { fetchYahooJson } = await import('../scripts/_yahoo-fetch.mjs');
  globalThis.fetch = async () => ({
    ok: false, status: 429, headers: { get: () => null }, json: async () => ({}),
  });

  let curlCalls = 0;
  let receivedAuth = null;
  let receivedHeaders = null;
  const result = await fetchYahooJson(URL, {
    ...COMMON_OPTS,
    _curlProxyResolver: () => 'user:pass@us.decodo.com:10001',
    _proxyCurlFetcher: (url, auth, headers) => {
      curlCalls += 1;
      receivedAuth = auth;
      receivedHeaders = headers;
      assert.match(url, /query1\.finance\.yahoo\.com/);
      return JSON.stringify(VALID_PAYLOAD);
    },
  });

  assert.equal(curlCalls, 1);
  assert.equal(receivedAuth, 'user:pass@us.decodo.com:10001');
  assert.equal(receivedHeaders['User-Agent'].length > 50, true, 'CHROME_UA forwarded to curl');
  assert.deepEqual(result, VALID_PAYLOAD);
});

test('thrown fetch error on final retry → proxy fallback runs (P1 regression guard)', async () => {
  // Pre-fix bug class: `throw err` in the catch block bypasses the proxy
  // path for thrown-error cases (timeout, ECONNRESET, DNS). Lock that
  // the new control flow `break`s and reaches the proxy.
  const { fetchYahooJson } = await import('../scripts/_yahoo-fetch.mjs');
  let directCalls = 0;
  globalThis.fetch = async () => {
    directCalls += 1;
    throw Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
  };

  let curlCalls = 0;
  const result = await fetchYahooJson(URL, {
    ...COMMON_OPTS,
    _curlProxyResolver: () => 'user:pass@us.decodo.com:10001',
    _proxyCurlFetcher: () => { curlCalls += 1; return JSON.stringify(VALID_PAYLOAD); },
  });

  assert.equal(directCalls, 2, 'direct attempts exhausted before proxy');
  assert.equal(curlCalls, 1, 'proxy MUST run on thrown-error path');
  assert.deepEqual(result, VALID_PAYLOAD);
});

test('429 + proxy ALSO fails: throws with both errors visible in message', async () => {
  const { fetchYahooJson } = await import('../scripts/_yahoo-fetch.mjs');
  globalThis.fetch = async () => ({
    ok: false, status: 429, headers: { get: () => null }, json: async () => ({}),
  });

  await assert.rejects(
    () => fetchYahooJson(URL, {
      ...COMMON_OPTS,
      _curlProxyResolver: () => 'user:pass@us.decodo.com:10001',
      _proxyCurlFetcher: () => { throw new Error('curl 502'); },
    }),
    (err) => {
      assert.match(err.message, /Yahoo retries exhausted/);
      assert.match(err.message, /HTTP 429/, 'direct status preserved');
      assert.match(err.message, /curl 502/, 'proxy error appended');
      assert.ok(err.cause, 'Error.cause chain set');
      return true;
    },
  );
});

test('proxy returns malformed JSON: throws exhausted', async () => {
  const { fetchYahooJson } = await import('../scripts/_yahoo-fetch.mjs');
  globalThis.fetch = async () => ({
    ok: false, status: 429, headers: { get: () => null }, json: async () => ({}),
  });
  await assert.rejects(
    () => fetchYahooJson(URL, {
      ...COMMON_OPTS,
      _curlProxyResolver: () => 'user:pass@us.decodo.com:10001',
      _proxyCurlFetcher: () => 'not-valid-json',
    }),
    /Yahoo retries exhausted/,
  );
});

test('proxy malformed JSON does NOT emit "succeeded" log before throwing (P2 log ordering)', async () => {
  // Pre-fix bug class: success log was emitted before JSON.parse, so a
  // malformed proxy response produced contradictory Railway logs:
  //   [YAHOO] proxy (curl) succeeded for AAPL
  //   throw: Yahoo retries exhausted ...
  // Post-fix: parse runs first; success log only fires when parse succeeds.
  // This breaks the log-grep used by the post-deploy verification in the
  // PR description (`look for [YAHOO] proxy (curl) succeeded`).
  const { fetchYahooJson } = await import('../scripts/_yahoo-fetch.mjs');
  globalThis.fetch = async () => ({
    ok: false, status: 429, headers: { get: () => null }, json: async () => ({}),
  });

  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => { logs.push(String(msg)); };
  try {
    await assert.rejects(
      () => fetchYahooJson(URL, {
        ...COMMON_OPTS,
        _curlProxyResolver: () => 'user:pass@us.decodo.com:10001',
        _proxyCurlFetcher: () => 'not-valid-json',
      }),
      /Yahoo retries exhausted/,
    );
  } finally {
    console.log = originalLog;
  }

  const succeededLogged = logs.some((l) => l.includes('proxy (curl) succeeded'));
  assert.equal(succeededLogged, false, 'success log MUST NOT fire when JSON.parse throws');
});

test('non-retryable status (500): no extra direct retry, falls to proxy', async () => {
  const { fetchYahooJson } = await import('../scripts/_yahoo-fetch.mjs');
  let directCalls = 0;
  globalThis.fetch = async () => {
    directCalls += 1;
    return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) };
  };
  let curlCalls = 0;
  const result = await fetchYahooJson(URL, {
    ...COMMON_OPTS,
    _curlProxyResolver: () => 'user:pass@us.decodo.com:10001',
    _proxyCurlFetcher: () => { curlCalls += 1; return JSON.stringify(VALID_PAYLOAD); },
  });
  assert.equal(directCalls, 1, 'non-retryable status → no extra direct retry');
  assert.equal(curlCalls, 1, 'falls to proxy');
  assert.deepEqual(result, VALID_PAYLOAD);
});

// ─── parseRetryAfterMs unit (export sanity) ─────────────────────────────

test('parseRetryAfterMs: seconds + HTTP-date + null cases', async () => {
  const { parseRetryAfterMs } = await import('../scripts/_yahoo-fetch.mjs');
  assert.equal(parseRetryAfterMs(null), null);
  assert.equal(parseRetryAfterMs(''), null);
  assert.equal(parseRetryAfterMs('5'), 5_000);
  assert.equal(parseRetryAfterMs('70'), 60_000, 'capped at MAX_RETRY_AFTER_MS=60_000');
  // HTTP-date in the past clamps to >= 1000ms.
  const past = new Date(Date.now() - 30_000).toUTCString();
  assert.equal(parseRetryAfterMs(past), 1000);
});
