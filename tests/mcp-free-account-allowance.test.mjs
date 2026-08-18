/**
 * #6716 — free-account allowance meter.
 *
 * Split out of tests/mcp-paid-funnel.test.mjs because the meter needs a Redis
 * mock with real semantics (TTL-aware `SET NX EX`, per-element errors,
 * selectively failing commands) rather than the always-succeeds stub the
 * denial-copy assertions get by with. Every failure branch in
 * `reserveFreeAccountAllowance` is reachable from here; the previous harness
 * could only reach the first of four.
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
 * Models the three behaviours the meter actually depends on:
 *   - `SET key val EX <s> NX` returns 'OK' for the winner and null when a live
 *     key already exists. This is the window claim; a mock that always returns
 *     'OK' would make the concurrency and idle-gap tests vacuous.
 *   - TTL expiry against a caller-supplied clock, so the idle-gap boundary is
 *     observable without sleeping.
 *   - Per-element `{error}` replies, which is how Upstash reports a partial
 *     pipeline failure — the shape that used to slip past the meter unnoticed.
 *
 * `opts.failOn(cmd, key, callIndex)` returns 'throw' | 'error' | undefined so a
 * test can fail one specific command and leave the rest working.
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
    const out = [];
    for (const op of ops) {
      const [cmd, key] = op;
      const mode = opts.failOn?.(cmd, key, callIndex);
      callIndex += 1;
      if (mode === 'throw') throw new Error(`redis down: ${cmd}`);
      if (mode === 'error') {
        out.push({ error: `ERR simulated ${cmd} failure` });
        continue;
      }
      if (cmd === 'INCR') {
        const next = (live(key) ? Number(store.get(key)) || 0 : 0) + 1;
        store.set(key, next);
        out.push({ result: next });
      } else if (cmd === 'DECR') {
        const next = (live(key) ? Number(store.get(key)) || 0 : 0) - 1;
        store.set(key, next);
        out.push({ result: next });
      } else if (cmd === 'GET') {
        out.push({ result: live(key) ? store.get(key) : null });
      } else if (cmd === 'SET') {
        // [SET, key, value, 'EX', seconds, 'NX']
        const nx = op.includes('NX');
        if (nx && live(key)) {
          out.push({ result: null });
          continue;
        }
        const exIdx = op.indexOf('EX');
        store.set(key, op[2]);
        if (exIdx !== -1) ttls.set(key, clock.now + Number(op[exIdx + 1]) * 1000);
        out.push({ result: 'OK' });
      } else if (cmd === 'EXPIRE') {
        ttls.set(key, clock.now + Number(op[2]) * 1000);
        out.push({ result: 1 });
      } else {
        throw new Error(`unexpected ${cmd}`);
      }
    }
    return out;
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
    // The rejected INCR must be rolled back, or the counter ratchets and the
    // caller stays locked out past the point the limit alone would allow.
    assert.equal(store.get(freeAccountCallsKey('u4', NOON)), FREE_ACCOUNT_CALLS_PER_DAY);
  });

  it('enforces the three request-window ceiling and rolls the window counter back', async () => {
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

  it('clamps a counter that a lost DECR ratcheted above the limit', async () => {
    // A best-effort rollback that never lands would otherwise leave the counter
    // permanently over the ceiling — with a limit of 5, two lost DECRs is the
    // whole day's allowance. quota.ts carries this same F4 clamp.
    const store = new Map();
    const clock = { now: NOON };
    let decrFailsLeft = 1;
    const pipe = memoryPipeline(store, {
      clock,
      failOn: (cmd) => {
        if (cmd === 'DECR' && decrFailsLeft > 0) {
          decrFailsLeft -= 1;
          return 'error';
        }
        return undefined;
      },
    });
    for (let i = 0; i < FREE_ACCOUNT_CALLS_PER_DAY; i += 1) {
      clock.now = NOON + i * 1000;
      assert.equal((await reserveFreeAccountAllowance('u6', pipe, clock.now)).ok, true);
    }
    const key = freeAccountCallsKey('u6', NOON);
    // First rejection: the rollback DECR is swallowed, so the counter ratchets.
    await reserveFreeAccountAllowance('u6', pipe, NOON + 10_000);
    assert.ok(store.get(key) > FREE_ACCOUNT_CALLS_PER_DAY, 'precondition: counter ratcheted');
    // Second rejection: rollback works and the clamp pulls it back to the limit.
    await reserveFreeAccountAllowance('u6', pipe, NOON + 11_000);
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
  // The meter has four distinct pipeline round-trips. Each one must deny, and
  // must not leave the call counter charged.
  const stages = [
    { name: 'calls INCR', match: (cmd) => cmd === 'INCR' },
    { name: 'window claim SET', match: (cmd) => cmd === 'SET' },
    { name: 'requests INCR', match: (cmd, key) => cmd === 'INCR' && key.includes(':reqs:') },
    { name: 'calls EXPIRE', match: (cmd) => cmd === 'EXPIRE' },
  ];

  for (const stage of stages) {
    for (const mode of ['throw', 'error']) {
      it(`denies when the ${stage.name} ${mode === 'throw' ? 'throws' : 'reports a per-element error'}`, async () => {
        const store = new Map();
        const pipe = memoryPipeline(store, {
          clock: { now: NOON },
          failOn: (cmd, key) => (stage.match(cmd, key) ? mode : undefined),
        });
        const result = await reserveFreeAccountAllowance('u_fail', pipe, NOON);
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'redis-unavailable');
      });
    }
  }

  it('rolls the call back when a later stage fails', async () => {
    const store = new Map();
    const pipe = memoryPipeline(store, {
      clock: { now: NOON },
      failOn: (cmd, key) => (cmd === 'INCR' && key.includes(':reqs:') ? 'error' : undefined),
    });
    const result = await reserveFreeAccountAllowance('u11', pipe, NOON);
    assert.equal(result.ok, false);
    // The call slot must not stay charged for a request that never dispatched.
    assert.equal(store.get(freeAccountCallsKey('u11', NOON)), 0);
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
    const expiry = ttls.get(freeAccountCallsKey('u12', nearMidnight));
    assert.ok(expiry !== undefined, 'calls key must carry a TTL');
    const ttlSeconds = (expiry - nearMidnight) / 1000;
    // 1s to midnight + 1h slack, floored at 60s.
    assert.ok(ttlSeconds >= 60, `ttl ${ttlSeconds} must clear the 60s floor`);
    assert.ok(ttlSeconds <= 3602, `ttl ${ttlSeconds} must not linger past the slack window`);
  });
});
