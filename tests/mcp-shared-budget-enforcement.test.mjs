// Regressions for the two P1s found on PR #7514.
//
// Both are about the same mistake in different places: reading the shared REST
// budget as one decision when it is two. WHICH NUMBER a plan sold and WHERE it
// is counted move independently — the flag only ever changes the counter — and
// collapsing them onto a single `scope` field is what published 1,000/day while
// enforcing 50.
import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { budgetCounterKey, resolveMcpBudget, SHARED_API_BUDGET } from '../api/mcp/quota.ts';
import { TOOL_REGISTRY, toolWeight } from '../api/mcp/registry/index.ts';
import { mergeEntitlementFeatures } from '../convex/lib/entitlements.ts';
import { PRODUCT_CATALOG } from '../convex/config/productCatalog.ts';
import { apiKeyDailyKey } from '../server/_shared/api-key-rate-limit.ts';
import { dailyCounterKey, envPrefix } from '../server/_shared/pro-mcp-token.ts';
import {
  HMAC_SECRET,
  makePipelineMock,
  makeProDeps,
  proReq,
  callBody,
} from './helpers/mcp-pro-deps.mjs';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

afterEach(() => {
  Object.keys(process.env).forEach((k) => {
    if (!(k in originalEnv)) delete process.env[k];
  });
  Object.assign(process.env, originalEnv);
});

describe('shared budget: the flag moves the COUNTER, never the number sold', () => {
  beforeEach(() => {
    delete process.env.API_RATE_LIMIT_ENFORCE;
  });

  it('SHADOW: the sold 1,000 is enforced, on the dedicated counter', () => {
    // In shadow the gateway serves over-allowance REST requests and leaves the
    // increments on the shared key, so it climbs past the limit. Charging MCP
    // against it would 429 the heaviest accounts on day one — for accounts
    // running 2,700 REST/day, from mid-morning until UTC midnight. That is a
    // reason to move the counter, and only the counter: parking the plan on
    // PRO_DAILY_QUOTA_LIMIT enforced 50 against a published 1,000.
    assert.deepEqual(
      resolveMcpBudget(SHARED_API_BUDGET, 1000, false),
      { allowance: 'api', counter: 'mcp', limit: 1000 },
    );
  });

  it('ENFORCED: the same number, now on the shared REST counter', () => {
    assert.deepEqual(
      resolveMcpBudget(SHARED_API_BUDGET, 1000, true),
      { allowance: 'api', counter: 'api', limit: 1000 },
    );
  });

  it('api_business sells 10,000 in both flag states', () => {
    for (const [restEnforced, counter] of [[false, 'mcp'], [true, 'api']]) {
      assert.deepEqual(
        resolveMcpBudget(SHARED_API_BUDGET, 10_000, restEnforced),
        { allowance: 'api', counter, limit: 10_000 },
      );
    }
  });

  it('reads the same env flag the gateway does, at call time', () => {
    process.env.API_RATE_LIMIT_ENFORCE = 'true';
    assert.deepEqual(
      resolveMcpBudget(SHARED_API_BUDGET, 1000),
      { allowance: 'api', counter: 'api', limit: 1000 },
    );
    process.env.API_RATE_LIMIT_ENFORCE = 'false';
    assert.deepEqual(
      resolveMcpBudget(SHARED_API_BUDGET, 1000),
      { allowance: 'api', counter: 'mcp', limit: 1000 },
    );
  });

  it('an unreadable REST allowance still falls back to the plan default, never wider', () => {
    for (const bad of [undefined, Number.NaN, -1, '1000']) {
      for (const restEnforced of [true, false]) {
        assert.equal(
          resolveMcpBudget(SHARED_API_BUDGET, bad, restEnforced).limit,
          50,
          `apiRequestsPerDay ${String(bad)} must not buy a wider cap`,
        );
      }
    }
  });

  it('a dedicated-allowance plan is unaffected by the flag in either state', () => {
    for (const enforced of [true, false]) {
      assert.deepEqual(resolveMcpBudget(250, 0, enforced), { allowance: 'mcp', limit: 250 });
      assert.deepEqual(resolveMcpBudget(null, null, enforced), { allowance: 'mcp', limit: null });
    }
  });

  it('a non-sentinel string never lands on the api allowance', () => {
    // A row carrying an unrecognised marker resolves through `undefined` to the
    // plan default. Landing it on the api arm would charge per-tool weight
    // against a counter that was never sold in REST units.
    assert.deepEqual(
      resolveMcpBudget('shared-api-budgets', 10_000, true),
      { allowance: 'mcp', limit: 50 },
    );
  });
});

describe('stored entitlement rows cannot outrank the shared-budget marker', () => {
  it('a legacy api_starter row carrying the old numeric 1000 resolves to the marker', () => {
    // The row shape written before this change. A plain spread let it through,
    // so the subscriber kept a SEPARATE 1,000/day MCP counter on top of their
    // REST budget until a billing event rewrote the row.
    const merged = mergeEntitlementFeatures('api_starter', {
      tier: 2,
      maxDashboards: 25,
      apiAccess: true,
      apiRateLimit: 60,
      prioritySupport: false,
      exportFormats: ['csv', 'json', 'pdf'],
      mcpAccess: true,
      dataExport: true,
      planLimits: {
        apiRequestsPerDay: 1000,
        apiBurstRequestsPerMinute: 60,
        mcpCallsPerDay: 1000,
        dashboardAiCallsPerDay: 1000,
        mcpBurstRequestsPerMinute: 60,
      },
    });
    assert.equal(merged.planLimits.mcpCallsPerDay, SHARED_API_BUDGET);
    assert.deepEqual(
      resolveMcpBudget(merged.planLimits.mcpCallsPerDay, merged.planLimits.apiRequestsPerDay, true),
      { allowance: 'api', counter: 'api', limit: 1000 },
    );
  });

  it('api_business too, and the REST allowance still comes from the stored row', () => {
    const merged = mergeEntitlementFeatures('api_business', {
      tier: 2,
      maxDashboards: 100,
      apiAccess: true,
      apiRateLimit: 300,
      prioritySupport: true,
      exportFormats: ['csv', 'json', 'pdf'],
      mcpAccess: true,
      dataExport: true,
      planLimits: {
        apiRequestsPerDay: 10_000,
        apiBurstRequestsPerMinute: 300,
        mcpCallsPerDay: 10_000,
        dashboardAiCallsPerDay: 10_000,
        mcpBurstRequestsPerMinute: 300,
      },
    });
    assert.equal(merged.planLimits.mcpCallsPerDay, SHARED_API_BUDGET);
    assert.equal(merged.planLimits.apiRequestsPerDay, 10_000);
  });

  it('a dedicated-counter plan keeps honouring a stored per-user override', () => {
    // The override behaviour mergeEntitlementFeatures exists for must survive:
    // only the shared-budget marker is plan structure rather than preference.
    const merged = mergeEntitlementFeatures('pro_monthly', {
      ...PRODUCT_CATALOG.pro_monthly.features,
      planLimits: {
        ...PRODUCT_CATALOG.pro_monthly.features.planLimits,
        mcpCallsPerDay: 500,
      },
    });
    assert.equal(merged.planLimits.mcpCallsPerDay, 500, 'a Pro-tier override still applies');
  });
});

describe('budgetCounterKey stays in the deployment Redis namespace', () => {
  const date = new Date(Date.UTC(2026, 8, 1));
  const userId = 'user_api_starter';
  const sharedBudget = { allowance: 'api', counter: 'api', limit: 1000 };
  const shadowBudget = { allowance: 'api', counter: 'mcp', limit: 1000 };
  const mcpBudget = { allowance: 'mcp', limit: 50 };

  it('production: shared-counter key matches the unprefixed REST logical key', () => {
    process.env.VERCEL_ENV = 'production';
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    const key = budgetCounterKey(sharedBudget, userId, date);
    assert.equal(key, apiKeyDailyKey(userId, date));
    assert.equal(key, `rl:apikey:day:${userId}:2026-09-01`);
    assert.equal(envPrefix(), '');
  });

  it('preview: shared-counter key carries envPrefix so the raw MCP pipeline shares REST\'s namespaced counter', () => {
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_GIT_COMMIT_SHA = 'abcdef12deadbeef';
    const key = budgetCounterKey(sharedBudget, userId, date);
    assert.equal(key, `${envPrefix()}${apiKeyDailyKey(userId, date)}`);
    assert.equal(key, `preview:abcdef12:rl:apikey:day:${userId}:2026-09-01`);
  });

  it('an api allowance on the SHADOW counter writes the dedicated MCP key', () => {
    // The whole point of the second field: the number is the REST one, the key
    // is not. Routing this to `rl:apikey:day` would charge the shared counter
    // that shadow-mode REST has already pushed above the limit.
    process.env.VERCEL_ENV = 'production';
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    assert.equal(
      budgetCounterKey(shadowBudget, userId, date),
      `mcp:pro-usage:${userId}:2026-09-01`,
    );
  });

  it('production: dedicated MCP key stays the bare historical shape', () => {
    process.env.VERCEL_ENV = 'production';
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    const key = budgetCounterKey(mcpBudget, userId, date);
    assert.equal(key, dailyCounterKey(userId, date));
    assert.equal(key, `mcp:pro-usage:${userId}:2026-09-01`);
  });

  it('preview: dedicated MCP key already carries envPrefix (no double prefix)', () => {
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_GIT_COMMIT_SHA = 'abcdef12deadbeef';
    const key = budgetCounterKey(mcpBudget, userId, date);
    assert.equal(key, dailyCounterKey(userId, date));
    assert.equal(key, `preview:abcdef12:mcp:pro-usage:${userId}:2026-09-01`);
    assert.ok(!key.startsWith('preview:abcdef12:preview:'));
  });
});

// ---------------------------------------------------------------------------
// Weight — charged by ALLOWANCE, and only ever exercised above 1 here
// ---------------------------------------------------------------------------
// Before this file, no test in the repo drove `reserveQuota` with a weight
// above 1: every fixture called a cache tool, so the whole weighted path was
// covered by nothing but the registry's arithmetic.

describe('reserveQuota charges the tool weight only against an api allowance', () => {
  let reserveQuota;

  beforeEach(async () => {
    ({ reserveQuota } = await import(`../api/mcp/quota.ts?t=${Date.now()}-${Math.random()}`));
  });

  const byName = (name) => {
    const tool = TOOL_REGISTRY.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} must exist in the registry`);
    return tool;
  };

  it('a dedicated allowance charges one unit even for a weight-3 tool', async () => {
    assert.equal(toolWeight(byName('get_country_brief')), 3);
    for (const budget of [{ allowance: 'mcp', limit: 50 }, { allowance: 'mcp', limit: 250 }, undefined]) {
      const pipe = makePipelineMock({ initialCount: 10 });
      const res = await reserveQuota('u1', pipe.pipeline, budget, 3);
      assert.equal(res.ok, true);
      assert.equal(pipe.count, 11, 'one call, one unit — applying the weight here double-charges Pro');
    }
  });

  it('an api allowance charges the full weight, on either counter', async () => {
    for (const counter of ['mcp', 'api']) {
      const pipe = makePipelineMock({ initialCount: 10 });
      const res = await reserveQuota('u1', pipe.pipeline, { allowance: 'api', counter, limit: 1000 }, 3);
      assert.equal(res.ok, true);
      assert.equal(res.newCount, 13);
      assert.equal(pipe.count, 13, `counter=${counter} must still pay the weight`);
    }
  });

  it('weighted reservation is ALL-OR-NOTHING at the boundary (999/1000, weight 2)', async () => {
    // The published contract in shared/mcp-quota-reserve-script.mjs: a weight-2
    // call against 999 used of 1,000 rejects rather than half-serving, and the
    // counter must come back to 999 — not sit at 1,000 having charged for a
    // call that never dispatched.
    const pipe = makePipelineMock({ initialCount: 999 });
    const res = await reserveQuota('u1', pipe.pipeline, { allowance: 'api', counter: 'api', limit: 1000 }, 2);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'cap-exceeded');
    assert.equal(res.floor, 1000);
    assert.equal(pipe.count, 999, 'the rejected weight-2 INCRBY must be rolled back in full');
  });

  it('the last weight-1 unit of the same budget still reserves', async () => {
    const pipe = makePipelineMock({ initialCount: 999 });
    const res = await reserveQuota('u1', pipe.pipeline, { allowance: 'api', counter: 'api', limit: 1000 }, 1);
    assert.equal(res.ok, true, 'a cache read fits where a weight-2 call does not');
    assert.equal(pipe.count, 1000);
  });

  it('rollback DECRBYs the charged weight, not 1, and stays idempotent', async () => {
    const pipe = makePipelineMock({ initialCount: 0 });
    const res = await reserveQuota('u1', pipe.pipeline, { allowance: 'api', counter: 'api', limit: 1000 }, 3);
    assert.equal(res.ok, true);
    assert.equal(pipe.count, 3);
    await res.rollback();
    assert.equal(pipe.count, 0, 'a DECR of 1 would strand 2 units of a weight-3 call');
    await res.rollback();
    assert.equal(pipe.count, 0, 'the second rollback is a no-op');
    const decrby = pipe.ops.flat().filter((cmd) => cmd[0] === 'DECRBY');
    assert.deepEqual(decrby.map((cmd) => cmd[2]), [3]);
  });

  it('gives up the residue clamp on the shared REST key, and only there', async () => {
    // The script's clamp SETs the counter down to the enforced limit, which is
    // sound only where the script is the counter's ONLY writer. REST's
    // `reserveDailyMeter` INCRs and rolls back outside the EVAL, so on the
    // shared key that DECR can land after the SET and push the counter below
    // real usage. ARGV[4] is that switch; the rejection is unaffected.
    const clampFlagFor = async (budget) => {
      const pipe = makePipelineMock({ initialCount: 10 });
      await reserveQuota('u1', pipe.pipeline, budget, 2);
      const evalCmd = pipe.ops.flat().find((cmd) => cmd[0] === 'EVAL');
      assert.ok(evalCmd, 'the reservation must go through exactly one EVAL');
      return evalCmd[8];
    };
    assert.equal(await clampFlagFor({ allowance: 'api', counter: 'api', limit: 1000 }), 0);
    assert.equal(await clampFlagFor({ allowance: 'api', counter: 'mcp', limit: 1000 }), 1);
    assert.equal(await clampFlagFor({ allowance: 'mcp', limit: 50 }), 1);
    assert.equal(await clampFlagFor(undefined), 1);
  });

  it('rollback on a dedicated allowance decrements the ONE unit it charged', async () => {
    const pipe = makePipelineMock({ initialCount: 0 });
    const res = await reserveQuota('u1', pipe.pipeline, { allowance: 'mcp', limit: 50 }, 3);
    assert.equal(res.ok, true);
    assert.equal(pipe.count, 1);
    await res.rollback();
    assert.equal(pipe.count, 0, 'refunding 3 for a 1-unit charge would mint quota');
  });
});

// ---------------------------------------------------------------------------
// End-to-end: a weight-3 tool through mcpHandler on a shadow-mode api_starter
// ---------------------------------------------------------------------------

describe('mcpHandler charges a weight-3 tool three units of an API-tier budget', () => {
  let mcpHandler;

  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'wm_test_key_weighted_dispatch';
    process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'stub';
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    delete process.env.API_RATE_LIMIT_ENFORCE;
    const mod = await import(`../api/mcp.ts?t=${Date.now()}-${Math.random()}`);
    mcpHandler = mod.mcpHandler;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('the counter advances by 3 for get_country_brief, and by 1 for a cache read', async () => {
    // Shadow mode: `counter: 'mcp'` but `allowance: 'api'`, so the dedicated
    // key is charged at REST-comparable weight. Reservation happens before
    // dispatch and is never refunded (GHSA-hcq5), so the downstream outcome
    // does not change what was charged.
    globalThis.fetch = async () => new Response(
      JSON.stringify({ result: JSON.stringify({ ok: 1 }) }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
    const entitlement = async () => ({
      planKey: 'api_starter',
      features: {
        tier: 2,
        mcpAccess: true,
        planLimits: {
          apiRequestsPerDay: 1000,
          apiBurstRequestsPerMinute: 60,
          mcpCallsPerDay: SHARED_API_BUDGET,
          mcpBurstRequestsPerMinute: 60,
        },
      },
      validUntil: Date.now() + 86_400_000,
    });

    const weighted = makeProDeps({ getEntitlements: entitlement });
    await mcpHandler(proReq('POST', callBody('get_country_brief', { country_code: 'FR' })), weighted.deps);
    assert.equal(weighted.pipe.count, 3, 'a two-fetch tool costs 3 REST units of the shared budget');

    const cheap = makeProDeps({ getEntitlements: entitlement });
    await mcpHandler(proReq('POST', callBody('get_market_data')), cheap.deps);
    assert.equal(cheap.pipe.count, 1, 'a cache read still costs one REST unit');
  });

  it('the SAME weight-3 tool costs a Pro caller one unit', async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ result: JSON.stringify({ ok: 1 }) }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
    const { deps, pipe } = makeProDeps({
      getEntitlements: async () => ({
        planKey: 'pro_monthly',
        features: {
          tier: 1,
          mcpAccess: true,
          planLimits: {
            apiRequestsPerDay: 0,
            apiBurstRequestsPerMinute: 0,
            mcpCallsPerDay: 50,
            mcpBurstRequestsPerMinute: 60,
          },
        },
        validUntil: Date.now() + 86_400_000,
      }),
    });
    await mcpHandler(proReq('POST', callBody('get_country_brief', { country_code: 'FR' })), deps);
    assert.equal(pipe.count, 1, 'weighting a dedicated 50/day allowance spends it 3x too fast');
  });
});

// ---------------------------------------------------------------------------
// The cap-exceeded 429 says WHOSE traffic exhausted the number
// ---------------------------------------------------------------------------

describe('the daily-cap -32029 carries structured data, not just prose', () => {
  let mcpHandler;

  const apiStarter = async () => ({
    planKey: 'api_starter',
    features: {
      tier: 2,
      mcpAccess: true,
      planLimits: {
        apiRequestsPerDay: 1000,
        apiBurstRequestsPerMinute: 60,
        mcpCallsPerDay: SHARED_API_BUDGET,
        mcpBurstRequestsPerMinute: 60,
      },
    },
    validUntil: Date.now() + 86_400_000,
  });

  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'wm_test_key_structured_cap';
    process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'stub';
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    const mod = await import(`../api/mcp.ts?t=${Date.now()}-${Math.random()}`);
    mcpHandler = mod.mcpHandler;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const capped = async (getEntitlements, initialCount) => {
    const { deps } = makeProDeps({ pipelineOpts: { initialCount }, getEntitlements });
    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);
    return { res, body: await res.json() };
  };

  it('ENFORCED api_starter: the envelope says the budget is shared with REST', async () => {
    // Post-flip this exhaustion can be entirely REST-driven. Without the flag
    // an agent reads "Daily MCP quota exceeded" and concludes it made 1,000
    // tool calls, which may be false.
    process.env.API_RATE_LIMIT_ENFORCE = 'true';
    const { res, body } = await capped(apiStarter, 1000);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('Retry-After')?.length > 0, true);
    assert.equal(body.error.code, -32029);
    assert.equal(
      body.error.message,
      'Daily MCP quota exceeded (1000/day). Resets at next UTC midnight.',
      'the published copy is unchanged; only data is added',
    );
    assert.equal(body.error.data.reason, 'quota-exceeded');
    assert.equal(body.error.data.limit, 1000);
    assert.equal(body.error.data.sharedWithRestApi, true);
    assert.ok(body.error.data.upgradeUrl.length > 0);
  });

  it('SHADOW api_starter: the same plan on the dedicated counter is not shared', async () => {
    delete process.env.API_RATE_LIMIT_ENFORCE;
    const { body } = await capped(apiStarter, 1000);
    assert.equal(body.error.data.limit, 1000);
    assert.equal(body.error.data.sharedWithRestApi, false, 'only the flag moves the counter');
  });

  it('a Pro caller at 50/day is never shared with REST', async () => {
    delete process.env.API_RATE_LIMIT_ENFORCE;
    const { body } = await capped(async () => ({
      planKey: 'pro_monthly',
      features: {
        tier: 1,
        mcpAccess: true,
        planLimits: {
          apiRequestsPerDay: 0,
          apiBurstRequestsPerMinute: 0,
          mcpCallsPerDay: 50,
          mcpBurstRequestsPerMinute: 60,
        },
      },
      validUntil: Date.now() + 86_400_000,
    }), 50);
    assert.equal(body.error.data.limit, 50);
    assert.equal(body.error.data.sharedWithRestApi, false);
  });
});
