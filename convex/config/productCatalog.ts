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

export type PlanFeatures = {
  tier: number;
  maxDashboards: number;
  apiAccess: boolean;
  apiRateLimit: number;
  prioritySupport: boolean;
  exportFormats: string[];
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
  prioritySupport: false,
  exportFormats: ["csv"],
};

const PRO_FEATURES: PlanFeatures = {
  tier: 1,
  maxDashboards: 10,
  apiAccess: false,
  apiRateLimit: 0,
  prioritySupport: false,
  exportFormats: ["csv", "pdf"],
};

const API_STARTER_FEATURES: PlanFeatures = {
  tier: 2,
  maxDashboards: 25,
  apiAccess: true,
  apiRateLimit: 60,
  prioritySupport: false,
  exportFormats: ["csv", "pdf", "json"],
};

const API_BUSINESS_FEATURES: PlanFeatures = {
  tier: 2,
  maxDashboards: 100,
  apiAccess: true,
  apiRateLimit: 300,
  prioritySupport: true,
  exportFormats: ["csv", "pdf", "json", "xlsx"],
};

const ENTERPRISE_FEATURES: PlanFeatures = {
  tier: 3,
  maxDashboards: -1,
  apiAccess: true,
  apiRateLimit: 1000,
  prioritySupport: true,
  exportFormats: ["csv", "pdf", "json", "xlsx", "api-stream"],
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
      "MCP data connectors",
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
      "REST API access",
      "Real-time data streams",
      "1,000 requests/day",
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
    priceCents: null,
    billingPeriod: "monthly",
    tierGroup: "api_business",
    features: API_BUSINESS_FEATURES,
    marketingFeatures: [],
    selfServe: false,
    highlighted: false,
    currentForCheckout: false,
    publicVisible: false,
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
};

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

export function getEntitlementFeatures(planKey: string): PlanFeatures {
  const entry = PRODUCT_CATALOG[planKey];
  if (!entry) {
    throw new Error(
      `[productCatalog] Unknown planKey "${planKey}". Add it to PRODUCT_CATALOG.`,
    );
  }
  return entry.features;
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
