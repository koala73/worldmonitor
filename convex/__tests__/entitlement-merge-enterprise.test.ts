import { describe, expect, test } from "vitest";
import {
  PRODUCT_CATALOG,
  SHARED_API_BUDGET,
} from "../config/productCatalog";
import { mergeEntitlementFeatures } from "../lib/entitlements";

// Entitlement rows store the plan's full feature set at grant time. Catalog
// Enterprise limits are plan structure (the contract default), so a row
// granted under the old 100,000/day, 1,000/min catalog must read back at the
// current catalog numbers without waiting for a billing event to rewrite it.
const STORED_ENTERPRISE_ROW = {
  tier: 3,
  historyDays: 365,
  maxDashboards: -1,
  apiAccess: true,
  apiRateLimit: 1000,
  apiDailyAllowance: 100_000,
  prioritySupport: true,
  exportFormats: ["csv", "json", "pdf"],
  mcpAccess: true,
  embedAccess: true,
  dataExport: true,
  planLimits: {
    apiRequestsPerDay: 100_000,
    apiBurstRequestsPerMinute: 1000,
    mcpCallsPerDay: 25_000,
    dashboardAiCallsPerDay: 25_000,
    mcpBurstRequestsPerMinute: 1000,
  },
};

describe("catalog Enterprise default", () => {
  test("the catalog sells 10,000 a day and 300 a minute, with MCP on the REST budget", () => {
    const enterprise = PRODUCT_CATALOG.enterprise!.features;
    expect(enterprise.apiRateLimit).toBe(300);
    expect(enterprise.apiDailyAllowance).toBe(10_000);
    expect(enterprise.planLimits).toMatchObject({
      apiRequestsPerDay: 10_000,
      apiBurstRequestsPerMinute: 300,
      mcpCallsPerDay: SHARED_API_BUDGET,
      dashboardAiCallsPerDay: 10_000,
      mcpBurstRequestsPerMinute: 300,
    });
  });

  test("a stored Enterprise row with 100,000/1,000 merges to 10,000/300", () => {
    const merged = mergeEntitlementFeatures("enterprise", STORED_ENTERPRISE_ROW);
    expect(merged.apiRateLimit).toBe(300);
    expect(merged.apiDailyAllowance).toBe(10_000);
    expect(merged.planLimits).toMatchObject({
      apiRequestsPerDay: 10_000,
      apiBurstRequestsPerMinute: 300,
      mcpCallsPerDay: SHARED_API_BUDGET,
      dashboardAiCallsPerDay: 10_000,
      mcpBurstRequestsPerMinute: 300,
    });
  });

  test("a stored Enterprise row keeps its non-limit values", () => {
    const merged = mergeEntitlementFeatures("enterprise", {
      ...STORED_ENTERPRISE_ROW,
      maxDashboards: 42,
    });
    expect(merged.maxDashboards).toBe(42);
    expect(merged.tier).toBe(3);
  });

  test("a stored API Business row is unchanged by the Enterprise rule", () => {
    const storedBusinessRow = {
      ...PRODUCT_CATALOG.api_business!.features,
      apiRateLimit: 450,
      apiDailyAllowance: 12_345,
      planLimits: {
        ...PRODUCT_CATALOG.api_business!.features.planLimits,
        apiRequestsPerDay: 12_345,
        apiBurstRequestsPerMinute: 450,
        dashboardAiCallsPerDay: 12_345,
        mcpBurstRequestsPerMinute: 450,
      },
    };
    const merged = mergeEntitlementFeatures("api_business", storedBusinessRow);
    expect(merged.apiRateLimit).toBe(450);
    expect(merged.apiDailyAllowance).toBe(12_345);
    expect(merged.planLimits).toMatchObject({
      apiRequestsPerDay: 12_345,
      apiBurstRequestsPerMinute: 450,
      mcpCallsPerDay: SHARED_API_BUDGET,
      dashboardAiCallsPerDay: 12_345,
      mcpBurstRequestsPerMinute: 450,
    });
  });
});
