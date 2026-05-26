import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  withRetry,
  parseRetryAfterMs,
  PERMANENT_4XX_STATUSES,
} from '../scripts/_seed-utils.mjs';

describe('PERMANENT_4XX_STATUSES classification', () => {
  it('includes the request-shape errors that retrying cannot fix', () => {
    for (const code of [400, 401, 403, 404, 410, 422, 451]) {
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
    const t0 = Date.now();
    await assert.rejects(
      withRetry(async () => {
        attempts++;
        const err = new Error('rate limited');
        if (attempts === 1) err.retryAfterMs = 200;  // hint only on first failure
        throw err;
      }, 1, 1),  // baseWait would otherwise be 1ms
      /rate limited/,
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 200, `expected ≥200ms (Retry-After hint), got ${elapsed}ms`);
    assert.ok(elapsed < 1000, `expected <1000ms (cap respected), got ${elapsed}ms`);
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
      const elapsed = Date.now() - t0;
      assert.equal(calls, 1, 'no retries on permanent 401');
      assert.ok(elapsed < 500, `expected fast-fail, got ${elapsed}ms`);
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
