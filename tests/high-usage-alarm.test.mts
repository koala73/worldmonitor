import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  crossedHighUsageThreshold,
  HIGH_USAGE_ALARM_FRACTION,
  OPERATOR_KEY_DAILY_CEILINGS,
  operatorKeyQuotaPrincipal,
} from '../server/_shared/high-usage-alarm.ts';
import { PRODUCT_CATALOG } from '../convex/config/productCatalog.ts';
import { mergeEntitlementFeatures } from '../convex/lib/entitlements.ts';

describe('crossedHighUsageThreshold', () => {
  const ceiling = 1_000;
  const threshold = ceiling * HIGH_USAGE_ALARM_FRACTION; // 250

  it('fires for exactly one unit increment per day: the one that reaches the threshold', () => {
    const fired = [];
    for (let count = 1; count <= ceiling; count += 1) {
      if (crossedHighUsageThreshold(count, 1, ceiling)) fired.push(count);
    }
    assert.deepEqual(fired, [threshold]);
  });

  it('fires once when a weighted increment steps over the exact threshold', () => {
    const fired = [];
    for (let count = 3; count <= ceiling; count += 3) {
      if (crossedHighUsageThreshold(count, 3, ceiling)) fired.push(count);
    }
    assert.deepEqual(fired, [252]);
  });

  it('never fires for an unusable ceiling', () => {
    assert.equal(crossedHighUsageThreshold(250, 1, 0), false);
    assert.equal(crossedHighUsageThreshold(250, 1, Number.NaN), false);
    assert.equal(crossedHighUsageThreshold(Number.NaN, 1, ceiling), false);
  });
});

describe('operator-key ceilings', () => {
  it('sit far above the observed operator-key peaks they were sized from', () => {
    // Observed 2026-07-20 → 2026-10-18 (Axiom wm_api_usage, auth_kind=enterprise_api_key).
    const OBSERVED_PEAK_REST_PER_DAY = 1_911;
    const OBSERVED_PEAK_DIRECT_LLM_PER_DAY = 162;
    assert.ok(OPERATOR_KEY_DAILY_CEILINGS.restRequests * HIGH_USAGE_ALARM_FRACTION > 10 * OBSERVED_PEAK_REST_PER_DAY);
    assert.ok(OPERATOR_KEY_DAILY_CEILINGS.directLlmCalls * HIGH_USAGE_ALARM_FRACTION > 5 * OBSERVED_PEAK_DIRECT_LLM_PER_DAY);
  });
});

describe('catalog Enterprise ceilings', () => {
  const enterprise = PRODUCT_CATALOG.enterprise.features;
  const finitePlans = Object.values(PRODUCT_CATALOG).filter((entry) => entry.features.tier < 3);

  it('are finite on every daily dimension', () => {
    assert.equal(typeof enterprise.planLimits?.apiRequestsPerDay, 'number');
    assert.equal(typeof enterprise.planLimits?.mcpCallsPerDay, 'number');
    assert.equal(typeof enterprise.planLimits?.dashboardAiCallsPerDay, 'number');
    assert.ok((enterprise.apiDailyAllowance ?? -1) > 0);
  });

  it('stay at or above every lower tier, so no Enterprise customer gets less than a self-serve plan', () => {
    for (const entry of finitePlans) {
      const limits = entry.features.planLimits;
      if (!limits) continue;
      if (typeof limits.apiRequestsPerDay === 'number') {
        assert.ok(enterprise.planLimits!.apiRequestsPerDay! >= limits.apiRequestsPerDay, entry.planKey);
      }
      if (typeof limits.mcpCallsPerDay === 'number') {
        assert.ok((enterprise.planLimits!.mcpCallsPerDay as number) >= limits.mcpCallsPerDay, entry.planKey);
      }
      if (typeof limits.dashboardAiCallsPerDay === 'number') {
        assert.ok(enterprise.planLimits!.dashboardAiCallsPerDay! >= limits.dashboardAiCallsPerDay, entry.planKey);
      }
    }
  });
});

describe('Enterprise rows written under the uncapped catalog', () => {
  // Entitlement rows store the plan's full feature set at grant time, and the
  // read-time merge lets stored values win. A row granted before the ceilings
  // existed therefore still carries the old `null` / `-1` "unlimited" markers.
  const legacyRow = {
    tier: 3,
    maxDashboards: -1,
    apiAccess: true,
    apiRateLimit: 1000,
    apiDailyAllowance: -1,
    prioritySupport: true,
    exportFormats: ['csv', 'json', 'pdf'],
    mcpAccess: true,
    dataExport: true,
    planLimits: {
      apiRequestsPerDay: null,
      apiBurstRequestsPerMinute: 1000,
      mcpCallsPerDay: null,
      dashboardAiCallsPerDay: null,
      mcpBurstRequestsPerMinute: 1000,
    },
  };

  it('resolve to the catalog ceilings, not to unlimited', () => {
    const merged = mergeEntitlementFeatures('enterprise', legacyRow);
    const catalog = PRODUCT_CATALOG.enterprise.features;
    assert.equal(merged.apiDailyAllowance, catalog.apiDailyAllowance);
    assert.equal(merged.planLimits?.apiRequestsPerDay, catalog.planLimits?.apiRequestsPerDay);
    assert.equal(merged.planLimits?.mcpCallsPerDay, catalog.planLimits?.mcpCallsPerDay);
    assert.equal(merged.planLimits?.dashboardAiCallsPerDay, catalog.planLimits?.dashboardAiCallsPerDay);
  });

  it('keep every other stored value', () => {
    const merged = mergeEntitlementFeatures('enterprise', { ...legacyRow, apiRateLimit: 777 });
    assert.equal(merged.apiRateLimit, 777);
    assert.equal(merged.maxDashboards, -1);
  });
});

describe('operatorKeyQuotaPrincipal', () => {
  it('is the wm:<sha256[0..32]> bucket widget-agent already charges', async () => {
    const key = 'operator-test-key';
    const expected = `wm:${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
    assert.equal(await operatorKeyQuotaPrincipal(key), expected);
  });
});
