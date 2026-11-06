import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, beforeEach, describe, it } from 'node:test';

import {
  __resetHighUsageAlarmForTests,
  __setHighUsageReporterForTests,
  crossedHighUsageThreshold,
  HIGH_USAGE_ALARM_FRACTION,
  OPERATOR_KEY_DAILY_CEILINGS,
  operatorKeyQuotaPrincipal,
  reportHighUsageIfCrossed,
} from '../server/_shared/high-usage-alarm.ts';
import { PRODUCT_CATALOG, SHARED_API_BUDGET } from '../convex/config/productCatalog.ts';
import { resolveMcpBudget } from '../api/mcp/quota.ts';
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

describe('reportHighUsageIfCrossed', () => {
  const reports: unknown[] = [];
  beforeEach(() => {
    reports.length = 0;
    __resetHighUsageAlarmForTests();
    __setHighUsageReporterForTests((error, opts) => { reports.push({ error, opts }); });
  });
  after(() => __setHighUsageReporterForTests(null));

  const report = (newCount: number, principal = 'hashed-key') => reportHighUsageIfCrossed({
    meter: 'direct-llm', credential: 'operator-key', principal, newCount, ceiling: 1_000,
  });

  it('reports a crossing once per principal per day even when a rollback re-crosses it', () => {
    // Call 250 crosses and reports; a failed relay rolls the counter back to
    // 249, so the retry reserves 250 again and crosses a second time.
    assert.equal(report(250), true);
    assert.equal(report(250), false);
    assert.equal(reports.length, 1);
  });

  it('keeps a principal reported today even after many others cross the same day', () => {
    assert.equal(report(250, 'first-key'), true);
    for (let index = 0; index < 1_500; index += 1) report(250, `other-key-${index}`);
    // A rollback and retry for the first key crosses again; it must not re-report.
    assert.equal(report(250, 'first-key'), false);
    assert.equal(reports.length, 1_501);
  });

  it('reports the same principal again on the next UTC day', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 18, 23, 59) });
    assert.equal(report(250), true);
    t.mock.timers.setTime(Date.UTC(2026, 9, 19, 0, 1));
    assert.equal(report(250), true);
    assert.equal(reports.length, 2);
  });

  it('keeps principals and meters separate', () => {
    report(250, 'first-key');
    report(250, 'second-key');
    reportHighUsageIfCrossed({ meter: 'mcp', credential: 'operator-key', principal: 'first-key', newCount: 250, ceiling: 1_000 });
    assert.equal(reports.length, 3);
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

describe('catalog Enterprise default', () => {
  const enterprise = PRODUCT_CATALOG.enterprise.features;
  const business = PRODUCT_CATALOG.api_business.features;

  it('is finite on every daily dimension', () => {
    assert.equal(typeof enterprise.planLimits?.apiRequestsPerDay, 'number');
    assert.equal(typeof enterprise.planLimits?.dashboardAiCallsPerDay, 'number');
    assert.ok((enterprise.apiDailyAllowance ?? -1) > 0);
  });

  it('is the contract default: 10,000 a day and 300 a minute, MCP on the REST budget', () => {
    assert.equal(enterprise.apiDailyAllowance, 10_000);
    assert.equal(enterprise.apiRateLimit, 300);
    assert.equal(enterprise.planLimits?.apiRequestsPerDay, 10_000);
    assert.equal(enterprise.planLimits?.apiBurstRequestsPerMinute, 300);
    assert.equal(enterprise.planLimits?.mcpCallsPerDay, SHARED_API_BUDGET);
    assert.equal(enterprise.planLimits?.mcpBurstRequestsPerMinute, 300);
    assert.equal(enterprise.planLimits?.dashboardAiCallsPerDay, 10_000);
  });

  it('gives no Enterprise customer less than API Business', () => {
    const limits = business.planLimits!;
    assert.ok(enterprise.planLimits!.apiRequestsPerDay! >= limits.apiRequestsPerDay!);
    assert.ok(enterprise.planLimits!.apiBurstRequestsPerMinute! >= limits.apiBurstRequestsPerMinute!);
    assert.ok(enterprise.planLimits!.dashboardAiCallsPerDay! >= limits.dashboardAiCallsPerDay!);
    assert.ok(enterprise.planLimits!.mcpBurstRequestsPerMinute! >= limits.mcpBurstRequestsPerMinute!);
  });

  it('resolves MCP to the shared API allowance in both flag states', () => {
    for (const restEnforced of [false, true]) {
      const budget = resolveMcpBudget(
        enterprise.planLimits?.mcpCallsPerDay,
        enterprise.planLimits?.apiRequestsPerDay,
        restEnforced,
      );
      assert.deepEqual(budget, { allowance: 'api', counter: restEnforced ? 'api' : 'mcp', limit: 10_000 });
    }
  });
});

describe('Enterprise rows written under an earlier catalog', () => {
  // Entitlement rows store the plan's full feature set at grant time, and the
  // read-time merge lets stored values win for most plans. Enterprise limits
  // are plan structure, so the catalog wins over both the old "unlimited"
  // markers and the old 100,000/1,000 numbers.
  const uncappedRow = {
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
  const circuitBreakerRow = {
    ...uncappedRow,
    apiDailyAllowance: 100_000,
    planLimits: {
      apiRequestsPerDay: 100_000,
      apiBurstRequestsPerMinute: 1000,
      mcpCallsPerDay: 25_000,
      dashboardAiCallsPerDay: 25_000,
      mcpBurstRequestsPerMinute: 1000,
    },
  };

  for (const [label, row] of [['uncapped', uncappedRow], ['100,000/1,000', circuitBreakerRow]] as const) {
    it(`resolve a ${label} row to the catalog limits`, () => {
      const merged = mergeEntitlementFeatures('enterprise', row);
      const catalog = PRODUCT_CATALOG.enterprise.features;
      assert.equal(merged.apiDailyAllowance, catalog.apiDailyAllowance);
      assert.equal(merged.apiRateLimit, catalog.apiRateLimit);
      assert.deepEqual(
        { ...merged.planLimits, desktopKeyRequestsPerDay: undefined, desktopKeyBurstPerMinute: undefined },
        { ...catalog.planLimits, desktopKeyRequestsPerDay: undefined, desktopKeyBurstPerMinute: undefined },
      );
    });
  }

  it('keep every stored value that is not a limit', () => {
    const merged = mergeEntitlementFeatures('enterprise', { ...uncappedRow, maxDashboards: 42 });
    assert.equal(merged.maxDashboards, 42);
  });
});

describe('operatorKeyQuotaPrincipal', () => {
  it('is the wm:<sha256[0..32]> bucket widget-agent already charges', async () => {
    const key = 'operator-test-key';
    const expected = `wm:${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
    assert.equal(await operatorKeyQuotaPrincipal(key), expected);
  });
});
