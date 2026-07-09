/**
 * Canonical product catalog — single source of truth.
 *
 * All product IDs, prices, plan features, and marketing copy live here.
 * Convex server functions import directly. Dashboard and /pro page consume
 * auto-generated files produced by scripts/generate-product-config.mjs.
 *
 * To update prices or products:
 *   1. Edit this file
 *   2. Run: npx tsx scripts/generate-product-config.mjs
 *   3. Commit generated files
 *   4. Rebuild /pro: cd pro-test && npm run build
 *   5. Deploy Convex: npx convex deploy
 *   6. Re-seed plans: npx convex run payments/seedProductPlans:seedProductPlans
 */

export type PlanLimits = {
  /**
   * Daily REST/gateway request allowance. `null` means unlimited for plans
   * where customer-specific contracts set the real cap outside the catalog.
   */
  apiRequestsPerDay: number | null;
  /**
   * Per-minute REST/gateway burst allowance. Mirrors `apiRateLimit` for
   * current callers while giving plan-limit lifecycle code a named dimension.
   */
  apiBurstRequestsPerMinute: number | null;
  /**
   * Daily MCP tool/resource call allowance. Current runtime enforcement only
   * has a Pro daily counter; API-tier counters need scanner/source support.
   */
  mcpCallsPerDay: number | null;
  /**
   * Per-minute MCP burst allowance. Notices stay disabled until limiter-hit
   * telemetry is durable enough to scan.
   */
  mcpBurstRequestsPerMinute: number | null;
};

export type PlanLimitDimension =
  | "api_daily_requests"
  | "api_minute_burst"
  | "mcp_daily_calls"
  | "mcp_minute_burst";

export type PlanFeatures = {
  tier: number;
  maxDashboards: number;
  apiAccess: boolean;
  apiRateLimit: number;
  planLimits?: PlanLimits;
  prioritySupport: boolean;
  /**
   * Display/entitlement metadata ONLY — as of #4974 NO code consumes this
   * array to gate any behavior, and formats listed here are not guaranteed
   * to have exporters ("xlsx" was advertised for months with zero
   * implementation). Do NOT gate features on it without building the
   * exporter first.
   */
  exportFormats: string[];
  /**
   * Pro MCP access — bearer-token MCP authorization via Clerk + per-user 50/day
   * quota. See plan 2026-05-10-001. Distinct from `apiAccess` (which gates
   * manual `wm_…` API key issuance for REST callers). All paid tiers grant
   * `mcpAccess: true`; free is `false`.
   *
   * Optional in the type because legacy entitlement rows written before this
   * field was added do not carry it. The Dodo webhook repopulates the field
   * on the next subscription event, and every consumer (`hasFeature`,
   * `isCallerPremium`, the MCP edge handler) treats `undefined` as `false`
   * (fail-closed). Catalog entries below ALWAYS set the field explicitly.
   */
  mcpAccess?: boolean;
  /**
   * Per-account daily REST request allowance (the "included" number). Read by
   * the per-account rate-limit layer (#3199): the daily usage meter counts but
   * never rejects at this value; the hard safety ceiling is 10× this number.
   * `-1` means unlimited (no daily meter/ceiling), mirroring `maxDashboards: -1`.
   *
   * Optional for the same reason as `mcpAccess`: legacy/cached entitlement rows
   * predate it. But unlike `mcpAccess`, consumers treat `undefined` as
   * **no daily limit (fail-OPEN)** — never punish a paying customer for a stale
   * cache; the 15-min cache + Dodo webhook self-heal. Catalog entries below
   * ALWAYS set the field explicitly.
   */
  apiDailyAllowance?: number;
};

export interface CatalogEntry {
  dodoProductId?: string;
  planKey: string;
  displayName: string;
  priceCents: number | null; // fallback only — live prices fetched from Dodo API
  billingPeriod: "monthly" | "annual" | "none";
  tierGroup: string;
  features: PlanFeatures;
  marketingFeatures: string[];
  selfServe: boolean;
  highlighted: boolean;
  currentForCheckout: boolean;
  // Whether EXISTING customers can self-serve CHANGE their plan to this one.
  // Distinct from `currentForCheckout` (which only means "purchasable at all"):
  // the Dodo customer portal cannot perform a plan change, so the plan-limit
  // upgrade CTA's `billing_portal` path is gated on THIS flag. Keep false until
  // a real self-serve change-plan surface exists; otherwise the CTA leads to a
  // portal that can't upgrade anyone.
  canChangePlanSelfServe?: boolean;
  publicVisible: boolean;
}

// ---------------------------------------------------------------------------
// Shared feature sets (avoids duplication across billing variants)
// ---------------------------------------------------------------------------

const FREE_FEATURES: PlanFeatures = {
  tier: 0,
  maxDashboards: 3,
  apiAccess: false,
  apiRateLimit: 0,
  apiDailyAllowance: 0,
  planLimits: {
    apiRequestsPerDay: 0,
    apiBurstRequestsPerMinute: 0,
    mcpCallsPerDay: 0,
    mcpBurstRequestsPerMinute: 0,
  },
  prioritySupport: false,
  exportFormats: ["csv"],
  mcpAccess: false,
};

const PRO_FEATURES: PlanFeatures = {
  tier: 1,
  maxDashboards: 10,
  apiAccess: false,
  apiRateLimit: 0,
  apiDailyAllowance: 0,
  planLimits: {
    apiRequestsPerDay: 0,
    apiBurstRequestsPerMinute: 0,
    mcpCallsPerDay: 50,
    mcpBurstRequestsPerMinute: 60,
  },
  prioritySupport: false,
  exportFormats: ["csv", "pdf"],
  mcpAccess: true,
};

const API_STARTER_FEATURES: PlanFeatures = {
  tier: 2,
  maxDashboards: 25,
  apiAccess: true,
  apiRateLimit: 60,
  apiDailyAllowance: 1000,
  planLimits: {
    apiRequestsPerDay: 1_000,
    apiBurstRequestsPerMinute: 60,
    mcpCallsPerDay: 1_000,
    mcpBurstRequestsPerMinute: 60,
  },
  prioritySupport: false,
  exportFormats: ["csv", "pdf", "json"],
  mcpAccess: true,
};

const API_BUSINESS_FEATURES: PlanFeatures = {
  tier: 2,
  maxDashboards: 100,
  apiAccess: true,
  apiRateLimit: 300,
  apiDailyAllowance: 10000,
  planLimits: {
    apiRequestsPerDay: 10_000,
    apiBurstRequestsPerMinute: 300,
    mcpCallsPerDay: 10_000,
    mcpBurstRequestsPerMinute: 300,
  },
  prioritySupport: true,
  // xlsx removed (#4974): no XLSX exporter exists anywhere in the product.
  exportFormats: ["csv", "pdf", "json"],
  mcpAccess: true,
};

const ENTERPRISE_FEATURES: PlanFeatures = {
  tier: 3,
  maxDashboards: -1,
  apiAccess: true,
  apiRateLimit: 1000,
  apiDailyAllowance: -1,
  planLimits: {
    apiRequestsPerDay: null,
    apiBurstRequestsPerMinute: 1000,
    mcpCallsPerDay: null,
    mcpBurstRequestsPerMinute: 1000,
  },
  prioritySupport: true,
  exportFormats: ["csv", "pdf", "json", "xlsx", "api-stream"],
  mcpAccess: true,
};

// ---------------------------------------------------------------------------
// The Catalog
// ---------------------------------------------------------------------------

export const PRODUCT_CATALOG: Record<string, CatalogEntry> = {
  free: {
    planKey: "free",
    displayName: "Free",
    priceCents: 0,
    billingPeriod: "none",
    tierGroup: "free",
    features: FREE_FEATURES,
    marketingFeatures: [
      "Core dashboard panels",
      "Global news feed",
      "Earthquake & weather alerts",
      "Basic map view",
    ],
    selfServe: false,
    highlighted: false,
    currentForCheckout: false,
    publicVisible: true,
  },

  pro_monthly: {
    dodoProductId: "pdt_0Nbtt71uObulf7fGXhQup",
    planKey: "pro_monthly",
    displayName: "Pro Monthly",
    priceCents: 3999,
    billingPeriod: "monthly",
    tierGroup: "pro",
    features: PRO_FEATURES,
    marketingFeatures: [
      "Everything in Free",
      "AI stock analysis & backtesting",
      "Daily market briefs",
      "Military & geopolitical tracking",
      "Custom widget builder",
      "MCP + SDK access for Claude Desktop & other AI clients (50 calls/day)",
      "Priority data refresh",
    ],
    selfServe: true,
    highlighted: true,
    currentForCheckout: true,
    publicVisible: true,
  },

  pro_annual: {
    dodoProductId: "pdt_0NbttMIfjLWC10jHQWYgJ",
    planKey: "pro_annual",
    displayName: "Pro Annual",
    priceCents: 39999,
    billingPeriod: "annual",
    tierGroup: "pro",
    features: PRO_FEATURES,
    marketingFeatures: [],
    selfServe: true,
    highlighted: true,
    currentForCheckout: true,
    publicVisible: true,
  },

  api_starter: {
    dodoProductId: "pdt_0NbttVmG1SERrxhygbbUq",
    planKey: "api_starter",
    displayName: "API Starter Monthly",
    priceCents: 9999,
    billingPeriod: "monthly",
    tierGroup: "api_starter",
    features: API_STARTER_FEATURES,
    marketingFeatures: [
      "REST API + official SDKs (npm, PyPI, RubyGems, Go)",
      "Real-time data streams",
      "60 requests/minute",
      "1,000 requests/day included",
      "Webhook notifications",
      "Custom data exports",
    ],
    selfServe: true,
    highlighted: false,
    currentForCheckout: true,
    publicVisible: true,
  },

  api_starter_annual: {
    dodoProductId: "pdt_0Nbu2lawHYE3dv2THgSEV",
    planKey: "api_starter_annual",
    displayName: "API Starter Annual",
    priceCents: 99900,
    billingPeriod: "annual",
    tierGroup: "api_starter",
    features: API_STARTER_FEATURES,
    marketingFeatures: [],
    selfServe: true,
    highlighted: false,
    currentForCheckout: true,
    publicVisible: true,
  },

  api_business: {
    dodoProductId: "pdt_0Nbttg7NuOJrhbyBGCius",
    planKey: "api_business",
    displayName: "API Business",
    // Display fallback only — the /pro page and /api/product-catalog prefer
    // the live Dodo price, and checkout always charges Dodo's price. Matches
    // the $249.99/mo verified against Dodo via previewChangePlan (#4634).
    priceCents: 24999,
    billingPeriod: "monthly",
    tierGroup: "api_business",
    features: API_BUSINESS_FEATURES,
    marketingFeatures: [
      "Everything in API Starter",
      "300 requests/minute",
      "10,000 requests/day included",
      "Priority support",
    ],
    // Published + self-serve since #4945 (bet B4): the tier existed in the
    // billing system but was invisible on every pricing surface and had
    // zero customers. Starter→Business upgrades for existing subscribers
    // ride the Dodo collection/portal path (#4634/#4672); this flag set
    // covers NEW-customer checkout and pricing-page visibility.
    selfServe: true,
    highlighted: false,
    currentForCheckout: true,
    // Self-serve plan change is live (#4634): api_starter + api_business share a
    // Dodo product COLLECTION with "Allow Subscription Updates" enabled, so the
    // customer portal surfaces the prorated Starter→Business upgrade. Flipping
    // this promotes the plan-limit-notice CTA from contact_support → billing_portal.
    canChangePlanSelfServe: true,
    publicVisible: true,
  },

  enterprise: {
    dodoProductId: "pdt_0Nbttnqrfh51cRqhMdVLx",
    planKey: "enterprise",
    displayName: "Enterprise",
    priceCents: null,
    billingPeriod: "none",
    tierGroup: "enterprise",
    features: ENTERPRISE_FEATURES,
    marketingFeatures: [
      "Everything in Pro + API",
      "Unlimited API requests",
      "Dedicated support",
      "Custom integrations",
      "SLA guarantee",
      "On-premise option",
    ],
    selfServe: false,
    highlighted: false,
    currentForCheckout: false,
    publicVisible: true,
  },
};

// ---------------------------------------------------------------------------
// Legacy product IDs from test mode (for webhook resolution of existing subs)
// ---------------------------------------------------------------------------

export const LEGACY_PRODUCT_ALIASES: Record<string, string> = {
  "pdt_0NaysSFAQ0y30nJOJMBpg": "pro_monthly",
  "pdt_0NaysWqJBx3laiCzDbQfr": "pro_annual",
  "pdt_0NaysZwxCyk9Satf1jbqU": "api_starter",
  "pdt_0NaysdZLwkMAPEVJQja5G": "api_business",
  "pdt_0NaysgHSQTTqGjJdLtuWP": "enterprise",
  // "API Starter for Education" — created via Dodo dashboard 2026-05-09 with
  // education-discount pricing ($69/mo × 10yr term). Same feature set as
  // api_starter; only the price/term differ. Customer was stuck in webhook
  // 500-retry loop until this mapping was added (sub_0NeQV8vJI0fEwUEDjp3cA).
  // See scripts/audit-dodo-catalog.cjs to detect this class of drift early.
  "pdt_0NeRCJCIwZrExuE1kifHp": "api_starter",
};

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

/**
 * Plan-level precedence for entitlement recompute.
 *
 * Higher value = stronger plan. Used by the entitlement-recompute helper in
 * `subscriptionHelpers.ts` as the deterministic tie-breaker when a user has
 * multiple covering subscriptions of the same `tier` (e.g. `api_starter` and
 * `api_business` are both tier 2; monthly and annual variants of the same
 * tier-group share `tier`). The order is:
 *
 *   1. higher `features.tier` wins (always)
 *   2. higher `PLAN_PRECEDENCE` wins (capability tie-breaker within a tier)
 *   3. later `currentPeriodEnd` wins (duration tie-breaker within the same plan)
 *
 * KEEP IN SYNC with PRODUCT_CATALOG. Any new planKey added to the catalog
 * must also appear here, or the recompute helper falls back to 0 and the
 * tie-break degenerates to currentPeriodEnd.
 */
export const PLAN_PRECEDENCE: Record<string, number> = {
  free: 0,
  pro_monthly: 10,
  pro_annual: 11, // longer commitment outranks monthly at same tier
  api_starter: 20,
  api_starter_annual: 21,
  api_business: 30, // higher capability than api_starter at same tier 2
  enterprise: 40,
};

export function getEntitlementFeatures(planKey: string): PlanFeatures {
  const entry = PRODUCT_CATALOG[planKey];
  if (!entry) {
    throw new Error(
      `[productCatalog] Unknown planKey "${planKey}". Add it to PRODUCT_CATALOG.`,
    );
  }
  return entry.features;
}

export function getPlanLimit(
  planKey: string,
  dimension: PlanLimitDimension,
): number | null {
  const limits = getEntitlementFeatures(planKey).planLimits;
  if (!limits) return null;
  switch (dimension) {
    case "api_daily_requests":
      return limits.apiRequestsPerDay;
    case "api_minute_burst":
      return limits.apiBurstRequestsPerMinute;
    case "mcp_daily_calls":
      return limits.mcpCallsPerDay;
    case "mcp_minute_burst":
      return limits.mcpBurstRequestsPerMinute;
  }
}

export function resolveProductToPlan(dodoProductId: string): string | null {
  const entry = Object.values(PRODUCT_CATALOG).find(
    (e) => e.dodoProductId === dodoProductId,
  );
  if (entry) return entry.planKey;
  return LEGACY_PRODUCT_ALIASES[dodoProductId] ?? null;
}

export function getCheckoutProducts(): CatalogEntry[] {
  return Object.values(PRODUCT_CATALOG).filter((e) => e.currentForCheckout);
}

export function getPublicTiers(): CatalogEntry[] {
  return Object.values(PRODUCT_CATALOG).filter((e) => e.publicVisible);
}

export function getSeedableProducts(): Array<{
  dodoProductId: string;
  planKey: string;
  displayName: string;
  isActive: boolean;
}> {
  return Object.values(PRODUCT_CATALOG)
    .filter((e): e is CatalogEntry & { dodoProductId: string } => !!e.dodoProductId)
    .map((e) => ({
      dodoProductId: e.dodoProductId,
      planKey: e.planKey,
      displayName: e.displayName,
      isActive: true,
    }));
}
