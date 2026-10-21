/**
 * #6716 — free-account allowance meter.
 *
 * Split out of tests/mcp-paid-funnel.test.mjs because the meter needs a Redis
 * mock with real atomic-script semantics, TTL expiry, and command failures
 * rather than the always-succeeds stub the denial-copy assertions use.
 */
import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  FREE_ACCOUNT_CALLS_PER_DAY,
  FREE_ACCOUNT_IDLE_GAP_MS,
  FREE_ACCOUNT_REQUESTS_PER_DAY,
} from '../api/mcp/upgrade-constants.ts';
import {
  reserveFreeAccountAllowance,
  freeAccountCallsKey,
  freeAccountRequestsKey,
  freeAccountLastActivityKey,
} from '../api/mcp/free-account-allowance.ts';

const NOON = Date.UTC(2026, 7, 17, 12, 0, 0);

/**
 * Upstash-shaped pipeline over an in-memory store.
 *
 * Implements the allowance EVAL contract as one indivisible operation. The
 * mock reads all state before any write, applies no writes on denial/failure,
 * and commits the three keys together on admission. JavaScript executes this
 * synchronous section without yielding, matching Redis script serialization.
 *
 * `opts.failOn(cmd, key, callIndex)` returns 'throw' | 'error' | undefined.
 */
function memoryPipeline(store, opts = {}) {
  const ttls = opts.ttls ?? new Map();
  const clock = opts.clock ?? { now: NOON };
  let callIndex = 0;

  const live = (key) => {
    const exp = ttls.get(key);
    if (exp !== undefined && clock.now >= exp) {
      store.delete(key);
      ttls.delete(key);
      return false;
    }
    return store.has(key);
  };

  return async (ops) => {
    if (ops.length !== 1 || ops[0]?.[0] !== 'EVAL' || Number(ops[0]?.[2]) !== 3) {
      throw new Error(`expected one three-key EVAL, got ${JSON.stringify(ops)}`);
    }
    const op = ops[0];
    const callsKey = op[3];
    const requestsKey = op[4];
    const lastKey = op[5];
    const mode = opts.failOn?.('EVAL', callsKey, callIndex);
    callIndex += 1;
    if (mode === 'throw') throw new Error('redis down: EVAL');
    if (mode === 'error') return [{ error: 'ERR simulated EVAL failure' }];

    const nowMs = Number(op[6]);
    const idleGapMs = Number(op[7]);
    const callsLimit = Number(op[8]);
    const requestsLimit = Number(op[9]);
    const counterTtlSeconds = Number(op[10]);
    const readInteger = (key, present) => {
      if (!present) return 0;
      const value = Number(store.get(key));
      return Number.isInteger(value) && value >= 0 ? value : null;
    };
    const callsPresent = live(callsKey);
    const requestsPresent = live(requestsKey);
    const lastPresent = live(lastKey);
    const calls = readInteger(callsKey, callsPresent);
    const requests = readInteger(requestsKey, requestsPresent);
    const last = lastPresent ? readInteger(lastKey, true) : null;
    if (
      calls === null
      || requests === null
      || (lastPresent && last === null)
      || callsPresent !== requestsPresent
      || requests > calls
      || (lastPresent && calls === 0)
    ) {
      return [{ result: [-1] }];
    }
    const opensWindow = last === null || nowMs - last >= idleGapMs;
    if (calls >= callsLimit || opensWindow && requests >= requestsLimit) {
      return [{ result: [0] }];
    }

    const nextCalls = calls + 1;
    const nextRequests = requests + (opensWindow ? 1 : 0);
    const activityMs = last === null ? nowMs : Math.max(nowMs, last);
    store.set(callsKey, nextCalls);
    if (opensWindow) store.set(requestsKey, nextRequests);
    store.set(lastKey, String(activityMs));
    ttls.set(callsKey, clock.now + counterTtlSeconds * 1000);
    if (opensWindow) ttls.set(requestsKey, clock.now + counterTtlSeconds * 1000);
    ttls.set(lastKey, clock.now + idleGapMs);
    return [{ result: [1] }];
  };
}

const originalEnv = { ...process.env };
afterEach(() => {
  Object.keys(process.env).forEach((k) => {
    if (!(k in originalEnv)) delete process.env[k];
  });
  Object.assign(process.env, originalEnv);
});

describe('free-account allowance — happy paths', () => {
  it('allows the first call and opens exactly one request window', async () => {
    const store = new Map();
    const clock = { now: NOON };
    const result = await reserveFreeAccountAllowance('u1', memoryPipeline(store, { clock }), NOON);
    assert.equal(result.ok, true);
    assert.equal(store.get(freeAccountCallsKey('u1', NOON)), 1);
    assert.equal(store.get(freeAccountRequestsKey('u1', NOON)), 1);
    assert.equal(store.get(freeAccountLastActivityKey('u1', NOON)), String(NOON));
  });

  it('a second call inside the same window burns a call but not a window', async () => {
    const store = new Map();
    const clock = { now: NOON };
    const pipe = memoryPipeline(store, { clock });
    assert.equal((await reserveFreeAccountAllowance('u2', pipe, NOON)).ok, true);
    clock.now = NOON + 60_000;
    assert.equal((await reserveFreeAccountAllowance('u2', pipe, clock.now)).ok, true);
    assert.equal(store.get(freeAccountRequestsKey('u2', NOON)), 1);
    assert.equal(store.get(freeAccountCallsKey('u2', NOON)), 2);
  });

  it('the reservation exposes no rollback handle — the slot is charged for good', async () => {
    const store = new Map();
    const result = await reserveFreeAccountAllowance('u3', memoryPipeline(store), NOON);
    assert.equal(result.ok, true);
    // A refund seam no caller may legitimately use is a trap: dispatch's
    // GHSA-hcq5 posture forbids caller-side refunds after dispatch begins.
    assert.equal('rollback' in result, false);
  });
});

describe('free-account allowance — ceilings', () => {
  it('enforces the five-call ceiling and leaves the counter AT the limit', async () => {
    const store = new Map();
    const clock = { now: NOON };
    const pipe = memoryPipeline(store, { clock });
    for (let i = 0; i < FREE_ACCOUNT_CALLS_PER_DAY; i += 1) {
      clock.now = NOON + i * 1000;
      assert.equal((await reserveFreeAccountAllowance('u4', pipe, clock.now)).ok, true);
    }
    clock.now = NOON + 10_000;
    const sixth = await reserveFreeAccountAllowance('u4', pipe, clock.now);
    assert.equal(sixth.ok, false);
    assert.equal(sixth.reason, 'allowance-exhausted');
    // A rejected atomic reservation must leave the accepted-call count intact.
    assert.equal(store.get(freeAccountCallsKey('u4', NOON)), FREE_ACCOUNT_CALLS_PER_DAY);
  });

  it('enforces the three request-window ceiling without publishing a denied window', async () => {
    const store = new Map();
    const clock = { now: NOON };
    const pipe = memoryPipeline(store, { clock });
    for (let i = 0; i < FREE_ACCOUNT_REQUESTS_PER_DAY; i += 1) {
      clock.now = NOON + i * (FREE_ACCOUNT_IDLE_GAP_MS + 1);
      assert.equal((await reserveFreeAccountAllowance('u5', pipe, clock.now, { callsPerDay: 99 })).ok, true);
    }
    clock.now = NOON + FREE_ACCOUNT_REQUESTS_PER_DAY * (FREE_ACCOUNT_IDLE_GAP_MS + 1);
    const fourth = await reserveFreeAccountAllowance('u5', pipe, clock.now, { callsPerDay: 99 });
    assert.equal(fourth.ok, false);
    assert.equal(fourth.reason, 'allowance-exhausted');
    assert.equal(store.get(freeAccountRequestsKey('u5', NOON)), FREE_ACCOUNT_REQUESTS_PER_DAY);
  });

  it('keeps an immediate retry denied after the fourth request window is rejected', async () => {
    const store = new Map();
    const clock = { now: NOON };
    const pipe = memoryPipeline(store, { clock });
    for (let i = 0; i < FREE_ACCOUNT_REQUESTS_PER_DAY; i += 1) {
      clock.now = NOON + i * (FREE_ACCOUNT_IDLE_GAP_MS + 1);
      assert.equal((await reserveFreeAccountAllowance('u5_retry', pipe, clock.now, { callsPerDay: 99 })).ok, true);
    }
    clock.now = NOON + FREE_ACCOUNT_REQUESTS_PER_DAY * (FREE_ACCOUNT_IDLE_GAP_MS + 1);
    const [denied, concurrentFollower] = await Promise.all([
      reserveFreeAccountAllowance('u5_retry', pipe, clock.now, { callsPerDay: 99 }),
      reserveFreeAccountAllowance('u5_retry', pipe, clock.now, { callsPerDay: 99 }),
    ]);
    const immediateRetry = await reserveFreeAccountAllowance('u5_retry', pipe, clock.now + 1, { callsPerDay: 99 });
    assert.deepEqual(denied, { ok: false, reason: 'allowance-exhausted' });
    assert.deepEqual(concurrentFollower, { ok: false, reason: 'allowance-exhausted' });
    assert.deepEqual(immediateRetry, { ok: false, reason: 'allowance-exhausted' });
    assert.equal(store.get(freeAccountRequestsKey('u5_retry', NOON)), FREE_ACCOUNT_REQUESTS_PER_DAY);
    assert.equal(store.has(freeAccountLastActivityKey('u5_retry', NOON)), false);
  });

  it('admits exactly five calls from a concurrent over-cap burst without weakening the stored cap', async () => {
    const store = new Map();
    const pipe = memoryPipeline(store, { clock: { now: NOON } });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => reserveFreeAccountAllowance(
        'u_concurrent_cap',
        pipe,
        NOON,
        { requestsPerDay: 99 },
      )),
    );
    assert.equal(results.filter((result) => result.ok).length, FREE_ACCOUNT_CALLS_PER_DAY);
    assert.equal(
      store.get(freeAccountCallsKey('u_concurrent_cap', NOON)),
      FREE_ACCOUNT_CALLS_PER_DAY,
    );
  });

  it('does not mutate counters when a call is rejected at the hard ceiling', async () => {
    const store = new Map();
    const clock = { now: NOON };
    const pipe = memoryPipeline(store, { clock });
    for (let i = 0; i < FREE_ACCOUNT_CALLS_PER_DAY; i += 1) {
      clock.now = NOON + i * 1000;
      assert.equal((await reserveFreeAccountAllowance('u6', pipe, clock.now)).ok, true);
    }
    const key = freeAccountCallsKey('u6', NOON);
    assert.deepEqual(
      await reserveFreeAccountAllowance('u6', pipe, NOON + 10_000),
      { ok: false, reason: 'allowance-exhausted' },
    );
    assert.equal(store.get(key), FREE_ACCOUNT_CALLS_PER_DAY);
  });
});

describe('free-account allowance — idle-gap window boundary', () => {
  it('does NOT open a new window one millisecond before the gap elapses', async () => {
    const store = new Map();
    const clock = { now: NOON };
    const pipe = memoryPipeline(store, { clock });
    await reserveFreeAccountAllowance('u7', pipe, NOON);
    clock.now = NOON + FREE_ACCOUNT_IDLE_GAP_MS - 1;
    await reserveFreeAccountAllowance('u7', pipe, clock.now);
    assert.equal(store.get(freeAccountRequestsKey('u7', NOON)), 1);
  });

  it('opens a new window at exactly the idle gap', async () => {
    const store = new Map();
    const clock = { now: NOON };
    const pipe = memoryPipeline(store, { clock });
    await reserveFreeAccountAllowance('u8', pipe, NOON);
    clock.now = NOON + FREE_ACCOUNT_IDLE_GAP_MS;
    await reserveFreeAccountAllowance('u8', pipe, clock.now);
    assert.equal(store.get(freeAccountRequestsKey('u8', NOON)), 2);
  });

  it('keeps continuous activity in one window across multiple idle-gap durations', async () => {
    const store = new Map();
    const clock = { now: NOON };
    const pipe = memoryPipeline(store, { clock });
    await reserveFreeAccountAllowance('u8_active', pipe, NOON, { callsPerDay: 99 });
    clock.now = NOON + FREE_ACCOUNT_IDLE_GAP_MS - 1;
    await reserveFreeAccountAllowance('u8_active', pipe, clock.now, { callsPerDay: 99 });
    clock.now = NOON + 2 * (FREE_ACCOUNT_IDLE_GAP_MS - 1);
    await reserveFreeAccountAllowance('u8_active', pipe, clock.now, { callsPerDay: 99 });
    assert.equal(store.get(freeAccountRequestsKey('u8_active', NOON)), 1);
    assert.equal(store.get(freeAccountLastActivityKey('u8_active', NOON)), String(clock.now));
  });

  it('a concurrent burst spends exactly one window, not one per call', async () => {
    // MCP clients fan tool calls out in parallel. A read-modify-write window
    // check let every request in a burst believe it was opening the window, so
    // one user action could spend all three daily windows.
    const store = new Map();
    const pipe = memoryPipeline(store, { clock: { now: NOON } });
    const results = await Promise.all(
      Array.from({ length: 4 }, () => reserveFreeAccountAllowance('u9', pipe, NOON)),
    );
    assert.equal(results.every((r) => r.ok), true);
    assert.equal(store.get(freeAccountRequestsKey('u9', NOON)), 1);
    assert.equal(store.get(freeAccountCallsKey('u9', NOON)), 4);
  });

  it('opens a fresh window on the first call after UTC midnight', async () => {
    // The last-activity key is day-scoped like both counters. An un-scoped key
    // outlives the rollover, so 23:58 activity would suppress the new day's
    // first window-open and let an extra window slip past the daily cap.
    const lateYesterday = Date.UTC(2026, 7, 17, 23, 58, 0);
    const earlyToday = Date.UTC(2026, 7, 18, 0, 1, 0);
    const store = new Map();
    const clock = { now: lateYesterday };
    const pipe = memoryPipeline(store, { clock });
    await reserveFreeAccountAllowance('u10', pipe, lateYesterday);
    clock.now = earlyToday;
    await reserveFreeAccountAllowance('u10', pipe, earlyToday);
    assert.equal(store.get(freeAccountRequestsKey('u10', lateYesterday)), 1);
    assert.equal(store.get(freeAccountRequestsKey('u10', earlyToday)), 1);
    assert.notEqual(
      freeAccountLastActivityKey('u10', lateYesterday),
      freeAccountLastActivityKey('u10', earlyToday),
    );
  });
});

describe('free-account allowance — fails closed on every Redis failure', () => {
  for (const mode of ['throw', 'error']) {
    it(`denies without state when the atomic command ${mode === 'throw' ? 'throws' : 'reports an error'}`, async () => {
      const store = new Map();
      const ttls = new Map();
      const pipe = memoryPipeline(store, {
        ttls,
        clock: { now: NOON },
        failOn: () => mode,
      });
      const result = await reserveFreeAccountAllowance('u_fail', pipe, NOON);
      assert.deepEqual(result, { ok: false, reason: 'redis-unavailable' });
      assert.equal(store.size, 0);
      assert.equal(ttls.size, 0);
    });
  }

  it('does not consume a call or leave a counter without TTL on a command error', async () => {
    const store = new Map();
    const ttls = new Map();
    const callsKey = freeAccountCallsKey('u_expire', NOON);
    const pipe = memoryPipeline(store, {
      ttls,
      clock: { now: NOON },
      failOn: () => 'error',
    });
    const result = await reserveFreeAccountAllowance('u_expire', pipe, NOON);
    assert.deepEqual(result, { ok: false, reason: 'redis-unavailable' });
    assert.equal(store.has(callsKey), false);
    assert.equal(ttls.has(callsKey), false);
  });

  it('fails closed on a malformed atomic reply', async () => {
    for (const result of [null, [], [null], ['']]) {
      const response = await reserveFreeAccountAllowance(
        'u_malformed_reply',
        async () => [{ result }],
        NOON,
      );
      assert.deepEqual(response, { ok: false, reason: 'redis-unavailable' });
    }
  });

  it('fails closed without overwriting malformed stored state', async () => {
    const callsKey = freeAccountCallsKey('u_malformed_state', NOON);
    const store = new Map([[callsKey, 'not-a-counter']]);
    const response = await reserveFreeAccountAllowance(
      'u_malformed_state',
      memoryPipeline(store),
      NOON,
    );
    assert.deepEqual(response, { ok: false, reason: 'redis-unavailable' });
    assert.equal(store.get(callsKey), 'not-a-counter');
  });

  it('denies an empty userId without touching Redis', async () => {
    let called = false;
    const result = await reserveFreeAccountAllowance('', async () => { called = true; return []; });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'redis-unavailable');
    assert.equal(called, false);
  });
});

describe('free-account allowance — key construction', () => {
  it('scopes every key to the UTC day', () => {
    const a = Date.UTC(2026, 7, 17, 23, 59, 59);
    const b = Date.UTC(2026, 7, 18, 0, 0, 0);
    assert.notEqual(freeAccountCallsKey('u', a), freeAccountCallsKey('u', b));
    assert.notEqual(freeAccountRequestsKey('u', a), freeAccountRequestsKey('u', b));
    assert.notEqual(freeAccountLastActivityKey('u', a), freeAccountLastActivityKey('u', b));
  });

  it('carries the environment prefix so preview cannot spend production allowance', () => {
    // Preview and production share ONE Upstash instance (see redis.ts's
    // getKeyPrefix comment), so an unprefixed key is cross-environment leakage.
    const bare = freeAccountCallsKey('u', NOON);
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_GIT_COMMIT_SHA = 'abcdef1234567890';
    const prefixed = freeAccountCallsKey('u', NOON);
    assert.notEqual(prefixed, bare);
    assert.ok(prefixed.startsWith('preview:abcdef12:'), `got ${prefixed}`);
    assert.ok(freeAccountRequestsKey('u', NOON).startsWith('preview:abcdef12:'));
    assert.ok(freeAccountLastActivityKey('u', NOON).startsWith('preview:abcdef12:'));
  });

  it('sets a day-bounded TTL that survives to UTC midnight plus slack', async () => {
    const store = new Map();
    const ttls = new Map();
    const nearMidnight = Date.UTC(2026, 7, 17, 23, 59, 59);
    const pipe = memoryPipeline(store, { ttls, clock: { now: nearMidnight } });
    await reserveFreeAccountAllowance('u12', pipe, nearMidnight);
    const callsExpiry = ttls.get(freeAccountCallsKey('u12', nearMidnight));
    const requestsExpiry = ttls.get(freeAccountRequestsKey('u12', nearMidnight));
    assert.ok(callsExpiry !== undefined, 'calls key must carry a TTL');
    assert.equal(requestsExpiry, callsExpiry, 'both counters must share the end-of-day TTL');
    const ttlSeconds = (callsExpiry - nearMidnight) / 1000;
    // 1s to midnight + 1h slack, floored at 60s.
    assert.ok(ttlSeconds >= 60, `ttl ${ttlSeconds} must clear the 60s floor`);
    assert.ok(ttlSeconds <= 3602, `ttl ${ttlSeconds} must not linger past the slack window`);
  });
});
