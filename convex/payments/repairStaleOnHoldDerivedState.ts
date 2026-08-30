/**
 * One-time production repair for rows affected before on_hold coverage was
 * bounded by currentPeriodEnd (GHSA-hw94-8c4h-m9qp).
 *
 * The provider-owned subscription status remains `on_hold`. Only derived
 * state is repaired: each affected owner's entitlement is recomputed from all
 * current sources, and live Business Pro grants tied to a stale Business hold
 * are revoked through the established grant-revocation path.
 *
 * A counters-table marker makes the deploy-hook invocation idempotent. The
 * mutation is deliberately bounded and atomic: an unexpectedly large stale
 * set or any grant-repair failure aborts before the completion marker commits,
 * leaving the deployment workflow red and the repair safe to retry.
 */

import { internalMutation } from "../_generated/server";
import {
  recomputeEntitlementFromAllSubs,
  revokeBusinessProGrantsForSubscription,
} from "./subscriptionHelpers";

const REPAIR_MARKER =
  "payments.repairStaleOnHoldDerivedState.v1.completedAt";
const MAX_SUBSCRIPTIONS = 500;

export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    const completed = await ctx.db
      .query("counters")
      .withIndex("by_name", (q) => q.eq("name", REPAIR_MARKER))
      .first();
    if (completed) {
      return {
        ok: true as const,
        alreadyCompleted: true,
        staleSubscriptions: 0,
        repairedUsers: 0,
        grantsChecked: 0,
        grantsRevoked: 0,
        completedAt: completed.value,
      };
    }

    const observedAt = Date.now();
    const staleSubscriptions = await ctx.db
      .query("subscriptions")
      .withIndex("by_status_currentPeriodEnd", (q) =>
        q.eq("status", "on_hold").lte("currentPeriodEnd", observedAt),
      )
      .take(MAX_SUBSCRIPTIONS + 1);

    if (staleSubscriptions.length > MAX_SUBSCRIPTIONS) {
      throw new Error(
        `[repairStaleOnHoldDerivedState] repair refused ${staleSubscriptions.length}+ rows; ` +
          `the audited bound is ${MAX_SUBSCRIPTIONS}`,
      );
    }

    const affectedUserIds = new Set(
      staleSubscriptions.map((subscription) => subscription.userId),
    );
    for (const userId of affectedUserIds) {
      await recomputeEntitlementFromAllSubs(ctx, userId, observedAt);
    }

    let grantsChecked = 0;
    let grantsRevoked = 0;
    let grantFailures = 0;
    for (const subscription of staleSubscriptions) {
      if (subscription.planKey !== "api_business") continue;
      const result = await revokeBusinessProGrantsForSubscription(
        ctx,
        subscription.dodoSubscriptionId,
        observedAt,
      );
      grantsChecked += result.checked;
      grantsRevoked += result.revoked;
      grantFailures += result.failed;
    }
    if (grantFailures > 0) {
      throw new Error(
        `[repairStaleOnHoldDerivedState] failed for ${grantFailures} Business Pro grant(s)`,
      );
    }

    await ctx.db.insert("counters", {
      name: REPAIR_MARKER,
      value: observedAt,
    });

    return {
      ok: true as const,
      alreadyCompleted: false,
      staleSubscriptions: staleSubscriptions.length,
      repairedUsers: affectedUserIds.size,
      grantsChecked,
      grantsRevoked,
      completedAt: observedAt,
    };
  },
});
