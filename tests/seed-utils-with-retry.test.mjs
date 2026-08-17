import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  withRetry,
  parseRetryAfterMs,
  PERMANENT_4XX_STATUSES,
  getResponseHeader,
  isRetryableHttpStatus,
  httpRetryError,
  createLlmBudgetError,
  isLlmBudgetError,
} from '../scripts/_seed-utils.mjs';

describe('PERMANENT_4XX_STATUSES classification', () => {
  it('includes the request-shape errors that retrying cannot fix', () => {
    for (const code of [400, 401, 403, 404, 410, 413, 422, 451]) {
      assert.equal(PERMANENT_4XX_STATUSES.has(code), true, `expected ${code} permanent`);
    }
  });

  it('EXCLUDES 408 and 429 (transient back-off signals) — regression guard for PR #3635 review', () => {
    // 408 Request Timeout and 429 Too Many Requests are explicit "try again
    // later" signals from the server. If we tagged them nonRetryable, a
    // single rate-limited indicator fetch under parallel WEO load would
    // crash the entire seeder instead of riding out the back-off window.
    assert.equal(PERMANENT_4XX_STATUSES.has(408), false);
    assert.equal(PERMANENT_4XX_STATUSES.has(429), false);
  });

  it('EXCLUDES 5xx (server-side, retry-friendly by definition)', () => {
    for (const code of [500, 502, 503, 504]) {
      assert.equal(PERMANENT_4XX_STATUSES.has(code), false, `${code} must stay retryable`);
    }
  });
});

describe('parseRetryAfterMs', () => {
  it('parses seconds form', () => {
    assert.equal(parseRetryAfterMs('5'), 5000);
    assert.equal(parseRetryAfterMs('30'), 30_000);
  });

  it('parses HTTP-date form to a positive ms delta', () => {
    const future = new Date(Date.now() + 7000).toUTCString();
    const ms = parseRetryAfterMs(future);
    assert.ok(ms !== null && ms >= 1000 && ms <= 60_000, `expected 1-60s, got ${ms}`);
  });

  it('returns null for missing or genuinely unparseable values', () => {
    assert.equal(parseRetryAfterMs(null), null);
    assert.equal(parseRetryAfterMs(undefined), null);
    assert.equal(parseRetryAfterMs(''), null);
    assert.equal(parseRetryAfterMs('not-a-number-or-date'), null);
  });

  it('clamps "0" / negative / past-date hints to a 1000ms floor (matches yahoo/gdelt helpers)', () => {
    // Date.parse("0") yields year-2000-Jan-01 (a past date); retryAt-Date.now()
    // is hugely negative, clamped to 1000ms by Math.max. This is intentional —
    // a 0/past-time hint means "retry now" but we still want a tiny floor so
    // we don't tight-loop. Same behavior as _yahoo-fetch.mjs::parseRetryAfterMs.
    assert.equal(parseRetryAfterMs('0'), 1000);
    assert.equal(parseRetryAfterMs('-5'), 1000);
  });

  it('caps absurdly large hints at 60s so a stuck header cannot park the bundle', () => {
    assert.equal(parseRetryAfterMs('3600'), 60_000);
    const farFuture = new Date(Date.now() + 24 * 60 * 60 * 1000).toUTCString();
    assert.equal(parseRetryAfterMs(farFuture), 60_000);
  });
});

describe('withRetry', () => {
  it('short-circuits on err.nonRetryable instead of burning the retry budget', async () => {
    let attempts = 0;
    const t0 = Date.now();
    await assert.rejects(
      withRetry(async () => {
        attempts++;
        const err = new Error('permanent');
        err.nonRetryable = true;
        throw err;
      }, 5, 100),
      /permanent/,
    );
    assert.equal(attempts, 1, 'must NOT retry a nonRetryable error');
    assert.ok(Date.now() - t0 < 50, 'must fail in <50ms (no backoff sleeps)');
  });

  it('retries plain errors up to maxRetries with exponential backoff', async () => {
    let attempts = 0;
    await assert.rejects(
      withRetry(async () => { attempts++; throw new Error('transient'); }, 2, 1),
      /transient/,
    );
    assert.equal(attempts, 3, 'initial + 2 retries = 3 attempts');
  });

  it('WM_SEED_RETRY_DELAY_MS caps only the sleep, and only under the test runner', async () => {
    // The knob exists so suites that stub persistent upstream failures do not
    // idle through real backoff. Two properties are load-bearing: the attempt
    // count stays real (only the sleep shrinks), and the cap is dual-gated on
    // NODE_TEST_CONTEXT so a stray env var on a production seeder cannot
    // silently disable backoff. This file runs under the node test runner, so
    // NODE_TEST_CONTEXT is present here by construction.
    assert.ok(process.env.NODE_TEST_CONTEXT, 'precondition: running under node --test');
    const prior = process.env.WM_SEED_RETRY_DELAY_MS;
    process.env.WM_SEED_RETRY_DELAY_MS = '1';
    try {
      let attempts = 0;
      const t0 = Date.now();
      await assert.rejects(
        // delayMs 500 would sleep 500ms + 1000ms uncapped — far over the bound.
        withRetry(async () => { attempts++; throw new Error('transient'); }, 2, 500),
        /transient/,
      );
      const elapsed = Date.now() - t0;
      assert.equal(attempts, 3, 'the cap must not change the attempt count');
      // Uncapped this would sleep 500ms + 1000ms. The bound is set against the
      // sleep being avoided, not against a stopwatch reading of the work —
      // a tight absolute ceiling measures the runner's load and flakes under a
      // parallel suite while passing in isolation.
      const uncappedBackoffMs = 500 + 1000;
      assert.ok(
        elapsed < uncappedBackoffMs / 2,
        `capped backoff must not idle: got ${elapsed}ms against an uncapped ${uncappedBackoffMs}ms`,
      );
    } finally {
      if (prior === undefined) delete process.env.WM_SEED_RETRY_DELAY_MS;
      else process.env.WM_SEED_RETRY_DELAY_MS = prior;
    }
  });

  it('returns success on first attempt when fn succeeds', async () => {
    let attempts = 0;
    const result = await withRetry(async () => { attempts++; return 'ok'; }, 3, 1);
    assert.equal(result, 'ok');
    assert.equal(attempts, 1);
  });

  it('honors err.retryAfterMs when caller attaches it (e.g. from 429 Retry-After header)', async () => {
    // Trip-wire: if the caller attaches retryAfterMs=200 and the default
    // exponential backoff would have been ~1ms, we MUST sleep ≥200ms so the
    // upstream rate-limit hint is respected.
    let attempts = 0;
    const sleeps = [];
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback, ms, ...args) => {
      sleeps.push(ms);
      queueMicrotask(() => callback(...args));
      return 0;
    };
    try {
      await assert.rejects(
        withRetry(async () => {
          attempts++;
          const err = new Error('rate limited');
          if (attempts === 1) err.retryAfterMs = 200;  // hint only on first failure
          throw err;
        }, 1, 1),  // baseWait would otherwise be 1ms
        /rate limited/,
      );
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
    assert.equal(attempts, 2, 'initial attempt + one retry');
    assert.deepEqual(sleeps, [200], 'Retry-After hint must drive the backoff delay');
  });
});

// ── atomicPublish: transient-failure retry contract (WM 2026-05-10) ────────
//
// Pre-fix: a single Upstash REST timeout on the canonical SET would crash
// the entire seeder run. Railway just waited an hour for the next cron
// tick. Fix: wrap the publish body in withRetry so transient timeouts /
// 5xx / undici network errors retry with exponential backoff. Permanent
// 4xx (auth, payload-too-large) get tagged nonRetryable in redisCommand
// and abort immediately.
//
// We mock globalThis.fetch + Upstash creds to drive the retry path
// without hitting a real Redis. atomicPublish's three calls (staging
// SET, canonical SET, staging DEL) all go through the same fetch.

import { atomicPublish } from '../scripts/_seed-utils.mjs';

function mockFetch(responses) {
  let i = 0;
  return async (_url, _init) => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (typeof r === 'function') return r(_url, _init);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? { result: 'OK' }), {
      status: r.status ?? 200,
      headers: r.headers ?? {},
    });
  };
}

describe('atomicPublish retry-on-transient (WM 2026-05-10 incident fix)', () => {
  const ORIG_FETCH = globalThis.fetch;
  const ORIG_URL = process.env.UPSTASH_REDIS_REST_URL;
  const ORIG_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  function setup(fetchImpl) {
    process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    globalThis.fetch = fetchImpl;
  }
  function teardown() {
    globalThis.fetch = ORIG_FETCH;
    if (ORIG_URL == null) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = ORIG_URL;
    if (ORIG_TOKEN == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = ORIG_TOKEN;
  }

  it('succeeds without retry when all calls return 200 (happy path unchanged)', async () => {
    let calls = 0;
    setup(mockFetch([
      // Each call returns 200 OK; atomicPublish makes 3 calls (staging SET,
      // canonical SET, staging DEL). With 3 successes in a row, no retry fires.
      () => { calls += 1; return new Response(JSON.stringify({ result: 'OK' }), { status: 200 }); },
    ]));
    try {
      const result = await atomicPublish('test:key:v1', { hello: 'world' }, null, 60);
      assert.equal(result.payloadBytes > 0, true);
      assert.equal(calls, 3, 'staging-SET + canonical-SET + staging-DEL');
    } finally {
      teardown();
    }
  });

  it('runs a validated beforePublish hook before the first Redis write', async () => {
    let fetchCalls = 0;
    let beforePublishCalls = 0;
    setup(async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    });
    try {
      await assert.rejects(
        atomicPublish(
          'test:key:v1',
          { hello: 'world' },
          () => true,
          60,
          {
            beforePublish: async (data) => {
              beforePublishCalls += 1;
              assert.deepEqual(data, { hello: 'world' });
              throw new Error('pre-publish cohort failed');
            },
          },
        ),
        /pre-publish cohort failed/,
      );
      assert.equal(beforePublishCalls, 1);
      assert.equal(fetchCalls, 0, 'canonical staging must not start after a pre-publish failure');
    } finally {
      teardown();
    }
  });

  it('retries on transient 503 then succeeds on 2nd attempt', async () => {
    // First attempt: staging SET returns 503 → atomicPublish body throws,
    // withRetry sleeps 1s, re-runs the whole body. Second attempt: all OK.
    // Total fetch calls = 1 (failed) + 3 (success) = 4.
    let calls = 0;
    let firstAttemptFailed = false;
    setup(async (_url, _init) => {
      calls += 1;
      if (!firstAttemptFailed) {
        firstAttemptFailed = true;
        return new Response('upstream temporarily unavailable', { status: 503 });
      }
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    });
    try {
      const t0 = Date.now();
      const result = await atomicPublish('test:key:v1', { hello: 'world' }, null, 60);
      const elapsed = Date.now() - t0;
      assert.equal(result.payloadBytes > 0, true);
      assert.equal(calls, 4, '1 failed staging-SET + 3 successful calls on retry');
      assert.ok(elapsed >= 900, `expected ≥1s backoff, got ${elapsed}ms`);
    } finally {
      teardown();
    }
  });

  it('aborts immediately on permanent 4xx (no useless backoff)', async () => {
    // 401 Unauthorized would never recover on retry. redisCommand tags it
    // nonRetryable, withRetry skips backoff and exits the loop ~10ms.
    let calls = 0;
    setup(async (_url, _init) => {
      calls += 1;
      return new Response('bad token', { status: 401 });
    });
    try {
      const t0 = Date.now();
      await assert.rejects(
        atomicPublish('test:key:v1', { hello: 'world' }, null, 60),
        /HTTP 401/,
      );
      // `calls === 1` already proves the retry ladder never ran, which is the
      // whole content of "fast-fail" — the elapsed-time assertion that used to
      // sit here added nothing and measured the runner's load.
      assert.equal(calls, 1, 'no retries on permanent 401');
    } finally {
      teardown();
    }
  });

  it('exhausts 3 attempts on persistent transient failure (matches withRetry contract)', async () => {
    // Keep returning 503 forever. withRetry's default for atomicPublish is
    // 2 retries (3 attempts total). After exhausting, the last error
    // propagates to the caller — runSeed treats this as a fatal seed
    // failure (which, post-fix, is what we want: 3 transient failures in
    // a row IS something the operator should see).
    let calls = 0;
    setup(async () => {
      calls += 1;
      return new Response('still down', { status: 503 });
    });
    try {
      await assert.rejects(
        atomicPublish('test:key:v1', { hello: 'world' }, null, 60),
        /HTTP 503/,
      );
      // 3 attempts × 1 fetch each (fail on staging-SET) = 3 calls.
      assert.equal(calls, 3, '3 attempts before giving up');
    } finally {
      teardown();
    }
  });

  it('honors Retry-After hint on 429', async () => {
    // 429 is transient AND carries a hint. redisCommand tags retryAfterMs;
    // withRetry waits at least that long before the next attempt.
    let calls = 0;
    let firstAttemptDone = false;
    setup(async (_url, _init) => {
      calls += 1;
      if (!firstAttemptDone) {
        firstAttemptDone = true;
        return new Response('rate limited', {
          status: 429,
          headers: { 'retry-after': '2' },  // 2 seconds
        });
      }
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    });
    try {
      const t0 = Date.now();
      await atomicPublish('test:key:v1', { hello: 'world' }, null, 60);
      const elapsed = Date.now() - t0;
      assert.ok(elapsed >= 1900, `expected ≥2s Retry-After honored, got ${elapsed}ms`);
    } finally {
      teardown();
    }
  });
});

describe('getResponseHeader', () => {
  it('reads from a fetch Headers-like object (case-insensitive .get)', () => {
    const headers = { get: (n) => (n.toLowerCase() === 'retry-after' ? '5' : null) };
    assert.equal(getResponseHeader(headers, 'Retry-After'), '5');
  });

  it('reads from a plain object case-insensitively', () => {
    assert.equal(getResponseHeader({ 'retry-after': '7' }, 'Retry-After'), '7');
    assert.equal(getResponseHeader({ 'Retry-After': '9' }, 'retry-after'), '9');
  });

  it('returns null for missing headers or missing key', () => {
    assert.equal(getResponseHeader(null, 'Retry-After'), null);
    assert.equal(getResponseHeader({}, 'Retry-After'), null);
  });
});

describe('isRetryableHttpStatus', () => {
  it('treats 408/429/5xx as retryable and everything else as permanent', () => {
    for (const code of [408, 429, 500, 502, 503, 504, 599]) {
      assert.equal(isRetryableHttpStatus(code), true, `expected ${code} retryable`);
    }
    for (const code of [200, 400, 401, 402, 403, 404, 410, 422, 451]) {
      assert.equal(isRetryableHttpStatus(code), false, `expected ${code} permanent`);
    }
  });
});

describe('httpRetryError', () => {
  it('tags permanent statuses nonRetryable with no retryAfterMs', () => {
    const err = httpRetryError({ status: 402, headers: { get: () => null } });
    assert.equal(err.status, 402);
    assert.equal(err.nonRetryable, true);
    assert.equal(err.retryAfterMs, undefined);
  });

  it('attaches a Retry-After hint for retryable statuses', () => {
    const err = httpRetryError({ status: 429, headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? '3' : null) } });
    assert.equal(err.nonRetryable, false);
    assert.equal(err.retryAfterMs, 3000);
  });

  it('caps the hint by maxRetryAfterMs (server ceiling)', () => {
    const err = httpRetryError(
      { status: 503, headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? '30' : null) } },
      { maxRetryAfterMs: 10_000 },
    );
    assert.equal(err.retryAfterMs, 10_000);
  });

  it('caps the hint by capMs (remaining budget) and turns nonRetryable when budget <= 0', () => {
    const within = httpRetryError(
      { status: 429, headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? '30' : null) } },
      { maxRetryAfterMs: 10_000, capMs: 4_000 },
    );
    assert.equal(within.retryAfterMs, 4_000);

    const exhausted = httpRetryError(
      { status: 429, headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? '30' : null) } },
      { maxRetryAfterMs: 10_000, capMs: 0 },
    );
    assert.equal(exhausted.retryAfterMs, undefined);
    assert.equal(exhausted.nonRetryable, true);
  });
});

// #6110: `capMs` and `maxRetryAfterMs` are both CEILINGS — "never sleep longer
// than this". Neither answers the question that actually matters when a
// provider hands back a long Retry-After: is there any point retrying at all?
//
// Production (seed-insights, 2026-08-03 12:10Z/12:20Z): groq returned 429 with
// "tokens per day (TPD): Limit 100000, Used 100000 ... try again in 20m13.92s".
// The 1213s hint was clamped to the 10s ceiling and retried twice, burning 20s
// of a 60s LLM budget and a 120s seed lock against a wall that could not move
// for another 20 minutes. Those cycles ran 30-36s vs 7-17s for healthy ones.
//
// `remainingBudgetMs` is the wall clock the caller actually has left. When the
// server's own hint meets or exceeds it, no retry inside this run can succeed,
// so the error is nonRetryable and the provider loop falls through immediately
// with the budget intact. Equality is included: sleeping the full remainder
// would leave usableBudget at 0 and abort the whole waterfall. Deliberately a NEW option rather than a redefinition of
// `capMs`: scripts/_seed-history.mjs passes `capMs: RELAY_RETRY_AFTER_CAP_MS`
// (a fixed 10s ceiling, not a budget), so changing `capMs` semantics would
// silently make that relay give up where it used to retry.
describe('httpRetryError — remainingBudgetMs (#6110)', () => {
  const resp429 = (retryAfterSeconds) => ({
    status: 429,
    headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? String(retryAfterSeconds) : null) },
  });

  it('is nonRetryable when the server hint exceeds the remaining budget', () => {
    // The production shape: 1213s hint, ~55s of budget left.
    const err = httpRetryError(resp429(1213), { maxRetryAfterMs: 10_000, remainingBudgetMs: 55_000 });
    assert.equal(err.nonRetryable, true, 'retrying before the server will serve us is futile');
    // Fail-fast retains the UNCAPPED magnitude for logs (see fail-fast test);
    // nonRetryable stops withRetry before it is ever slept on.
    assert.equal(err.retryAfterMs, 1_213_000);
  });

  it('still retries when the hint fits inside the remaining budget', () => {
    const err = httpRetryError(resp429(3), { maxRetryAfterMs: 10_000, remainingBudgetMs: 55_000 });
    assert.equal(err.nonRetryable, false);
    assert.equal(err.retryAfterMs, 3_000);
  });

  it('still applies maxRetryAfterMs as a ceiling when the hint fits the budget', () => {
    const err = httpRetryError(resp429(30), { maxRetryAfterMs: 10_000, remainingBudgetMs: 55_000 });
    assert.equal(err.nonRetryable, false);
    assert.equal(err.retryAfterMs, 10_000, 'ceiling still applies — this is a policy knob, not a verdict');
  });

  it('is nonRetryable even for a near-miss — 3s hint against 2s of budget', () => {
    // Not a clamp. Sleeping the 2s we have still lands BEFORE the server said
    // it would serve us, so the retry is futile and the 2s is better spent
    // failing over. The margin being small does not make it survivable.
    const err = httpRetryError(resp429(3), { remainingBudgetMs: 2_000 });
    assert.equal(err.nonRetryable, true);
  });

  it('is nonRetryable when the hint exactly equals the remaining budget', () => {
    // Equality is not survivable for waterfall callers: sleeping the full
    // remainder leaves usableBudget at 0, so the next withRetry attempt throws
    // createLlmBudgetError and aborts the whole chain. Fail-fast instead.
    // Comparison is `>=` (not strict `>`).
    const err = httpRetryError(resp429(2), { remainingBudgetMs: 2_000 });
    assert.equal(err.nonRetryable, true);
    assert.equal(err.retryAfterMs, 2_000, 'uncapped magnitude retained for logs');
  });

  it('still retries when the hint is strictly under the remaining budget', () => {
    // Just under equality remains reachable — pins that `>=` did not become
    // an accidental always-futile gate for every positive hint.
    const err = httpRetryError(resp429(2), { remainingBudgetMs: 2_001 });
    assert.equal(err.nonRetryable, false);
    assert.equal(err.retryAfterMs, 2_000);
  });

  it('is nonRetryable when the budget is already spent', () => {
    const err = httpRetryError(resp429(3), { remainingBudgetMs: 0 });
    assert.equal(err.nonRetryable, true);
  });

  it('leaves capMs semantics untouched — a long hint still clamps and retries', () => {
    // scripts/_seed-history.mjs depends on exactly this: capMs is a ceiling.
    const err = httpRetryError(resp429(30), { capMs: 10_000 });
    assert.equal(err.nonRetryable, false, 'capMs must NOT gain the futility verdict');
    assert.equal(err.retryAfterMs, 10_000);
  });

  it('ignores remainingBudgetMs when the response carries no Retry-After', () => {
    const err = httpRetryError({ status: 503, headers: { get: () => null } }, { remainingBudgetMs: 1 });
    assert.equal(err.nonRetryable, false, 'no hint means no futility claim — normal backoff applies');
    assert.equal(err.retryAfterMs, undefined);
  });

  it('does not resurrect a permanent status', () => {
    const err = httpRetryError({ status: 403, headers: { get: () => '1' } }, { remainingBudgetMs: 999_000 });
    assert.equal(err.nonRetryable, true);
  });

  // Review caught this: `parseRetryAfterMs` clamps at MAX_RETRY_AFTER_MS (60s),
  // so judging futility on the PARSED value silently reinstated the bug for any
  // caller with a budget >= 60s — groq's 1213s reads as 60s there, and 60s is
  // not > 60s. The verdict now uses the uncapped hint. Both live callers happen
  // to cap usable budget below 60s (insights 55s, narrative 40s), so this was
  // latent rather than live — and would have shipped as a comment claiming a
  // guarantee the code did not provide.
  it('fires on a huge hint even when the budget exceeds the 60s parse cap', () => {
    for (const budgetMs of [60_000, 85_000, 300_000]) {
      const err = httpRetryError(resp429(1213), { maxRetryAfterMs: 10_000, remainingBudgetMs: budgetMs });
      assert.equal(err.nonRetryable, true, `budget ${budgetMs}ms must still see a 1213s hint as unreachable`);
    }
  });

  it('keeps parseRetryAfterMs itself capped — sleeping is still bounded', () => {
    // The cap is about how long we may SLEEP; only the verdict uses the raw
    // magnitude. Public behavior of the exported parser must not change.
    assert.equal(parseRetryAfterMs('1213'), 60_000);
    assert.equal(parseRetryAfterMs('3'), 3_000);
  });

  it('carries the uncapped hint on the fail-fast error so logs can tell quota from throttle', () => {
    // Not slept on — withRetry checks nonRetryable first — and must be the
    // raw magnitude, not the 60s parse cap: 1213s and 90s would both read as
    // 60_000 if we attached the capped parse.
    const err = httpRetryError(resp429(1213), { maxRetryAfterMs: 10_000, remainingBudgetMs: 55_000 });
    assert.equal(err.nonRetryable, true);
    assert.equal(err.retryAfterMs, 1_213_000);
  });

  it('fires remainingBudgetMs futility on HTTP-date Retry-After beyond the 60s parse cap', () => {
    // Seconds-form is covered above; the Date.parse branch must also feed the
    // uncapped verdict (a far-future HTTP-date flattens to 60s on the sleep
    // path and would reinstate #6110 for budgets >= 60s if judged capped).
    const originalDateNow = Date.now;
    const frozen = 1_700_000_000_000;
    Date.now = () => frozen;
    try {
      const farFuture = new Date(frozen + 1_213_000).toUTCString();
      const resp = {
        status: 429,
        headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? farFuture : null) },
      };
      for (const budgetMs of [60_000, 85_000, 300_000]) {
        const err = httpRetryError(resp, { maxRetryAfterMs: 10_000, remainingBudgetMs: budgetMs });
        assert.equal(err.nonRetryable, true, `HTTP-date budget ${budgetMs}ms must see ~1213s as unreachable`);
        assert.equal(err.retryAfterMs, 1_213_000);
      }
      assert.equal(parseRetryAfterMs(farFuture), 60_000, 'sleep parse stays capped');
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('is nonRetryable when the raw hint overruns the budget even if the ceiling would fit', () => {
    // hint 15s, ceiling 10s, budget 12s: the clamped sleep WOULD fit, but the
    // server said 15s, so waking at 10s still lands too early. The ceiling is a
    // sleep bound, not evidence about when the server will serve.
    const err = httpRetryError(resp429(15), { maxRetryAfterMs: 10_000, remainingBudgetMs: 12_000 });
    assert.equal(err.nonRetryable, true);
  });

  it('leaves the futility check off for a non-finite budget (fails open, as before)', () => {
    for (const budget of [undefined, null, Number.NaN, 'abc', {}]) {
      const err = httpRetryError(resp429(1213), { maxRetryAfterMs: 10_000, remainingBudgetMs: budget });
      assert.equal(err.nonRetryable, false, `budget ${String(budget)} must preserve pre-#6110 behavior`);
      assert.equal(err.retryAfterMs, 10_000);
    }
  });

  it('is nonRetryable for a negative budget', () => {
    const err = httpRetryError(resp429(3), { remainingBudgetMs: -5_000 });
    assert.equal(err.nonRetryable, true);
  });
});

describe('createLlmBudgetError / isLlmBudgetError', () => {
  it('produces a nonRetryable, recognizable budget sentinel', () => {
    const err = createLlmBudgetError('forecast budget spent');
    assert.equal(err.nonRetryable, true);
    assert.equal(isLlmBudgetError(err), true);
    assert.match(err.message, /forecast budget spent/);
  });

  it('does not misclassify ordinary errors', () => {
    assert.equal(isLlmBudgetError(new Error('boom')), false);
    assert.equal(isLlmBudgetError(null), false);
  });
});
