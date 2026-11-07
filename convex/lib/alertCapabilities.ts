import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { FREE_FEATURES, mergeEntitlementFeatures } from "./entitlements";
import {
  type AlertCapabilities,
  type AlertRuleCapabilityState,
  firstAlertCapabilityViolation,
  resolveAlertCapabilities,
} from "../../shared/alert-capabilities";

export type { AlertCapabilities, AlertRuleCapabilityState };

/**
 * The caller's alert-ladder capabilities (#4273), replacing the old binary
 * `assertProEntitlement` on the notification write paths. Mirrors the
 * FREE_TIER_DEFAULTS semantics everywhere else:
 *   - no entitlement row → the free ladder
 *   - validUntil < Date.now() → expired, the free ladder
 *   - current row → catalog-merged features (mergeEntitlementFeatures, so
 *     the ladder always reads the catalog's current values — plan structure)
 */
export async function loadAlertCapabilities(
  ctx: MutationCtx | QueryCtx,
  userId: string,
): Promise<AlertCapabilities> {
  const entitlement = await ctx.db
    .query("entitlements")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .first();
  const features =
    entitlement && entitlement.validUntil >= Date.now()
      ? mergeEntitlementFeatures(entitlement.planKey, entitlement.features)
      : FREE_FEATURES;
  return resolveAlertCapabilities(features);
}

/**
 * Throws a structured ConvexError when the EFFECTIVE rule state exceeds the
 * plan's ladder. The error data carries `{code, message, upgradeUrl, …}` so
 * convex/http.ts can answer 402 with a machine-readable upsell — the error
 * IS the marketing surface, same contract as the MCP denials (#6716).
 */
export function assertAlertCapabilities(
  caps: AlertCapabilities,
  state: AlertRuleCapabilityState,
): void {
  const violation = firstAlertCapabilityViolation(state, caps);
  if (violation) throw new ConvexError({ ...violation });
}
