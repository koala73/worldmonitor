// U3 (#3199) — per-account rate-limit module. Pipeline + UTC math tested in
// isolation with an injected mock pipeline + injected Date (no live Redis).
// Per the plan, Upstash's sliding-window math is NOT re-tested here — only our
// meter/ceiling logic and fail-open posture.
//
// Constants mirrored from the module so a prod drift fails by name rather than
// silently (matches tests/mcp-quota-concurrent.test.mjs discipline).
const STARTER_ALLOWANCE = 1000;

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  apiKeyDailyKey,
  reserveDailyMeter,
  rateLimitHeaders,
  checkBurst,
  ENTERPRISE_API_RATE_LIMIT,
} from '../server/_shared/api-key-rate-limit.ts';

// A mock pipeline that simulates an INCR/DECR counter, recording every command.
function makePipeline(initial = 0) {
  let count = initial;
  const commands: Array<Array<string | number>>[] = [];
  const pipeline = async (cmds: Array<Array<string | number>>) => {
    commands.push(cmds);
    return cmds.map((cmd) => {
      const verb = cmd[0];
      if (verb === 'INCR') return { result: (count += 1) };
      if (verb === 'DECR') return { result: (count -= 1) };
      return { result: 1 }; // EXPIRE etc.
    });
  };
  return {
    pipeline,
    commands,
    current: () => count,
  };
}

const D = (y: number, mo: number, d: number, h = 12) =>
  new Date(Date.UTC(y, mo, d, h, 0, 0));

describe('#3199 U3 — apiKeyDailyKey (UTC calendar day)', () => {
  it('formats a plain (un-prefixed) UTC-day key', () => {
    assert.equal(apiKeyDailyKey('user_1', D(2026, 5, 30)), 'rl:apikey:day:user_1:2026-06-30');
  });

  it('rolls over at UTC midnight, not before', () => {
    assert.equal(apiKeyDailyKey('u', new Date(Date.UTC(2026, 5, 30, 23, 59, 59))).endsWith('2026-06-30'), true);
    assert.equal(apiKeyDailyKey('u', new Date(Date.UTC(2026, 6, 1, 0, 0, 0))).endsWith('2026-07-01'), true);
  });

  it('returns empty for a missing userId', () => {
    assert.equal(apiKeyDailyKey(''), '');
  });
});

describe('#3199 U3 — reserveDailyMeter', () => {
  it('under the allowance: meters, does not flag, no rollback', async () => {
    const mock = makePipeline(500); // next INCR -> 501, under the 1000 allowance
    const r = await reserveDailyMeter({ userId: 'u', allowance: STARTER_ALLOWANCE, pipeline: mock.pipeline });
    assert.equal(r.count, 501);
    assert.equal(r.overLimit, false);
    assert.equal(r.metered, true);
    // INCR+EXPIRE issued, no DECR.
    assert.equal(mock.commands.length, 1);
  });

  it('over the sold allowance: flags, and rollback() floors the counter', async () => {
    const mock = makePipeline(STARTER_ALLOWANCE); // 1000 -> INCR 1001
    const r = await reserveDailyMeter({ userId: 'u', allowance: STARTER_ALLOWANCE, pipeline: mock.pipeline });
    assert.equal(r.count, 1001);
    assert.equal(r.overLimit, true);
    await r.rollback();
    assert.equal(mock.current(), 1000, 'rollback DECRs the over-limit increment');
    // rollback is idempotent
    await r.rollback();
    assert.equal(mock.current(), 1000);
  });

  it('exactly at the allowance is allowed (only strictly-over rejects)', async () => {
    const mock = makePipeline(STARTER_ALLOWANCE - 1); // -> 1000
    const r = await reserveDailyMeter({ userId: 'u', allowance: STARTER_ALLOWANCE, pipeline: mock.pipeline });
    assert.equal(r.count, 1000);
    assert.equal(r.overLimit, false);
  });

  it('unlimited allowance (-1): never touches Redis, never over-limits', async () => {
    const mock = makePipeline(999999);
    const r = await reserveDailyMeter({ userId: 'ent', allowance: -1, pipeline: mock.pipeline });
    assert.equal(r.metered, false);
    assert.equal(r.overLimit, false);
    assert.equal(mock.commands.length, 0, 'no pipeline call for unlimited');
  });

  it('allowance 0 (misconfig): fails open, never meters or ceilings (no brick)', async () => {
    const mock = makePipeline(0);
    const r = await reserveDailyMeter({ userId: 'u', allowance: 0, pipeline: mock.pipeline });
    assert.equal(r.metered, false);
    assert.equal(r.overLimit, false);
    assert.equal(mock.commands.length, 0, 'allowance 0 must not ceiling-429 request #1');
  });

  it('fail-open when Redis returns empty (outage): metered:false, served', async () => {
    const downPipeline = async () => [];
    const r = await reserveDailyMeter({ userId: 'u', allowance: STARTER_ALLOWANCE, pipeline: downPipeline });
    assert.equal(r.metered, false);
    assert.equal(r.overLimit, false);
  });

  it('fail-open when the pipeline throws', async () => {
    const throwingPipeline = async () => {
      throw new Error('redis exploded');
    };
    const r = await reserveDailyMeter({ userId: 'u', allowance: STARTER_ALLOWANCE, pipeline: throwingPipeline });
    assert.equal(r.metered, false);
    assert.equal(r.overLimit, false);
  });

  it('per-account: the metered key is the userId-scoped daily key', async () => {
    const mock = makePipeline(0);
    const date = D(2026, 5, 30);
    await reserveDailyMeter({ userId: 'acct_42', allowance: STARTER_ALLOWANCE, pipeline: mock.pipeline, date });
    const incrCmd = mock.commands[0][0];
    assert.deepEqual(incrCmd, ['INCR', apiKeyDailyKey('acct_42', date)]);
  });

  it('retryAfterSec points at the next UTC midnight', async () => {
    const date = new Date(Date.UTC(2026, 5, 30, 23, 0, 0)); // 1h before midnight
    const r = await reserveDailyMeter({ userId: 'u', allowance: STARTER_ALLOWANCE, pipeline: makePipeline(0).pipeline, date });
    assert.equal(r.retryAfterSec, 3600);
  });
});

describe('#3199 U3 — burst limiter fail-open + headers', () => {
  it('checkBurst fails open (ok:true) when Upstash is not configured', async () => {
    const prevUrl = process.env.UPSTASH_REDIS_REST_URL;
    const prevToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    try {
      const r = await checkBurst(60, 'acct_1');
      assert.deepEqual(r, { ok: true });
    } finally {
      if (prevUrl !== undefined) process.env.UPSTASH_REDIS_REST_URL = prevUrl;
      if (prevToken !== undefined) process.env.UPSTASH_REDIS_REST_TOKEN = prevToken;
    }
  });

  it('rateLimitHeaders emits the standard X-RateLimit-* + Retry-After set', () => {
    const h = rateLimitHeaders({ limit: 60, remaining: 0, resetMs: 1_900_000_000_000, retryAfterSec: 42 });
    assert.equal(h['X-RateLimit-Limit'], '60');
    assert.equal(h['X-RateLimit-Remaining'], '0');
    assert.equal(h['X-RateLimit-Reset'], '1900000000000');
    assert.equal(h['Retry-After'], '42');
  });

  it('rateLimitHeaders emits IETF RateLimit fields with a delta-seconds reset', () => {
    const now = Date.now();
    const h = rateLimitHeaders({ limit: 60, remaining: 7, resetMs: now + 30_000, retryAfterSec: 30, windowSec: 60 });
    // RateLimit-Policy advertises the quota + window (structured-field syntax).
    assert.equal(h['RateLimit-Policy'], '"default";q=60;w=60');
    assert.equal(h['RateLimit-Limit'], '60');
    assert.equal(h['RateLimit-Remaining'], '7');
    // IETF reset is DELTA-seconds (~30), not the epoch-ms carried by X-RateLimit-Reset.
    const resetSec = Number(h['RateLimit-Reset']);
    assert.ok(resetSec >= 29 && resetSec <= 31, `RateLimit-Reset should be ~30s, got ${resetSec}`);
    assert.equal(h.RateLimit, `"default";r=7;t=${resetSec}`);
  });

  it('rateLimitHeaders defaults the advertised window to 60s', () => {
    const h = rateLimitHeaders({ limit: 600, remaining: 0, resetMs: Date.now() + 1000, retryAfterSec: 1 });
    assert.equal(h['RateLimit-Policy'], '"default";q=600;w=60');
  });

  it('Retry-After floors at 1 second', () => {
    assert.equal(rateLimitHeaders({ limit: 60, remaining: 0, resetMs: 0, retryAfterSec: 0 })['Retry-After'], '1');
  });

  it('enterprise per-minute constant matches the catalog (1000)', () => {
    assert.equal(ENTERPRISE_API_RATE_LIMIT, 1000);
  });
});
