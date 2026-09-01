// Regressions for the two P1s found on PR #7514.
//
// Both are about the same mistake in different places: treating the shared REST
// budget as if it were already a cap, when neither the flag nor the stored
// entitlement rows agreed yet.
import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { budgetCounterKey, resolveMcpBudget, SHARED_API_BUDGET } from '../api/mcp/quota.ts';
import { reservationWeight, TOOL_REGISTRY } from '../api/mcp/registry/index.ts';
import { mergeEntitlementFeatures } from '../convex/lib/entitlements.ts';
import { PRODUCT_CATALOG } from '../convex/config/productCatalog.ts';
import { apiKeyDailyKey } from '../server/_shared/api-key-rate-limit.ts';
import { dailyCounterKey, envPrefix } from '../server/_shared/pro-mcp-token.ts';

const originalEnv = { ...process.env };

afterEach(() => {
  Object.keys(process.env).forEach((k) => {
    if (!(k in originalEnv)) delete process.env[k];
  });
  Object.assign(process.env, originalEnv);
});

describe('shared budget honours REST enforcement mode', () => {
  beforeEach(() => {
    delete process.env.API_RATE_LIMIT_ENFORCE;
  });

  it('SHADOW: a shared-budget plan stays on its own counter at the 50 default', () => {
    // In shadow the gateway serves over-allowance REST requests and leaves the
    // increments on the shared key, so it climbs past the limit. Charging MCP
    // against it would 429 the heaviest accounts on day one — for accounts
    // running 2,700 REST/day, from mid-morning until UTC midnight.
    assert.deepEqual(
      resolveMcpBudget(SHARED_API_BUDGET, 1000, false),
      { scope: 'mcp', limit: 50 },
    );
  });

  it('ENFORCED: the same plan charges the shared REST budget', () => {
    assert.deepEqual(
      resolveMcpBudget(SHARED_API_BUDGET, 1000, true),
      { scope: 'api', limit: 1000 },
    );
  });

  it('reads the same env flag the gateway does, at call time', () => {
    process.env.API_RATE_LIMIT_ENFORCE = 'true';
    assert.equal(resolveMcpBudget(SHARED_API_BUDGET, 1000).scope, 'api');
    process.env.API_RATE_LIMIT_ENFORCE = 'false';
    assert.equal(resolveMcpBudget(SHARED_API_BUDGET, 1000).scope, 'mcp');
  });

  it('a dedicated-counter plan is unaffected by the flag in either state', () => {
    for (const enforced of [true, false]) {
      assert.deepEqual(resolveMcpBudget(250, 0, enforced), { scope: 'mcp', limit: 250 });
      assert.deepEqual(resolveMcpBudget(null, null, enforced), { scope: 'mcp', limit: null });
    }
  });
});

describe('stored entitlement rows cannot outrank the shared-budget marker', () => {
  it('a legacy api_starter row carrying the old numeric 1000 resolves to the marker', () => {
    // The row shape written before this change. A plain spread let it through,
    // so the subscriber kept a SEPARATE 1,000/day MCP counter on top of their
    // REST budget — 20x today's 50/day — until a billing event rewrote the row.
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
      { scope: 'api', limit: 1000 },
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
  const apiBudget = { scope: 'api', limit: 1000 };
  const mcpBudget = { scope: 'mcp', limit: 50 };

  it('production: API-scope key matches the unprefixed REST logical key', () => {
    process.env.VERCEL_ENV = 'production';
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    const key = budgetCounterKey(apiBudget, userId, date);
    assert.equal(key, apiKeyDailyKey(userId, date));
    assert.equal(key, `rl:apikey:day:${userId}:2026-09-01`);
    assert.equal(envPrefix(), '');
  });

  it('preview: API-scope key carries envPrefix so the raw MCP pipeline shares REST\'s namespaced counter', () => {
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_GIT_COMMIT_SHA = 'abcdef12deadbeef';
    const key = budgetCounterKey(apiBudget, userId, date);
    assert.equal(key, `${envPrefix()}${apiKeyDailyKey(userId, date)}`);
    assert.equal(key, `preview:abcdef12:rl:apikey:day:${userId}:2026-09-01`);
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

describe('per-tool weight applies only to the shared API budget', () => {
  const byName = (name) => {
    const tool = TOOL_REGISTRY.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} must exist in the registry`);
    return tool;
  };

  it('a Pro / shadow-mode counter charges one unit even for a live-fetch tool', () => {
    const countryRisk = byName('get_country_risk');
    const classify = byName('classify_event');
    const brief = byName('get_country_brief');
    for (const budget of [{ scope: 'mcp', limit: 50 }, { scope: 'mcp', limit: 250 }, undefined]) {
      assert.equal(reservationWeight(budget, countryRisk), 1);
      assert.equal(reservationWeight(budget, classify), 1);
      assert.equal(reservationWeight(budget, brief), 1);
    }
  });

  it('the enforced shared budget charges the published weight', () => {
    const api = { scope: 'api', limit: 1000 };
    assert.equal(reservationWeight(api, byName('get_market_data')), 1, 'cache read = 1 REST unit');
    assert.equal(reservationWeight(api, byName('get_country_risk')), 2, 'live fetch = 2 REST units');
    assert.equal(reservationWeight(api, byName('classify_event')), 2);
    assert.equal(reservationWeight(api, byName('get_country_brief')), 3, 'two downstream fetches');
    assert.equal(reservationWeight(api, byName('get_airspace')), 3);
  });
});
