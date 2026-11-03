import { v } from "convex/values";
import { SHARED_API_BUDGET } from "../config/productCatalog";

/**
 * The one validator for an entitlement's `features` object.
 *
 * Shared by the `entitlements` table and `syncEntitlementCache`, which receives
 * the exact object upsertEntitlements just wrote. `v.object` is strict on extra
 * keys, so two hand-kept copies drifted: #9435 added `historyDays` to the table
 * only, and every cache sync after an entitlement write was rejected at runtime
 * (Sentry WORLDMONITOR-18W).
 */
export const entitlementFeaturesValidator = v.object({
  tier: v.number(),
  historyDays: v.optional(v.number()),
  maxDashboards: v.number(),
  apiAccess: v.boolean(),
  apiRateLimit: v.number(),
  planLimits: v.optional(v.object({
    apiRequestsPerDay: v.union(v.number(), v.null()),
    apiBurstRequestsPerMinute: v.union(v.number(), v.null()),
    // `SHARED_API_BUDGET` = the plan has no MCP allowance of its own; its
    // MCP calls charge `apiRequestsPerDay`. Imported rather than retyped:
    // this validator is what ACCEPTS the marker on every entitlement write,
    // so a renamed constant that left a stale string literal here would
    // typecheck and then reject the webhook's write at runtime.
    mcpCallsPerDay: v.union(v.number(), v.null(), v.literal(SHARED_API_BUDGET)),
    // Optional for entitlement rows written before the dashboard-AI
    // dimension existed; the read-time catalog merge supplies it.
    dashboardAiCallsPerDay: v.optional(v.union(v.number(), v.null())),
    mcpBurstRequestsPerMinute: v.union(v.number(), v.null()),
    // Optional for rows written before desktop keys (plan 2026-10-25-001).
    // Catalog-sourced writes always set them, and the read-time merge takes
    // the catalog value regardless, so this only has to ACCEPT them.
    desktopKeyRequestsPerDay: v.optional(v.number()),
    desktopKeyBurstPerMinute: v.optional(v.number()),
  })),
  prioritySupport: v.boolean(),
  exportFormats: v.array(v.string()),
  // Optional for backward-compat with existing rows written before
  // plan 2026-05-10-001 (Pro MCP). Dodo webhooks repopulate this on
  // the next subscription event; legacy rows return undefined and
  // every consumer treats undefined as "no MCP access" (fail-closed).
  mcpAccess: v.optional(v.boolean()),
  // Optional — per-account daily REST allowance (#3199). Legacy rows
  // predate it; the rate-limit consumer treats undefined as "no daily
  // limit" (fail-OPEN). Catalog-sourced writes always set it, so this
  // validator MUST accept it or the webhook's entitlement write is
  // rejected (v.object is strict on extra keys).
  apiDailyAllowance: v.optional(v.number()),
  // Optional — partner-embed key issuance. Legacy rows predate it; the
  // read-time catalog merge supplies it and consumers treat undefined as
  // false (fail-closed). Catalog-sourced writes always set it, so this
  // validator MUST accept it or the Dodo webhook's entitlement write is
  // rejected at runtime (v.object is strict on extra keys).
  embedAccess: v.optional(v.boolean()),
  // Optional — desktop-key issuance and its key cap (plan 2026-10-25-001).
  // Same contract as embedAccess: legacy rows omit them, the read-time merge
  // supplies them, and catalog-sourced writes carry them, so this validator
  // MUST accept them (v.object is strict on extra keys).
  desktopKeyAccess: v.optional(v.boolean()),
  maxDesktopKeys: v.optional(v.number()),
  // Optional — data-export entitlement (plan 2026-07-25-001). Legacy rows
  // predate it; consumers treat undefined on a tier >= 2 row as entitled
  // (fail-OPEN, permanently — see the PlanFeatures JSDoc). Catalog-sourced
  // writes always set it, so this validator MUST accept it.
  dataExport: v.optional(v.boolean()),
});
