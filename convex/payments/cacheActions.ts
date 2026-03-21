/**
 * Internal actions for syncing entitlement data to Redis cache.
 *
 * Scheduled by upsertEntitlements() after every DB write to keep the
 * Redis entitlement cache in sync with the Convex source of truth.
 *
 * Uses Upstash REST API directly (not the server/_shared/redis module)
 * because Convex actions run in a different environment than Vercel.
 */

import { internalAction } from "../_generated/server";
import { v } from "convex/values";

const ENTITLEMENT_CACHE_TTL_SECONDS = 3600; // 1 hour

/**
 * Writes a user's entitlements to Redis via Upstash REST API.
 *
 * Uses raw key format: entitlements:{userId} (no deployment prefix)
 * because entitlements are user-scoped, not deployment-scoped (Pitfall 2).
 *
 * Failures are logged but do not throw -- cache write failure should
 * not break the webhook pipeline.
 */
export const syncEntitlementCache = internalAction({
  args: {
    userId: v.string(),
    planKey: v.string(),
    features: v.any(),
    validUntil: v.number(),
  },
  handler: async (_ctx, args) => {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
      console.warn(
        "[cacheActions] UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not set -- skipping cache sync",
      );
      return;
    }

    const key = `entitlements:${args.userId}`;
    const value = JSON.stringify({
      planKey: args.planKey,
      features: args.features,
      validUntil: args.validUntil,
    });

    try {
      const resp = await fetch(
        `${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/EX/${ENTITLEMENT_CACHE_TTL_SECONDS}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      if (!resp.ok) {
        console.warn(
          `[cacheActions] Redis SET failed: HTTP ${resp.status} for user ${args.userId}`,
        );
      }
    } catch (err) {
      console.warn(
        "[cacheActions] Redis cache sync failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  },
});
