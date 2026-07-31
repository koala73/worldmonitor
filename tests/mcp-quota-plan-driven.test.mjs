// Plan-driven MCP daily quota (plan 2026-07-25-001 U3 / KTD6).
//
// Until this unit the daily cap was the hardcoded `PRO_DAILY_QUOTA_LIMIT = 50`
// for every metered caller. Pro Business (250/day) makes the cap a property of
// the PLAN, resolved from the entitlement `features.planLimits.mcpCallsPerDay`
// that `checkMcpEntitlementGate` already fetches, and threaded into
// `reserveQuota` — no second Convex round-trip on the hot path.
//
// The three-way limit contract this file pins:
//   undefined / missing / malformed  → 50 (legacy default; cost-protection
//                                     direction, request still served)
//   null                             → unlimited (no rejection branch, but the
//                                     counter still INCRs so metering is intact)
//   number                           → enforced as-is, and INTERPOLATED into the
//                                     -32029 message so a regression back to the
//                                     hardcoded constant can't hide
//
// KTD6 boundary: plan-driven limits reach the `pro` context ONLY — and the
// boundary is a PLAN boundary, not a credential boundary. A `user_key` caller
// keeps the hardcoded 50/day whatever their plan says, AND an API-tier
// entitlement arriving through the pro (OAuth) door keeps 50 too: API-tier
// subscribers satisfy the pro-token mint gate (tier>=1 + mcpAccess), so
// without `resolvePlanDrivenMcpAllowance` their 1000/10000 catalog allowance
// would leak through the door their `user_key` is capped behind. Raising
// API-plan MCP allowances is a deliberate follow-up, not a side effect of
// this unit. The API-tier cases below and the last describe block are the
// witnesses for that.
//
// Why a sibling file rather than an insert into tests/mcp.test.mjs: the quota
// surface already splits its concerns this way (mcp-quota-concurrent.test.mjs,
// mcp-quota-no-refund.test.mjs), and each of those is independently runnable at
// a fraction of the 3k-line suite's cost.

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  BASE_URL,
  HMAC_SECRET,
  makePipelineMock,
  makeProDeps,
  proReq,
  callBody,
} from './helpers/mcp-pro-deps.mjs';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

const USER_KEY = `wm_${'ab12'.repeat(10)}`;
const USER_KEY_USER_ID = 'user_apibusiness_abc';

/** Entitlement fixture: passes the mcpAccess gate, carries the given plan limits. */
function entitlement(planKey, planLimits, features = {}) {
  return {
    planKey,
    features: {
      tier: 1,
      mcpAccess: true,
      ...(planLimits === undefined ? {} : { planLimits }),
      ...features,
    },
    validUntil: Date.now() + 86_400_000,
  };
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

/** Cache reads return non-null so the `cache_all_null` guard can't fire first. */
function stubCacheHit() {
  globalThis.fetch = async () => new Response(
    JSON.stringify({ result: JSON.stringify({ ok: 1 }) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function userKeyReq(body) {
  return new Request(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': USER_KEY },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// reserveQuota — the limit contract at the unit boundary
// ---------------------------------------------------------------------------

describe('api/mcp/quota.ts — reserveQuota honours the resolved plan limit', () => {
  let reserveQuota;
  let PRO_DAILY_QUOTA_LIMIT;

  beforeEach(async () => {
    ({ reserveQuota } = await import(`../api/mcp/quota.ts?t=${Date.now()}-${Math.random()}`));
    ({ PRO_DAILY_QUOTA_LIMIT } = await import('../server/_shared/pro-mcp-token.ts'));
  });

  it('no limit argument → the legacy 50/day default still applies', async () => {
    assert.equal(PRO_DAILY_QUOTA_LIMIT, 50, 'the demoted constant is still the default');
    const pipe = makePipelineMock({ initialCount: 50 });
    const res = await reserveQuota('u1', pipe.pipeline);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'cap-exceeded');
    assert.equal(res.floor, 50, 'floor reports the enforced limit');
  });

  it('numeric limit 250 → the 250th call reserves, the 251st is capped at 250', async () => {
    const under = makePipelineMock({ initialCount: 249 });
    const ok = await reserveQuota('u1', under.pipeline, 250);
    assert.equal(ok.ok, true, '250th call must reserve');
    assert.equal(under.count, 250);

    const over = makePipelineMock({ initialCount: 250 });
    const rejected = await reserveQuota('u1', over.pipeline, 250);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, 'cap-exceeded');
    assert.equal(rejected.floor, 250, 'floor is the PLAN limit, not the constant');
    assert.equal(over.count, 250, 'the rejected INCR is rolled back to the floor');
  });

  it('numeric limit 250 → a call at count 50 is NOT rejected (the constant is no longer the cap)', async () => {
    const pipe = makePipelineMock({ initialCount: 50 });
    const res = await reserveQuota('u1', pipe.pipeline, 250);
    assert.equal(res.ok, true, 'a Pro Business caller must sail past the old 50 cap');
    assert.equal(pipe.count, 51);
  });

  it('null limit → unlimited: never rejects, but STILL increments the counter (metering intact)', async () => {
    const pipe = makePipelineMock({ initialCount: 100_000 });
    const res = await reserveQuota('u1', pipe.pipeline, null);
    assert.equal(res.ok, true, 'null means unlimited — no cap-exceeded branch at any count');
    assert.equal(pipe.count, 100_001, 'unlimited must not mean unmetered');
  });

  it('malformed limits fall back to 50 (cost-protection direction, never the higher value)', async () => {
    for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -5, '250', {}]) {
      const pipe = makePipelineMock({ initialCount: 50 });
      const res = await reserveQuota('u1', pipe.pipeline, bad);
      assert.equal(res.ok, false, `limit ${String(bad)} must fall back to the 50 default`);
      assert.equal(res.floor, 50, `limit ${String(bad)} must not raise the cap`);
    }
  });

  it('limit 0 is honoured verbatim — a zero allowance rejects the first call', async () => {
    const pipe = makePipelineMock({ initialCount: 0 });
    const res = await reserveQuota('u1', pipe.pipeline, 0);
    assert.equal(res.ok, false, '0 is a real allowance, not a missing one');
    assert.equal(res.floor, 0);
  });

  it('F4 overshoot clamp converges on the PLAN limit, not on 50', async () => {
    // Counter stuck 30 above a 250 cap (failed DECR rollbacks). One over-cap
    // call must drive it back to exactly 250 — clamping to 50 would wrongly
    // hand the user 200 free calls.
    const pipe = makePipelineMock({ initialCount: 280 });
    const res = await reserveQuota('u1', pipe.pipeline, 250);
    assert.equal(res.ok, false);
    assert.equal(pipe.count, 250, 'clamp target is the resolved plan limit');
  });
});

// ---------------------------------------------------------------------------
// End-to-end through mcpHandler — the pro context
// ---------------------------------------------------------------------------

describe('api/mcp.ts — plan-driven daily quota on the pro context', () => {
  let mcpHandler;

  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'wm_test_key_plan_driven_quota';
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    const mod = await import(`../api/mcp.ts?t=${Date.now()}-${Math.random()}`);
    mcpHandler = mod.mcpHandler;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  /** Enable Upstash + a cache hit so a reserved call actually completes 200. */
  function enableSuccessPath() {
    process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'stub';
    stubCacheHit();
  }

  it('AE6: pro_business at 249 calls → the 250th succeeds and the counter lands at 250', async () => {
    enableSuccessPath();
    const { deps, pipe } = makeProDeps({
      pipelineOpts: { initialCount: 249 },
      getEntitlements: async () => entitlement('pro_business_monthly', limits(250)),
    });
    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);
    assert.equal(res.status, 200, 'a Pro Business caller must not be capped at 50');
    assert.equal(pipe.count, 250);
  });

  it('AE6: pro_business at 250 calls → 251st is 429 -32029 and the message interpolates 250', async () => {
    const { deps, pipe } = makeProDeps({
      pipelineOpts: { initialCount: 250 },
      getEntitlements: async () => entitlement('pro_business_annual', limits(250)),
    });
    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);
    assert.equal(res.status, 429);
    assert.ok(res.headers.get('Retry-After'), 'quota rejections carry Retry-After');
    const body = await res.json();
    assert.equal(body.error?.code, -32029);
    assert.match(
      body.error.message,
      /\(250\/day\)/,
      `message must quote the ENFORCED limit, got: ${body.error?.message}`,
    );
    assert.doesNotMatch(body.error.message, /\(50\/day\)/, 'the hardcoded constant must not leak into the copy');
    assert.equal(pipe.count, 250, 'rejected reservation rolled back to the floor');
  });

  it('regression: a pro entitlement is still capped at 50 with the existing message', async () => {
    const { deps, pipe } = makeProDeps({
      pipelineOpts: { initialCount: 50 },
      getEntitlements: async () => entitlement('pro_monthly', limits(50)),
    });
    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.error?.code, -32029);
    assert.equal(
      body.error.message,
      'Daily MCP quota exceeded (50/day). Resets at next UTC midnight.',
      'Pro copy is unchanged byte-for-byte',
    );
    assert.equal(pipe.count, 50);
  });

  it('enterprise (mcpCallsPerDay: null) → unlimited: the 60th call is served and still metered', async () => {
    enableSuccessPath();
    const { deps, pipe } = makeProDeps({
      pipelineOpts: { initialCount: 59 },
      getEntitlements: async () => entitlement('enterprise', limits(null), { tier: 3 }),
    });
    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);
    assert.equal(res.status, 200, 'a null allowance must skip the rejection branch entirely');
    assert.equal(pipe.count, 60, 'unlimited is not unmetered — the counter still moves');
  });

  it('SECURITY: api_starter on the PRO context is capped at 50, not its 1000 catalog allowance', async () => {
    const { deps, pipe } = makeProDeps({
      pipelineOpts: { initialCount: 50 },
      getEntitlements: async () => entitlement('api_starter', limits(1000), { tier: 2 }),
    });
    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);
    assert.equal(res.status, 429, 'API-tier catalog allowances must not leak through the OAuth door');
    const body = await res.json();
    assert.equal(body.error?.code, -32029);
    assert.match(body.error.message, /\(50\/day\)/, 'the enforced limit is the hardcoded default, not the plan value');
    assert.equal(pipe.count, 50);
  });

  it('SECURITY: api_business on the PRO context is capped at 50, not its 10000 catalog allowance', async () => {
    const { deps, pipe } = makeProDeps({
      pipelineOpts: { initialCount: 50 },
      getEntitlements: async () => entitlement('api_business', limits(10_000), { tier: 2 }),
    });
    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);
    assert.equal(res.status, 429);
    assert.equal(pipe.count, 50);
  });

  it('entitlement with no planLimits → default 50: request served under the cap, no throw', async () => {
    enableSuccessPath();
    const { deps, pipe } = makeProDeps({
      pipelineOpts: { initialCount: 10 },
      getEntitlements: async () => entitlement('pro_monthly', undefined),
    });
    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);
    assert.equal(res.status, 200);
    assert.equal(pipe.count, 11);
  });

  it('entitlement with no planLimits → default 50 still CAPS at 51 (never fails open to unlimited)', async () => {
    const { deps } = makeProDeps({
      pipelineOpts: { initialCount: 50 },
      getEntitlements: async () => entitlement('pro_monthly', undefined),
    });
    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);
    assert.equal(res.status, 429, 'a legacy entitlement row must not become unlimited');
    const body = await res.json();
    assert.match(body.error.message, /\(50\/day\)/);
  });

  it('planLimits present but mcpCallsPerDay missing → default 50, request still served', async () => {
    enableSuccessPath();
    const { deps, pipe } = makeProDeps({
      pipelineOpts: { initialCount: 10 },
      getEntitlements: async () => entitlement('pro_monthly', {
        apiRequestsPerDay: 0,
        apiBurstRequestsPerMinute: 0,
        mcpBurstRequestsPerMinute: 60,
      }),
    });
    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);
    assert.equal(res.status, 200, 'a partial planLimits block must degrade, never throw');
    assert.equal(pipe.count, 11);
  });

  it('the entitlement gate is consulted exactly ONCE per request (no second hot-path fetch)', async () => {
    enableSuccessPath();
    let calls = 0;
    const { deps } = makeProDeps({
      getEntitlements: async () => {
        calls += 1;
        return entitlement('pro_business_monthly', limits(250));
      },
    });
    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);
    assert.equal(res.status, 200);
    assert.equal(calls, 1, 'the limit rides on the pre-check fetch — a second lookup is a hot-path regression');
  });
});

// ---------------------------------------------------------------------------
// KTD6 boundary — user_key keeps the hardcoded cap regardless of plan
// ---------------------------------------------------------------------------

describe('api/mcp.ts — KTD6: plan-driven limits do NOT reach the user_key context', () => {
  let mcpHandler;

  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'wm_env_operator_key_999';
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    const mod = await import(`../api/mcp.ts?t=${Date.now()}-${Math.random()}`);
    mcpHandler = mod.mcpHandler;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  function apiBusinessUserKeyDeps(pipelineOpts) {
    return makeProDeps({
      pipelineOpts,
      validateUserApiKey: async (key) => (key === USER_KEY ? { userId: USER_KEY_USER_ID } : null),
      // api_business advertises 10_000 MCP calls/day. If the plan-driven limit
      // leaked into this context the caller would sail past 50 — that is the
      // deliberate follow-up KTD6 defers, not this unit's behaviour.
      getEntitlements: async () => entitlement('api_business', limits(10_000), { tier: 2 }),
    });
  }

  it('api_business-owned user key at 50 calls → 51st still rejected at 50/day', async () => {
    const { deps, pipe } = apiBusinessUserKeyDeps({ initialCount: 50 });
    const res = await mcpHandler(userKeyReq(callBody('get_market_data')), deps);
    assert.equal(res.status, 429, 'user_key keeps the hardcoded cap whatever the plan says');
    const body = await res.json();
    assert.equal(body.error?.code, -32029);
    assert.match(body.error.message, /\(50\/day\)/, 'and the copy reports the enforced 50');
    assert.equal(pipe.count, 50);
  });

  it('api_business-owned user key at 10 calls → served (sanity: the cap, not the plan, is what rejects)', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'stub';
    stubCacheHit();
    const { deps, pipe } = apiBusinessUserKeyDeps({ initialCount: 10 });
    const res = await mcpHandler(userKeyReq(callBody('get_market_data')), deps);
    assert.equal(res.status, 200);
    assert.equal(pipe.count, 11);
  });
});
