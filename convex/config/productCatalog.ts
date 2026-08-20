/**
 * Canonical product catalog — single source of truth.
 *
 * All product IDs, prices, plan features, and marketing copy live here.
 * Convex server functions import directly. Dashboard and /pro page consume
 * auto-generated files produced by scripts/generate-product-config.mjs.
 *
 * To update prices or products:
 *   1. Edit this file
 *   2. Run: npm run product:facts
 *   3. Commit generated files
 *   4. Rebuild /pro: npm run build:pro
 *   5. Deploy Convex: npx convex deploy
 *   6. Re-seed plans: npx convex run payments/seedProductPlans:seedProductPlans
 */

/**
 * Public product lifecycle metadata shared by every acquisition, pricing,
 * structured-data, and agent-discovery surface. Keep operational product IDs
 * in PRODUCT_CATALOG; only deliberately public facts belong here.
 */
export const PUBLIC_PRODUCT_METADATA = {
  name: "World Monitor",
  lifecycle: "launched",
  canonicalUrl: "https://www.worldmonitor.app/",
  pricingUrl: "https://www.worldmonitor.app/pro#pricing",
  primaryCtaLabel: "View Pro plans",
  currency: "USD",
  availability: "https://schema.org/InStock",
} as const;

/**
 * Independent Company Monitoring rollout controls.
 *
 * U1 defines the gates but deliberately keeps every behavior dark. Later
 * units may wire one gate at a time only after their owning promotion gate
 * passes; no aggregate flag may silently enable the entire product.
 */
export const COMPANY_MONITORING_ROLLOUT_FLAGS = {
  exaProvider: false,
  xProvider: false,
  publication: false,
  restWrites: false,
  ui: false,
  alerts: false,
} as const;

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
   * Daily dashboard-AI/REST LLM allowance. This is deliberately separate from
   * `mcpCallsPerDay`: MCP clients and dashboard/API callers have different
   * workloads and must not share the same product limit by accident.
   */
  dashboardAiCallsPerDay: number | null;
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
   * Format allowlist for an entitled export surface. `dataExport` below is
   * the first-stage lock: when it is false the entire surface is unavailable.
   * Once that gate is open, consumers expose only supported CSV/JSON/PDF
   * values declared here and ignore unknown values. Keep the two fields in
   * agreement — a tier with `dataExport: false` advertises no formats.
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
  /**
   * First-stage data-export entitlement for CSV/JSON/PDF export (plan
   * 2026-07-25-001). Once this gate is open, `exportFormats` narrows the
   * actions exposed by each export surface. `tier` cannot stand in for this
   * field: Pro Business shares `tier: 1` with Pro but exports, and Pro does
   * not.
   *
   * Optional for the same reason as `apiDailyAllowance`: rows written before
   * the field existed omit it. Consumers treat `undefined` on a `tier >= 2`
   * row as **entitled (fail-OPEN)**, and that allowance is PERMANENT, not a
   * migration window — the 15-min server-side entitlement cache
   * (`server/_shared/entitlement-check.ts`) does not key its staleness check
   * on this field, so a stale row must never lock a paying customer out of
   * their own data. `undefined` below tier 2 is NOT entitled. Catalog
   * entries below ALWAYS set the field explicitly.
   */
  dataExport?: boolean;
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
  /** License/commercial-use callouts rendered as green highlighted notes on the
   *  pricing card, visually distinct from the plain (muted) feature bullets. */
  highlightFeatures?: string[];
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
    // #6716: stays 0. The free-account allowance is NOT a plan allowance — it
    // is a paid-funnel taste metered at the MCP call site against its own Redis
    // counters, and `FREE_ACCOUNT_CALLS_PER_DAY` (api/mcp/upgrade-constants.ts)
    // is its single source of truth. Publishing 5 here bought nothing —
    // dispatch ignores `mcpDailyLimit` entirely on the free branch — and cost a
    // real bug: it made the settings endpoint advertise a ceiling it reads the
    // wrong counter for. Consumers that must show the free allowance read the
    // constant and the free counter (see api/user/mcp-quota.ts).
    mcpCallsPerDay: 0,
    dashboardAiCallsPerDay: 0,
    mcpBurstRequestsPerMinute: 0,
  },
  prioritySupport: false,
  exportFormats: [],
  mcpAccess: false,
  dataExport: false,
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
    dashboardAiCallsPerDay: 500,
    mcpBurstRequestsPerMinute: 60,
  },
  prioritySupport: false,
  exportFormats: [],
  mcpAccess: true,
  dataExport: false,
};

/**
 * Pro Business (plan 2026-07-25-001) — the commercial-use Pro variant.
 *
 * Deliberately `tier: 1` (same as Pro) so every existing Pro gate unlocks
 * generically, and deliberately `apiAccess: false` so it cannot leak `wm_…`
 * API-key issuance. What separates it from Pro is carried by named fields:
 * `dataExport`, `maxDashboards`, `prioritySupport`, and the MCP daily
 * allowance. Because it shares a tier with Pro, BOTH billing variants need
 * their own `PLAN_PRECEDENCE` entry below or the recompute tie-break
 * degrades to `currentPeriodEnd` and can hand a buyer the weaker Pro row.
 */
const PRO_BUSINESS_FEATURES: PlanFeatures = {
  tier: 1,
  maxDashboards: 25,
  apiAccess: false,
  apiRateLimit: 0,
  apiDailyAllowance: 0,
  planLimits: {
    apiRequestsPerDay: 0,
    apiBurstRequestsPerMinute: 0,
    mcpCallsPerDay: 250,
    dashboardAiCallsPerDay: 2_500,
    mcpBurstRequestsPerMinute: 60,
  },
  prioritySupport: true,
  exportFormats: ["csv", "json", "pdf"],
  mcpAccess: true,
  dataExport: true,
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
    dashboardAiCallsPerDay: 1_000,
    mcpBurstRequestsPerMinute: 60,
  },
  prioritySupport: false,
  exportFormats: ["csv", "json", "pdf"],
  mcpAccess: true,
  dataExport: true,
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
    dashboardAiCallsPerDay: 10_000,
    mcpBurstRequestsPerMinute: 300,
  },
  prioritySupport: true,
  // xlsx removed (#4974): no XLSX exporter exists anywhere in the product.
  exportFormats: ["csv", "json", "pdf"],
  mcpAccess: true,
  dataExport: true,
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
    dashboardAiCallsPerDay: null,
    mcpBurstRequestsPerMinute: 1000,
  },
  prioritySupport: true,
  // xlsx + api-stream removed for the same reason xlsx left API Business
  // (#4974): neither has an exporter, and this array is display truth.
  exportFormats: ["csv", "json", "pdf"],
  mcpAccess: true,
  dataExport: true,
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
      "3 dashboard tabs",
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
      "10 custom dashboards (vs 3)",
      "MCP + SDK access for Claude Desktop & other AI clients (50 calls/day)",
      "Priority data refresh",
    ],
    highlightFeatures: ["Personal license", "1 named user"],
    selfServe: true,
    highlighted: true,
    currentForCheckout: true,
    publicVisible: true,
  },

  pro_annual: {
    dodoProductId: "pdt_0NbttMIfjLWC10jHQWYgJ",
    planKey: "pro_annual",
    displayName: "Pro Annual",
    priceCents: 35999,
    billingPeriod: "annual",
    tierGroup: "pro",
    features: PRO_FEATURES,
    marketingFeatures: [],
    selfServe: true,
    highlighted: true,
    currentForCheckout: true,
    publicVisible: true,
  },

  pro_business_monthly: {
    // PLACEHOLDER — no such product exists in Dodo. Replaced with the real
    // product ID before launch (activation runbook, plan 2026-07-25-001).
    // Reaching checkout with this ID is a launch-sequencing bug, not a
    // supported path.
    dodoProductId: "pdt_0NjyFDbhURh2oROgPIU3G",
    planKey: "pro_business_monthly",
    displayName: "Pro Business Monthly",
    priceCents: 4999,
    billingPeriod: "monthly",
    tierGroup: "pro_business",
    features: PRO_BUSINESS_FEATURES,
    marketingFeatures: [
      "Everything in Pro",
      "Use for client work, internal tools & reporting",
      "Data export — CSV, JSON & PDF reports",
      "25 custom dashboards (vs 10)",
      "MCP + SDK: 250 calls/day (vs 50)",
      "Priority support",
    ],
    highlightFeatures: ["Commercial license included", "1 named user — not a shared login"],
    selfServe: true,
    highlighted: false,
    currentForCheckout: true,
    // Pro and Pro Business are separate Dodo products, not a
    // subscription-updatable collection — the customer portal cannot perform
    // the change, so the plan-limit CTA must not point at it.
    canChangePlanSelfServe: false,
    publicVisible: true,
  },

  pro_business_annual: {
    // PLACEHOLDER — see pro_business_monthly.
    dodoProductId: "pdt_0Nk072fxPUcHWivZRtlQW",
    planKey: "pro_business_annual",
    displayName: "Pro Business Annual",
    priceCents: 44999,
    billingPeriod: "annual",
    tierGroup: "pro_business",
    features: PRO_BUSINESS_FEATURES,
    marketingFeatures: [],
    selfServe: true,
    highlighted: false,
    currentForCheckout: true,
    canChangePlanSelfServe: false,
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
      "License / API key included",
      "Real-time data streams",
      "60 requests/minute",
      "1,000 requests/day included",
      "Webhook notifications",
    ],
    highlightFeatures: ["Commercial license — for your organization"],
    selfServe: true,
    highlighted: false,
    currentForCheckout: true,
    publicVisible: true,
  },

  api_starter_annual: {
    dodoProductId: "pdt_0Nbu2lawHYE3dv2THgSEV",
    planKey: "api_starter_annual",
    displayName: "API Starter Annual",
    priceCents: 89999,
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
    // the $299.00/mo Dodo price (raised from $249.99 alongside the commercial-
    // use license + 5 bundled Pro seats).
    priceCents: 29999,
    billingPeriod: "monthly",
    tierGroup: "api_business",
    features: API_BUSINESS_FEATURES,
    marketingFeatures: [
      "Everything in API Starter",
      "Redistribution rights — embed our data in what you sell",
      "300 requests/minute",
      "10,000 requests/day included",
      "5 Pro licenses included",
      "Priority support",
    ],
    // "Same company email required" dropped from the card (#5604): it is a
    // requirement, not a benefit. Server-side enforcement is unchanged.
    highlightFeatures: ["Commercial license — for your customers"],
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

  api_business_annual: {
    dodoProductId: "pdt_0NkHjzMhGp3m45sZLQ7BQ",
    planKey: "api_business_annual",
    displayName: "API Business Annual",
    priceCents: 269999,
    billingPeriod: "annual",
    tierGroup: "api_business",
    features: API_BUSINESS_FEATURES,
    marketingFeatures: [],
    selfServe: true,
    highlighted: false,
    currentForCheckout: true,
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
  // "5 × Standard Pro Annual Licenses" — created via Dodo dashboard 2026-07-30
  // for the Legendary 5-seat annual deal ($1,596/yr list, sold with a 15%
  // discount). The payer's subscription (sub_0NlFXgOXerG95LUzA09s4) carries
  // the payer's own Pro entitlement; the other seats are complimentary
  // entitlements aligned to the same period end. A matching productPlans row
  // (isActive: false) was hand-inserted 2026-08-14 so attribution didn't wait
  // on a deploy; this alias is the durable mapping the 2027 renewal resolves
  // through even if that row is ever lost to a reseed.
  "pdt_0NkKmaMPY3grWqiOGtyuG": "pro_annual",
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
  // Pro Business shares tier 1 with Pro, so these entries are the ONLY thing
  // that stops a recompute from handing a Pro Business buyer who also holds a
  // Pro sub the weaker Pro feature set.
  pro_business_monthly: 12,
  pro_business_annual: 13,
  api_starter: 20,
  api_starter_annual: 21,
  api_business: 30, // higher capability than api_starter at same tier 2
  api_business_annual: 31,
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
