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
