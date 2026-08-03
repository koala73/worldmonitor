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
 *   - `limit` is the caller's PLAN-resolved allowance (plan 2026-07-25-001 U3b),
 *     normalised through the same `resolveDailyLimit` the enforcement path uses,
 *     and `used` is clamped to THAT limit — not to the hardcoded 50. A Pro
 *     Business caller at 120/250 must never read "50 / 50" here while
 *     enforcement serves them fine.
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

/** Catalog-shaped planLimits block; only mcpCallsPerDay is load-bearing here. */
function limits(mcpCallsPerDay) {
  return {
    apiRequestsPerDay: 0,
    apiBurstRequestsPerMinute: 0,
    mcpCallsPerDay,
    mcpBurstRequestsPerMinute: 60,
  };
}

/** Entitlement fixture. `planLimits === undefined` = legacy pre-catalog row. */
function entitlement(planKey, planLimits) {
  return {
    planKey,
    features: {
      tier: 1,
      mcpAccess: true,
      ...(planLimits === undefined ? {} : { planLimits }),
    },
    validUntil: Date.now() + 86_400_000,
  };
}

function makeDeps(overrides = {}) {
  // Deterministic UTC time anchor: 2026-05-10T12:34:56Z. resetsAt should
  // therefore be 2026-05-11T00:00:00.000Z.
  const FIXED_NOW = new Date(Date.UTC(2026, 4, 10, 12, 34, 56, 0));
  return {
    resolveUserId: async () => 'user_pro_123',
    redisGet: async () => null,
    // Default fixture is a LEGACY row (no planLimits) so every pre-U3b
    // assertion in this file keeps pinning the 50/day fallback.
    getEntitlements: async () => entitlement('pro_monthly', undefined),
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

// ---------------------------------------------------------------------------
// U3b — the displayed limit is the caller's PLAN limit
//
// Enforcement went plan-driven in U3 (`reserveQuota` + `resolveDailyLimit`);
// this reader stayed on the hardcoded `PRO_DAILY_QUOTA_LIMIT`. The pairing
// below is the contract: whatever `resolveDailyLimit` would enforce is what
// the settings widget must show, and `used` is clamped to THAT number.
// ---------------------------------------------------------------------------
describe('mcp-quota handler — plan-resolved limit (U3b)', () => {
  it('reports the Pro Business allowance (250) with usage unclamped below it', async () => {
    const deps = makeDeps({
      getEntitlements: async () => entitlement('pro_business_monthly', limits(250)),
      redisGet: async () => '120',
    });
    const resp = await quotaHandler(makeReq(), deps);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.limit, 250, 'Pro Business reads its own 250/day allowance');
    assert.equal(body.used, 120, 'usage must not be clamped to the 50/day default');
  });

  it('clamps used to the PLAN limit, not to the 50/day default', async () => {
    const deps = makeDeps({
      getEntitlements: async () => entitlement('pro_business_monthly', limits(250)),
      redisGet: async () => '999',
    });
    const body = await (await quotaHandler(makeReq(), deps)).json();
    assert.equal(body.limit, 250);
    assert.equal(body.used, 250, 'clamp target is the resolved limit');
  });

  it('represents an unlimited plan (mcpCallsPerDay: null) as limit: null with no clamp', async () => {
    const deps = makeDeps({
      getEntitlements: async () => entitlement('enterprise', limits(null)),
      redisGet: async () => '4321',
    });
    const body = await (await quotaHandler(makeReq(), deps)).json();
    assert.equal(body.limit, null, 'null = unlimited, same wire meaning as the catalog');
    assert.equal(body.used, 4321, 'unlimited plans are never clamped');
  });

  it('honours a real zero allowance verbatim (0 is a limit, not a missing one)', async () => {
    const deps = makeDeps({
      getEntitlements: async () => entitlement('free', limits(0)),
      redisGet: async () => '3',
    });
    const body = await (await quotaHandler(makeReq(), deps)).json();
    assert.equal(body.limit, 0);
    assert.equal(body.used, 0);
  });

  it('displays 50 for an API-tier plan, not its catalog MCP allowance (display == enforcement)', async () => {
    // Enforcement caps API-tier entitlements at the 50/day default on BOTH
    // credential paths (resolvePlanDrivenMcpAllowance); showing api_starter's
    // 1000 here would advertise a limit the meter never applies.
    const deps = makeDeps({
      getEntitlements: async () => entitlement('api_starter', limits(1000)),
      redisGet: async () => '48',
    });
    const body = await (await quotaHandler(makeReq(), deps)).json();
    assert.equal(body.limit, 50, 'API-tier catalog allowance must not leak into the display');
    assert.equal(body.used, 48);
  });

  it('falls back to 50 for a legacy entitlement row with no planLimits', async () => {
    const deps = makeDeps({
      getEntitlements: async () => entitlement('pro_monthly', undefined),
      redisGet: async () => '7',
    });
    const body = await (await quotaHandler(makeReq(), deps)).json();
    assert.equal(body.limit, 50, 'legacy shape keeps the historical default');
    assert.equal(body.used, 7);
  });

  it('falls back to 50 for a malformed allowance (stringified number)', async () => {
    const deps = makeDeps({
      getEntitlements: async () => entitlement('pro_business_monthly', limits('250')),
      redisGet: async () => '73',
    });
    const body = await (await quotaHandler(makeReq(), deps)).json();
    assert.equal(body.limit, 50, 'an unreadable limit must never buy a HIGHER cap');
    assert.equal(body.used, 50);
  });

  it('falls back to 50 when the entitlement lookup throws (never 500 the widget)', async () => {
    const deps = makeDeps({
      getEntitlements: async () => { throw new Error('convex down'); },
      redisGet: async () => '12',
    });
    const resp = await quotaHandler(makeReq(), deps);
    assert.equal(resp.status, 200, 'a lookup blip must not break a working endpoint');
    const body = await resp.json();
    assert.equal(body.limit, 50);
    assert.equal(body.used, 12);
  });

  it('falls back to 50 when the entitlement lookup returns null', async () => {
    const deps = makeDeps({
      getEntitlements: async () => null,
      redisGet: async () => '5',
    });
    const body = await (await quotaHandler(makeReq(), deps)).json();
    assert.equal(body.limit, 50);
    assert.equal(body.used, 5);
  });

  it('resolves the limit for the SESSION userId only (no client override)', async () => {
    let observedUserId = '';
    const deps = makeDeps({
      resolveUserId: async () => 'user_clerk_xyz',
      getEntitlements: async (uid) => {
        observedUserId = uid;
        return entitlement('pro_business_monthly', limits(250));
      },
      redisGet: async () => '1',
    });
    const resp = await quotaHandler(makeReq(), deps);
    assert.equal(resp.status, 200);
    assert.equal(observedUserId, 'user_clerk_xyz');
  });

  it('does not look up entitlements for an unauthenticated caller', async () => {
    let lookups = 0;
    const deps = makeDeps({
      resolveUserId: async () => null,
      getEntitlements: async () => { lookups += 1; return null; },
    });
    const resp = await quotaHandler(makeReq({ auth: false }), deps);
    assert.equal(resp.status, 401);
    assert.equal(lookups, 0, '401 short-circuits before any backend read');
  });

  it('client normaliser keeps the wire meaning of null/0 (settings widget end)', async () => {
    // The endpoint can now answer `limit: null`. The consumer used to coerce
    // any non-positive limit to 50, which would have put "50 / 50" back in
    // front of the exact users this unit exists to fix.
    const { normalizeQuotaLimit } = await import('../src/services/mcp-clients.ts');
    assert.equal(normalizeQuotaLimit(null), null, 'null = unlimited must survive');
    assert.equal(normalizeQuotaLimit(250), 250);
    assert.equal(normalizeQuotaLimit(0), 0, '0 is a real allowance, not a missing one');
    assert.equal(normalizeQuotaLimit(undefined), 50, 'absent field → plan default');
    assert.equal(normalizeQuotaLimit(-1), 50);
    assert.equal(normalizeQuotaLimit(Number.NaN), 50);
  });

  it('reuses api/mcp/quota.ts resolveDailyLimit — no second copy of the normalisation', async () => {
    // Drift guard: if the reader ever grows its own copy of the three-way
    // contract, this import breaks or the pairing below diverges.
    const { resolveDailyLimit } = await import('../api/mcp/quota.ts');
    for (const [planLimit, expected] of [
      [250, 250],
      [null, null],
      [0, 0],
      [undefined, 50],
      ['250', 50],
      [Number.NaN, 50],
      [-1, 50],
    ]) {
      assert.equal(
        resolveDailyLimit(planLimit),
        expected,
        `resolveDailyLimit(${String(planLimit)}) must resolve to ${String(expected)}`,
      );
      const deps = makeDeps({
        getEntitlements: async () => entitlement('p', limits(planLimit)),
        redisGet: async () => '1',
      });
      const body = await (await quotaHandler(makeReq(), deps)).json();
      assert.equal(
        body.limit,
        expected,
        `endpoint limit must equal the enforced limit for ${String(planLimit)}`,
      );
    }
  });
});
