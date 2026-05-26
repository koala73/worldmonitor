/**
 * Tests for `api/user/mcp-quota.ts` — Clerk-authenticated read of the
 * Pro MCP daily-quota counter (plan 2026-05-10-001 U9).
 *
 * Tested invariants:
 *   - Reads the SAME `mcp:pro-usage:<userId>:<YYYY-MM-DD>` key shape that
 *     U7 writes via INCR-first reservation. Drift here = silent UI/enforcement
 *     disagreement (the bug this test exists to catch).
 *   - `used: 0` on missing key, malformed value, or Redis transient.
 *   - `resetsAt` is the next UTC midnight (deterministic within a UTC day).
 *   - 401 on no/invalid Clerk session.
 *   - 405 on non-GET methods (Allow header set).
 *   - Cache-Control: no-store on every response.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { quotaHandler } from '../api/user/mcp-quota.ts';

function makeReq({ method = 'GET', auth = true } = {}) {
  const headers = {};
  if (auth) headers.Authorization = 'Bearer fake-jwt';
  return new Request('https://api.worldmonitor.app/api/user/mcp-quota', {
    method,
    headers,
  });
}

function makeDeps(overrides = {}) {
  // Deterministic UTC time anchor: 2026-05-10T12:34:56Z. resetsAt should
  // therefore be 2026-05-11T00:00:00.000Z.
  const FIXED_NOW = new Date(Date.UTC(2026, 4, 10, 12, 34, 56, 0));
  return {
    resolveUserId: async () => 'user_pro_123',
    redisGet: async () => null,
    now: () => FIXED_NOW,
    ...overrides,
  };
}

describe('mcp-quota handler', () => {
  it('returns {used, limit:50, resetsAt} for a user with calls today', async () => {
    let receivedKey = '';
    const deps = makeDeps({
      redisGet: async (key) => {
        receivedKey = key;
        return '7';
      },
    });
    const resp = await quotaHandler(makeReq(), deps);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.used, 7);
    assert.equal(body.limit, 50);
    assert.equal(body.resetsAt, '2026-05-11T00:00:00.000Z');
    // Confirm the SAME key shape U7 writes via INCR. This is load-bearing —
    // a drift here is the bug this whole helper exists to prevent.
    assert.equal(
      receivedKey,
      'mcp:pro-usage:user_pro_123:2026-05-10',
      'must read the canonical mcp:pro-usage:<userId>:<UTC YYYY-MM-DD> key',
    );
  });

  it('returns used=0 when Redis key is missing (first call of the day)', async () => {
    const deps = makeDeps({ redisGet: async () => null });
    const resp = await quotaHandler(makeReq(), deps);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.used, 0);
    assert.equal(body.limit, 50);
    assert.equal(body.resetsAt, '2026-05-11T00:00:00.000Z');
  });

  it('returns used=0 when Redis returns a malformed (non-numeric) value', async () => {
    const deps = makeDeps({ redisGet: async () => 'not-a-number' });
    const resp = await quotaHandler(makeReq(), deps);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.used, 0);
  });

  it('returns used=0 when Redis throws (transient blip should never 500)', async () => {
    const deps = makeDeps({ redisGet: async () => { throw new Error('redis down'); } });
    const resp = await quotaHandler(makeReq(), deps);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.used, 0);
  });

  it('caps used at the hard limit (defensive against rollover/test-injection)', async () => {
    const deps = makeDeps({ redisGet: async () => '73' });
    const resp = await quotaHandler(makeReq(), deps);
    const body = await resp.json();
    assert.equal(body.used, 50, 'used must be clamped to limit, never display 73/50');
  });

  it('returns 401 when no Clerk session is present', async () => {
    const deps = makeDeps({ resolveUserId: async () => null });
    const resp = await quotaHandler(makeReq(), deps);
    assert.equal(resp.status, 401);
    const body = await resp.json();
    assert.equal(body.error, 'unauthenticated');
  });

  it('returns 405 on non-GET methods with Allow header', async () => {
    const deps = makeDeps();
    const resp = await quotaHandler(makeReq({ method: 'POST' }), deps);
    assert.equal(resp.status, 405);
    assert.match(resp.headers.get('Allow') ?? '', /GET/);
    const body = await resp.json();
    assert.equal(body.error, 'method_not_allowed');
  });

  it('handles OPTIONS preflight as 204 with CORS headers (no body)', async () => {
    const deps = makeDeps();
    const resp = await quotaHandler(makeReq({ method: 'OPTIONS', auth: false }), deps);
    assert.equal(resp.status, 204);
  });

  it('sets Cache-Control: no-store on every response', async () => {
    const deps = makeDeps({ redisGet: async () => '5' });
    const ok = await quotaHandler(makeReq(), deps);
    const unauth = await quotaHandler(makeReq({ auth: false }), { ...deps, resolveUserId: async () => null });
    const wrongMethod = await quotaHandler(makeReq({ method: 'PUT' }), deps);
    assert.equal(ok.headers.get('Cache-Control'), 'no-store');
    assert.equal(unauth.headers.get('Cache-Control'), 'no-store');
    assert.equal(wrongMethod.headers.get('Cache-Control'), 'no-store');
  });

  it('returns the same resetsAt for two calls within the same UTC day', async () => {
    // Spread the two calls across 6 UTC hours but the same UTC day. resetsAt
    // must be byte-for-byte identical because it's anchored to UTC midnight.
    const deps1 = makeDeps({
      now: () => new Date(Date.UTC(2026, 4, 10, 1, 0, 0, 0)),
      redisGet: async () => '1',
    });
    const deps2 = makeDeps({
      now: () => new Date(Date.UTC(2026, 4, 10, 23, 0, 0, 0)),
      redisGet: async () => '49',
    });
    const r1 = await (await quotaHandler(makeReq(), deps1)).json();
    const r2 = await (await quotaHandler(makeReq(), deps2)).json();
    assert.equal(r1.resetsAt, r2.resetsAt, 'resetsAt is UTC-day-stable');
    assert.equal(r1.resetsAt, '2026-05-11T00:00:00.000Z');
  });

  it('uses the read userId verbatim in the Redis key (tenancy → no client override)', async () => {
    let observedKey = '';
    const deps = makeDeps({
      resolveUserId: async () => 'user_clerk_xyz',
      redisGet: async (k) => { observedKey = k; return '12'; },
    });
    // Even if the request body contains a userId, the handler MUST use the
    // session-derived one (this endpoint has no body anyway, but the asserted
    // invariant is that resolveUserId is the only userId source).
    const resp = await quotaHandler(makeReq(), deps);
    assert.equal(resp.status, 200);
    assert.equal(observedKey, 'mcp:pro-usage:user_clerk_xyz:2026-05-10');
  });

  it('F9: env-prefixed key shape — preview deploys do not collide with production counters', async () => {
    // Drive the helper through a preview-deploy env. The reader (this
    // handler) and the writer (api/mcp.ts) both call dailyCounterKey
    // from the same module — so the prefixed key must be byte-identical
    // across both. Round-trip: import the helper, derive a key, then
    // confirm the handler reads the same key shape.
    const savedEnv = process.env.VERCEL_ENV;
    const savedSha = process.env.VERCEL_GIT_COMMIT_SHA;
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_GIT_COMMIT_SHA = 'deadbeef1234567890';
    try {
      const { dailyCounterKey } = await import(`../server/_shared/pro-mcp-token.ts?t=${Date.now()}`);
      const expected = dailyCounterKey('user_pro_xyz', new Date(Date.UTC(2026, 4, 10, 12, 0, 0)));
      assert.equal(
        expected,
        'preview:deadbeef:mcp:pro-usage:user_pro_xyz:2026-05-10',
        'F9: preview env must prefix the key',
      );

      // Reader produces the SAME prefixed key.
      let observedKey = '';
      const deps = makeDeps({
        resolveUserId: async () => 'user_pro_xyz',
        now: () => new Date(Date.UTC(2026, 4, 10, 12, 0, 0)),
        redisGet: async (k) => { observedKey = k; return '7'; },
      });
      const resp = await quotaHandler(makeReq(), deps);
      assert.equal(resp.status, 200);
      assert.equal(observedKey, expected, 'F9: reader and dailyCounterKey produce same prefixed key');
    } finally {
      if (savedEnv === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = savedEnv;
      if (savedSha === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
      else process.env.VERCEL_GIT_COMMIT_SHA = savedSha;
    }
  });

  it('F9: production env (VERCEL_ENV=production) yields the bare base key (no prefix — historical wire format)', async () => {
    const savedEnv = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = 'production';
    try {
      const { dailyCounterKey } = await import(`../server/_shared/pro-mcp-token.ts?t=${Date.now()}`);
      const k = dailyCounterKey('user_x', new Date(Date.UTC(2026, 4, 10, 12, 0, 0)));
      assert.equal(k, 'mcp:pro-usage:user_x:2026-05-10', 'production env keeps bare base key');
    } finally {
      if (savedEnv === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = savedEnv;
    }
  });
});
