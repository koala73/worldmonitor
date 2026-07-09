// AUTO-GENERATED from convex/config/productCatalog.ts
// Do not edit manually. Run: npx tsx scripts/generate-product-config.mjs

export const DODO_PRODUCTS = {
  PRO_MONTHLY: 'pdt_0Nbtt71uObulf7fGXhQup',
  PRO_ANNUAL: 'pdt_0NbttMIfjLWC10jHQWYgJ',
  API_STARTER_MONTHLY: 'pdt_0NbttVmG1SERrxhygbbUq',
  API_STARTER_ANNUAL: 'pdt_0Nbu2lawHYE3dv2THgSEV',
  API_BUSINESS: 'pdt_0Nbttg7NuOJrhbyBGCius',
  ENTERPRISE: 'pdt_0Nbttnqrfh51cRqhMdVLx',
} as const;

export const PLAN_LIMITS = {
  "free": {"apiRequestsPerDay":0,"apiBurstRequestsPerMinute":0,"mcpCallsPerDay":0,"mcpBurstRequestsPerMinute":0},
  "pro_monthly": {"apiRequestsPerDay":0,"apiBurstRequestsPerMinute":0,"mcpCallsPerDay":50,"mcpBurstRequestsPerMinute":60},
  "pro_annual": {"apiRequestsPerDay":0,"apiBurstRequestsPerMinute":0,"mcpCallsPerDay":50,"mcpBurstRequestsPerMinute":60},
  "api_starter": {"apiRequestsPerDay":1000,"apiBurstRequestsPerMinute":60,"mcpCallsPerDay":1000,"mcpBurstRequestsPerMinute":60},
  "api_starter_annual": {"apiRequestsPerDay":1000,"apiBurstRequestsPerMinute":60,"mcpCallsPerDay":1000,"mcpBurstRequestsPerMinute":60},
  "api_business": {"apiRequestsPerDay":10000,"apiBurstRequestsPerMinute":300,"mcpCallsPerDay":10000,"mcpBurstRequestsPerMinute":300},
  "enterprise": {"apiRequestsPerDay":null,"apiBurstRequestsPerMinute":1000,"mcpCallsPerDay":null,"mcpBurstRequestsPerMinute":1000},
} as const;

/** Default product for upgrade CTAs (Pro Monthly). */
export const DEFAULT_UPGRADE_PRODUCT = DODO_PRODUCTS.PRO_MONTHLY;
