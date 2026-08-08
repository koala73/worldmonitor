// AUTO-GENERATED from convex/config/productCatalog.ts
// Do not edit manually. Run: npm run product:facts

export const DODO_PRODUCTS = {
  PRO_MONTHLY: 'pdt_0Nbtt71uObulf7fGXhQup',
  PRO_ANNUAL: 'pdt_0NbttMIfjLWC10jHQWYgJ',
  PRO_BUSINESS_MONTHLY: 'pdt_0NjyFDbhURh2oROgPIU3G',
  PRO_BUSINESS_ANNUAL: 'pdt_0Nk072fxPUcHWivZRtlQW',
  API_STARTER_MONTHLY: 'pdt_0NbttVmG1SERrxhygbbUq',
  API_STARTER_ANNUAL: 'pdt_0Nbu2lawHYE3dv2THgSEV',
  API_BUSINESS: 'pdt_0Nbttg7NuOJrhbyBGCius',
  API_BUSINESS_ANNUAL: 'pdt_0NkHjzMhGp3m45sZLQ7BQ',
  ENTERPRISE: 'pdt_0Nbttnqrfh51cRqhMdVLx',
} as const;

export const PLAN_LIMITS = {
  "free": {"apiRequestsPerDay":0,"apiBurstRequestsPerMinute":0,"mcpCallsPerDay":0,"dashboardAiCallsPerDay":0,"mcpBurstRequestsPerMinute":0},
  "pro_monthly": {"apiRequestsPerDay":0,"apiBurstRequestsPerMinute":0,"mcpCallsPerDay":50,"dashboardAiCallsPerDay":500,"mcpBurstRequestsPerMinute":60},
  "pro_annual": {"apiRequestsPerDay":0,"apiBurstRequestsPerMinute":0,"mcpCallsPerDay":50,"dashboardAiCallsPerDay":500,"mcpBurstRequestsPerMinute":60},
  "pro_business_monthly": {"apiRequestsPerDay":0,"apiBurstRequestsPerMinute":0,"mcpCallsPerDay":250,"dashboardAiCallsPerDay":2500,"mcpBurstRequestsPerMinute":60},
  "pro_business_annual": {"apiRequestsPerDay":0,"apiBurstRequestsPerMinute":0,"mcpCallsPerDay":250,"dashboardAiCallsPerDay":2500,"mcpBurstRequestsPerMinute":60},
  "api_starter": {"apiRequestsPerDay":1000,"apiBurstRequestsPerMinute":60,"mcpCallsPerDay":1000,"dashboardAiCallsPerDay":1000,"mcpBurstRequestsPerMinute":60},
  "api_starter_annual": {"apiRequestsPerDay":1000,"apiBurstRequestsPerMinute":60,"mcpCallsPerDay":1000,"dashboardAiCallsPerDay":1000,"mcpBurstRequestsPerMinute":60},
  "api_business": {"apiRequestsPerDay":10000,"apiBurstRequestsPerMinute":300,"mcpCallsPerDay":10000,"dashboardAiCallsPerDay":10000,"mcpBurstRequestsPerMinute":300},
  "api_business_annual": {"apiRequestsPerDay":10000,"apiBurstRequestsPerMinute":300,"mcpCallsPerDay":10000,"dashboardAiCallsPerDay":10000,"mcpBurstRequestsPerMinute":300},
  "enterprise": {"apiRequestsPerDay":null,"apiBurstRequestsPerMinute":1000,"mcpCallsPerDay":null,"dashboardAiCallsPerDay":null,"mcpBurstRequestsPerMinute":1000},
} as const;

/** Default product for upgrade CTAs (Pro Monthly). */
export const DEFAULT_UPGRADE_PRODUCT = DODO_PRODUCTS.PRO_MONTHLY;
