// Tests for scripts/_gdelt-fetch.mjs.
//
// Locks every learning from PRs #3118, #3119, #3120 + adds GDELT-specific
// multi-retry-proxy assertions:
//
//   1. lastError accumulator → final throw embeds last status + cause chain.
//   2. Catch block uses `break` (not throw) so thrown errors reach proxy.
//   3. DI seams (_curlProxyResolver, _proxyCurlFetcher, _sleep) for hermetic
//      tests with no real network / curl exec / wall-clock waits.
//   4. _PROXY_DEFAULTS exported + production-default lock tests catch
//      wiring regressions (no CONNECT leg, correct curl resolver).
//   5. Sync curlFetch wrapped with `await Promise.resolve()` (no-op today,
//      future-safe).
//   6. Success log fires AFTER JSON.parse — malformed proxy response
//      doesn't emit contradictory log lines.
//   7. Pair branch tests when picking numeric values (Retry-After vs
//      default backoff).
//   8. GDELT-specific: proxy multi-retry is the marquee feature. Test that
//      attempts 1-4 fail with 429, attempt 5 succeeds → returns data.
//   9. GDELT-specific: non-retryable proxy error (parse failure) bails
//      immediately, doesn't burn all 5 attempts.

import { test, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

const URL = 'https://api.gdeltproject.org/api/v2/doc/doc?query=climate&mode=ArtList&format=json';
const VALID_PAYLOAD = { articles: [{ url: 'https://example.com/x', title: 'foo' }] };

const COMMON_OPTS = {
  label: 'climate',
  maxRetries: 1,         // direct retries — keep tests fast
  retryBaseMs: 10,
  timeoutMs: 1000,
  proxyMaxAttempts: 3,   // proxy retries
  proxyRetryBaseMs: 10,
};

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

// ─── Production defaults: lock the wiring ───────────────────────────────

test('production defaults: curl leg uses resolveProxy + curlFetch', async () => {
  const { _PROXY_DEFAULTS } = await import('../scripts/_gdelt-fetch.mjs');
  const { resolveProxy, curlFetch } = await import('../scripts/_seed-utils.mjs');
  assert.equal(_PROXY_DEFAULTS.curlProxyResolver, resolveProxy);
  assert.equal(_PROXY_DEFAULTS.curlFetcher, curlFetch);
});

test('production defaults: NO CONNECT leg (Decodo CONNECT not yet probed against GDELT)', async () => {
  const { _PROXY_DEFAULTS } = await import('../scripts/_gdelt-fetch.mjs');
  // Asserting absence prevents a future "let's add CONNECT" refactor from
  // routing requests through an unverified egress pool. If you need to
  // add CONNECT, also re-probe GDELT and update the helper module header.
  assert.equal(_PROXY_DEFAULTS.connectProxyResolver, undefined);
  assert.equal(_PROXY_DEFAULTS.connectFetcher, undefined);
});

// ─── Direct path ────────────────────────────────────────────────────────

test('200 OK: returns parsed JSON, never touches proxy', async () => {
  const { fetchGdeltJson } = await import('../scripts/_gdelt-fetch.mjs');
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    headers: { get: () => null },
    json: async () => VALID_PAYLOAD,
  });
  let proxyCalls = 0;
  const result = await fetchGdeltJson(URL, {
    ...COMMON_OPTS,
    _curlProxyResolver: () => 'should-not-be-used',
    _proxyCurlFetcher: () => { proxyCalls += 1; throw new Error('not reached'); },
  });
  assert.deepEqual(result, VALID_PAYLOAD);
  assert.equal(proxyCalls, 0);
});

test('429 with no proxy: throws exhausted with HTTP 429 in message', async () => {
  const { fetchGdeltJson } = await import('../scripts/_gdelt-fetch.mjs');
  globalThis.fetch = async () => ({
    ok: false, status: 429, headers: { get: () => null }, json: async () => ({}),
  });
  await assert.rejects(
    () => fetchGdeltJson(URL, { ...COMMON_OPTS, _curlProxyResolver: () => null }),
    (err) => {
      assert.match(err.message, /GDELT retries exhausted/);
      assert.match(err.message, /HTTP 429/);
      return true;
    },
  );
});

// ─── Backoff math (paired branches) ─────────────────────────────────────

test('Retry-After header parsed: backoff respects upstream hint (DI _sleep capture)', async () => {
  const { fetchGdeltJson } = await import('../scripts/_gdelt-fetch.mjs');
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: calls > 1, status: calls > 1 ? 200 : 429,
      headers: { get: (name) => name.toLowerCase() === 'retry-after' ? '7' : null },
      json: async () => VALID_PAYLOAD,
    };
  };
  const sleepDurations = [];
  const result = await fetchGdeltJson(URL, {
    ...COMMON_OPTS,
    _curlProxyResolver: () => null,
    _sleep: async (ms) => { sleepDurations.push(ms); },
  });
  assert.deepEqual(result, VALID_PAYLOAD);
  assert.deepEqual(sleepDurations, [7000], 'Retry-After: 7 → 7000ms (not retryBaseMs default 10ms)');
});

test('Retry-After absent: linear backoff retryBaseMs * (attempt+1)', async () => {
  const { fetchGdeltJson } = await import('../scripts/_gdelt-fetch.mjs');
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: calls > 1, status: calls > 1 ? 200 : 429,
      headers: { get: () => null },
      json: async () => VALID_PAYLOAD,
    };
  };
  const sleepDurations = [];
  await fetchGdeltJson(URL, {
    ...COMMON_OPTS,
    _curlProxyResolver: () => null,
    _sleep: async (ms) => { sleepDurations.push(ms); },
  });
  assert.deepEqual(sleepDurations, [10], 'no Retry-After → retryBaseMs * 1 = 10ms');
});

// ─── Proxy multi-retry (GDELT marquee feature) ──────────────────────────

test('proxy multi-retry: 4 attempts fail HTTP 429, attempt 5 succeeds → returns data', async () => {
  // Mirrors the probed Decodo behavior: ~40% per-attempt success because
  // session rotates per call. Without multi-retry, GDELT would fail the
  // first 60% of attempts and stop. This is the marquee feature.
  const { fetchGdeltJson } = await import('../scripts/_gdelt-fetch.mjs');
  globalThis.fetch = async () => ({
    ok: false, status: 429, headers: { get: () => null }, json: async () => ({}),
  });

  let proxyCalls = 0;
  const sleepDurations = [];
  const result = await fetchGdeltJson(URL, {
    ...COMMON_OPTS,
    proxyMaxAttempts: 5,
    proxyRetryBaseMs: 50,
    _curlProxyResolver: () => 'user:pass@us.decodo.com:10001',
    _proxyCurlFetcher: () => {
      proxyCalls += 1;
      if (proxyCalls < 5) throw new Error('HTTP 429');
      return JSON.stringify(VALID_PAYLOAD);
    },
    _sleep: async (ms) => { sleepDurations.push(ms); },
  });

  assert.deepEqual(result, VALID_PAYLOAD);
  assert.equal(proxyCalls, 5, 'must retry through all attempts until success');
  // 4 backoffs between proxy attempts (no sleep AFTER success).
  // Plus 1 direct backoff (maxRetries=1, attempt 0 → backoff → attempt 1).
  // Total: 1 direct + 4 proxy = 5 sleeps.
  assert.equal(sleepDurations.length, 5, '1 direct + 4 inter-proxy sleeps');
  assert.deepEqual(sleepDurations.slice(1), [50, 50, 50, 50], 'proxy backoffs are proxyRetryBaseMs');
});

test('proxy non-retryable error (parse failure) bails immediately, does NOT burn all attempts', async () => {
  // Distinguish "transient throttle, retry might help" from "structural
  // failure, retry will not help". Burning 5 attempts on a parse failure
  // is wasted time + noisy logs.
  const { fetchGdeltJson } = await import('../scripts/_gdelt-fetch.mjs');
  globalThis.fetch = async () => ({
    ok: false, status: 429, headers: { get: () => null }, json: async () => ({}),
  });

  let proxyCalls = 0;
  await assert.rejects(
    () => fetchGdeltJson(URL, {
      ...COMMON_OPTS,
      proxyMaxAttempts: 5,
      _curlProxyResolver: () => 'user:pass@us.decodo.com:10001',
      _proxyCurlFetcher: () => {
        proxyCalls += 1;
        return 'not-valid-json';  // parse will throw — non-retryable
      },
    }),
    /GDELT retries exhausted/,
  );
  assert.equal(proxyCalls, 1, 'parse failure must bail after first attempt');
});

test('proxy timeout (no .status, not SyntaxError) RETRIES — Decodo session rotation may clear it', async () => {
  // P1 from PR #3122 review: probed Decodo egress gave
  // 200/200/429/TIMEOUT/429. Pre-fix logic only retried on HTTP 429/503
  // substring, so a curl timeout bailed on the first attempt and
  // defeated the multi-retry design. Lock that timeouts trigger the
  // same retry behavior as 429s.
  const { fetchGdeltJson } = await import('../scripts/_gdelt-fetch.mjs');
  globalThis.fetch = async () => ({
    ok: false, status: 429, headers: { get: () => null }, json: async () => ({}),
  });

  let proxyCalls = 0;
  const result = await fetchGdeltJson(URL, {
    ...COMMON_OPTS,
    proxyMaxAttempts: 3,
    _curlProxyResolver: () => 'user:pass@us.decodo.com:10001',
    _proxyCurlFetcher: () => {
      proxyCalls += 1;
      if (proxyCalls === 1) {
        // Mimic a curl exec timeout: Node Error with no .status, not a
        // SyntaxError. Real shape from execFileSync timeout:
        // "Command failed: curl ..." or ETIMEDOUT.
        throw Object.assign(new Error('Command failed: curl ... timed out'), { code: 'ETIMEDOUT' });
      }
      return JSON.stringify(VALID_PAYLOAD);
    },
  });
  assert.equal(proxyCalls, 2, 'timeout MUST trigger retry — Decodo session rotates per call');
  assert.deepEqual(result, VALID_PAYLOAD);
});

test('proxy ECONNRESET (no .status) RETRIES', async () => {
  // Same logic — any non-status non-parse error is treated as transient.
  const { fetchGdeltJson } = await import('../scripts/_gdelt-fetch.mjs');
  globalThis.fetch = async () => ({
    ok: false, status: 429, headers: { get: () => null }, json: async () => ({}),
  });

  let proxyCalls = 0;
  const result = await fetchGdeltJson(URL, {
    ...COMMON_OPTS,
    proxyMaxAttempts: 3,
    _curlProxyResolver: () => 'user:pass@us.decodo.com:10001',
    _proxyCurlFetcher: () => {
      proxyCalls += 1;
      if (proxyCalls === 1) {
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      }
      return JSON.stringify(VALID_PAYLOAD);
    },
  });
  assert.equal(proxyCalls, 2);
  assert.deepEqual(result, VALID_PAYLOAD);
});

test('proxy HTTP 4xx (non-429, e.g. 401 auth) does NOT retry', async () => {
  // 401/403/404 from upstream are structural — not transient. Retrying
  // wastes attempts. Locks the bail-on-non-retryable-status branch.
  const { fetchGdeltJson } = await import('../scripts/_gdelt-fetch.mjs');
  globalThis.fetch = async () => ({
    ok: false, status: 429, headers: { get: () => null }, json: async () => ({}),
  });

  let proxyCalls = 0;
  await assert.rejects(
    () => fetchGdeltJson(URL, {
      ...COMMON_OPTS,
      proxyMaxAttempts: 5,
      _curlProxyResolver: () => 'user:pass@us.decodo.com:10001',
      _proxyCurlFetcher: () => {
        proxyCalls += 1;
        // curlFetch attaches .status when curl returned a clean HTTP status.
        throw Object.assign(new Error('HTTP 401'), { status: 401 });
      },
    }),
    /GDELT retries exhausted/,
  );
  assert.equal(proxyCalls, 1, 'HTTP 401 is non-retryable — must bail after 1 attempt');
});

test('proxy retryable + non-retryable mix: retries on 429, bails on parse failure', async () => {
  // First two attempts 429 (retryable, keep going), third returns garbage
  // (non-retryable, bail). Locks the distinction.
  const { fetchGdeltJson } = await import('../scripts/_gdelt-fetch.mjs');
  globalThis.fetch = async () => ({
    ok: false, status: 429, headers: { get: () => null }, json: async () => ({}),
  });

  let proxyCalls = 0;
  await assert.rejects(
    () => fetchGdeltJson(URL, {
      ...COMMON_OPTS,
      proxyMaxAttempts: 5,
      _curlProxyResolver: () => 'user:pass@us.decodo.com:10001',
      _proxyCurlFetcher: () => {
        proxyCalls += 1;
        if (proxyCalls < 3) throw new Error('HTTP 429');
        return 'not-valid-json';
      },
    }),
    /GDELT retries exhausted/,
  );
  assert.equal(proxyCalls, 3, '2× 429 retries + 1× parse failure = 3 attempts');
});

test('thrown fetch error on final direct retry → proxy multi-retry runs (P1 regression guard)', async () => {
  // PR #3118 P1: catch block must `break` not `throw` so thrown errors
  // reach the proxy path. Lock for GDELT too.
  const { fetchGdeltJson } = await import('../scripts/_gdelt-fetch.mjs');
  let directCalls = 0;
  globalThis.fetch = async () => {
    directCalls += 1;
    throw Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
  };
  let proxyCalls = 0;
  const result = await fetchGdeltJson(URL, {
    ...COMMON_OPTS,
    _curlProxyResolver: () => 'user:pass@us.decodo.com:10001',
    _proxyCurlFetcher: () => { proxyCalls += 1; return JSON.stringify(VALID_PAYLOAD); },
  });
  assert.equal(directCalls, 2, 'direct attempts exhausted before proxy');
  assert.equal(proxyCalls, 1, 'proxy MUST run on thrown-error path');
  assert.deepEqual(result, VALID_PAYLOAD);
});

test('429 + ALL proxy attempts fail: throws with attempt count + both errors', async () => {
  const { fetchGdeltJson } = await import('../scripts/_gdelt-fetch.mjs');
  globalThis.fetch = async () => ({
    ok: false, status: 429, headers: { get: () => null }, json: async () => ({}),
  });
  await assert.rejects(
    () => fetchGdeltJson(URL, {
      ...COMMON_OPTS,
      proxyMaxAttempts: 3,
      _curlProxyResolver: () => 'user:pass@us.decodo.com:10001',
      _proxyCurlFetcher: () => { throw new Error('HTTP 429'); },
    }),
    (err) => {
      assert.match(err.message, /GDELT retries exhausted/);
      assert.match(err.message, /HTTP 429/, 'direct status preserved');
      assert.match(err.message, /3\/3 attempts/, 'proxy attempt count in message');
      assert.ok(err.cause, 'Error.cause chain set');
      return true;
    },
  );
});

// ─── Log ordering (P2 from PR #3120) ───────────────────────────────────

test('proxy malformed JSON does NOT emit "succeeded" log before throwing', async () => {
  const { fetchGdeltJson } = await import('../scripts/_gdelt-fetch.mjs');
  globalThis.fetch = async () => ({
    ok: false, status: 429, headers: { get: () => null }, json: async () => ({}),
  });

  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => { logs.push(String(msg)); };
  try {
    await assert.rejects(
      () => fetchGdeltJson(URL, {
        ...COMMON_OPTS,
        _curlProxyResolver: () => 'user:pass@us.decodo.com:10001',
        _proxyCurlFetcher: () => 'not-valid-json',
      }),
      /GDELT retries exhausted/,
    );
  } finally {
    console.log = originalLog;
  }

  const succeededLogged = logs.some((l) => l.includes('proxy (curl) succeeded'));
  assert.equal(succeededLogged, false, 'success log MUST NOT fire when JSON.parse throws');
});

// ─── Direct-leg parse-failure must reach proxy (P2 from PR #3122 review) ──
//
// Previously `resp.json()` was called outside the try/catch that guards
// fetch(), so a 200 OK with HTML/garbage body (WAF challenge, partial
// response, gzip mismatch) would throw SyntaxError and escape the helper
// — the proxy fallback never ran. The proxy leg already parsed inside
// its own catch; the direct leg is now symmetric.

test('direct 200 OK with malformed JSON: proxy fallback runs (P2 regression guard)', async () => {
  const { fetchGdeltJson } = await import('../scripts/_gdelt-fetch.mjs');

  let directCalls = 0;
  globalThis.fetch = async () => {
    directCalls += 1;
    return {
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
    };
  };

  let proxyCalls = 0;
  const result = await fetchGdeltJson(URL, {
    ...COMMON_OPTS,
    maxRetries: 0,           // single direct attempt is enough to prove the path
    _curlProxyResolver: () => 'user:pass@us.decodo.com:10001',
    _proxyCurlFetcher: () => { proxyCalls += 1; return JSON.stringify(VALID_PAYLOAD); },
  });

  assert.equal(directCalls, 1);
  assert.equal(proxyCalls, 1, 'direct parse-failure MUST reach the proxy fallback');
  assert.deepEqual(result, VALID_PAYLOAD);
});

// ─── Helper API: caller-supplied budgets (knob behavior) ───────────────
//
// These tests lock the HELPER'S contract for arbitrary callers — they
// assert the helper correctly honors caller-supplied budget overrides,
// independent of any specific seeder's choice. Useful as documentation
// of the helper API and as guard against future regressions where the
// helper accidentally ignores a budget knob.
//
// NOTE: seed-gdelt-intel.mjs's fetchTopicTimeline currently uses 0/2
// (1 direct + 2 proxy attempts). The 0/0 tests below cover the
// minimal-budget extreme — they do NOT lock seed-gdelt-intel's choice.
// A separate test below mirrors the seeder's actual 0/2 choice.

test('maxRetries:0 + proxyMaxAttempts:0 → single direct attempt, no proxy, throws on first failure', async () => {
  const { fetchGdeltJson } = await import('../scripts/_gdelt-fetch.mjs');
  let directCalls = 0;
  let proxyCalls = 0;
  globalThis.fetch = async () => {
    directCalls += 1;
    return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
  };
  await assert.rejects(
    () => fetchGdeltJson(URL, {
      label: 'best-effort',
      maxRetries: 0,
      proxyMaxAttempts: 0,
      _curlProxyResolver: () => 'user:pass@us.decodo.com:10001',
      _proxyCurlFetcher: () => { proxyCalls += 1; return JSON.stringify(VALID_PAYLOAD); },
      _sleep: async () => {},
    }),
    /GDELT retries exhausted/,
  );
  assert.equal(directCalls, 1, 'maxRetries:0 → single direct attempt');
  assert.equal(proxyCalls, 0, 'proxyMaxAttempts:0 → proxy loop must NOT execute even when curl resolver is configured');
});

test('proxyMaxAttempts:0 → no "trying proxy" log emitted (no misleading "up to 0×" line)', async () => {
  const { fetchGdeltJson } = await import('../scripts/_gdelt-fetch.mjs');
  globalThis.fetch = async () => ({
    ok: false, status: 429, headers: { get: () => null }, json: async () => ({}),
  });
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => { logs.push(String(msg)); };
  try {
    await assert.rejects(
      () => fetchGdeltJson(URL, {
        label: 'best-effort',
        maxRetries: 0,
        proxyMaxAttempts: 0,
        _curlProxyResolver: () => 'user:pass@us.decodo.com:10001',
        _proxyCurlFetcher: () => JSON.stringify(VALID_PAYLOAD),
        _sleep: async () => {},
      }),
      /GDELT retries exhausted/,
    );
  } finally { console.log = originalLog; }
  const tryingLogged = logs.some((l) => l.includes('trying proxy'));
  assert.equal(tryingLogged, false, 'no "trying proxy (curl) up to 0×" line — would be both wrong and noisy');
});

// ─── Seeder-mirror: 0/2 (matches seed-gdelt-intel:fetchTopicTimeline) ─

test('maxRetries:0 + proxyMaxAttempts:2 (timeline budget): 1 direct + up to 2 proxy attempts, returns on first proxy success', async () => {
  // Mirrors the budget seed-gdelt-intel.mjs:fetchTopicTimeline currently
  // uses for best-effort timeline calls. Locks that 0/2 actually gives
  // the timeline path a real recovery chance via proxy session rotation
  // (which 0/0 would not).
  const { fetchGdeltJson } = await import('../scripts/_gdelt-fetch.mjs');
  let directCalls = 0;
  let proxyCalls = 0;
  globalThis.fetch = async () => {
    directCalls += 1;
    return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
  };
  const result = await fetchGdeltJson(URL, {
    label: 'climate/TimelineTone',
    maxRetries: 0,
    proxyMaxAttempts: 2,
    proxyRetryBaseMs: 10,
    timeoutMs: 1000,
    _curlProxyResolver: () => 'user:pass@us.decodo.com:10001',
    _proxyCurlFetcher: () => {
      proxyCalls += 1;
      if (proxyCalls === 1) throw new Error('HTTP 429');
      return JSON.stringify(VALID_PAYLOAD);
    },
    _sleep: async () => {},
  });
  assert.equal(directCalls, 1, '0 direct retries → 1 direct attempt only');
  assert.equal(proxyCalls, 2, '2 proxy attempts: 1st 429, 2nd succeeds');
  assert.deepEqual(result, VALID_PAYLOAD);
});

test('maxRetries:0 + proxyMaxAttempts:2: both proxy attempts fail → exhausted (no extra direct retries)', async () => {
  const { fetchGdeltJson } = await import('../scripts/_gdelt-fetch.mjs');
  let directCalls = 0;
  let proxyCalls = 0;
  globalThis.fetch = async () => {
    directCalls += 1;
    return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
  };
  await assert.rejects(
    () => fetchGdeltJson(URL, {
      label: 'climate/TimelineVol',
      maxRetries: 0,
      proxyMaxAttempts: 2,
      proxyRetryBaseMs: 10,
      timeoutMs: 1000,
      _curlProxyResolver: () => 'user:pass@us.decodo.com:10001',
      _proxyCurlFetcher: () => { proxyCalls += 1; throw new Error('HTTP 429'); },
      _sleep: async () => {},
    }),
    (err) => {
      assert.match(err.message, /GDELT retries exhausted/);
      assert.match(err.message, /2\/2 attempts/, 'attempt count in message reflects the budget');
      return true;
    },
  );
  assert.equal(directCalls, 1, '0 direct retries → 1 direct attempt only');
  assert.equal(proxyCalls, 2, 'proxy budget exhausted at 2');
});

// ─── parseRetryAfterMs unit ─────────────────────────────────────────────

test('parseRetryAfterMs: seconds + HTTP-date + null cases', async () => {
  const { parseRetryAfterMs } = await import('../scripts/_gdelt-fetch.mjs');
  assert.equal(parseRetryAfterMs(null), null);
  assert.equal(parseRetryAfterMs(''), null);
  assert.equal(parseRetryAfterMs('5'), 5_000);
  assert.equal(parseRetryAfterMs('70'), 60_000, 'capped at MAX_RETRY_AFTER_MS=60_000');
  const past = new Date(Date.now() - 30_000).toUTCString();
  assert.equal(parseRetryAfterMs(past), 1000);
});
