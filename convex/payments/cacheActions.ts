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

// 15 min — short enough that subscription expiry is reflected promptly
const ENTITLEMENT_CACHE_TTL_SECONDS = 900;

// Timeout for Redis requests (5 seconds)
const REDIS_FETCH_TIMEOUT_MS = 5000;

/**
 * Returns the environment-aware Redis key prefix for entitlements.
 * Prevents live/test data from clobbering each other.
 */
function getEntitlementKey(userId: string): string {
  const envPrefix = process.env.DODO_PAYMENTS_ENVIRONMENT === 'live_mode' ? 'live' : 'test';
  return `entitlements:${envPrefix}:${userId}`;
}

/**
 * Writes a user's entitlements to Redis via Upstash REST API.
 *
 * Uses key format: entitlements:{env}:{userId} (no deployment prefix)
 * because entitlements are user-scoped, not deployment-scoped (Pitfall 2).
 *
 * Failures are logged but do not throw -- cache write failure should
 * not break the webhook pipeline.
 */
export const syncEntitlementCache = internalAction({
  args: {
    userId: v.string(),
    planKey: v.string(),
    features: v.object({
      tier: v.number(),
      maxDashboards: v.number(),
      apiAccess: v.boolean(),
      apiRateLimit: v.number(),
      prioritySupport: v.boolean(),
      exportFormats: v.array(v.string()),
    }),
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

    const key = getEntitlementKey(args.userId);
    const value = JSON.stringify({
      planKey: args.planKey,
      features: args.features,
      validUntil: args.validUntil,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REDIS_FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(
        `${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/EX/${ENTITLEMENT_CACHE_TTL_SECONDS}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        },
      );

      if (!resp.ok) {
        // Throw so Convex auto-Sentry surfaces this; the action is
        // scheduled by upsertEntitlements (fire-and-forget) and the
        // SET is idempotent, so retry-on-error is safe and correct.
        // The previous silent `console.warn` left persistent Redis
        // outages invisible — users who upgraded would not see PRO
        // features until next manual cache rebuild.
        throw new Error(
          `[cacheActions] Redis SET failed: HTTP ${resp.status} for user ${args.userId}`,
        );
      }
    } catch (err) {
      console.warn(
        "[cacheActions] Redis cache sync failed:",
        err instanceof Error ? err.message : String(err),
      );
      // Re-throw so Convex auto-Sentry captures (the warn above stays
      // for ops visibility in the Convex log dashboard).
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  },
});

/**
 * Deletes a user's entitlement cache entry from Redis.
 *
 * Used by claimSubscription to clear the stale anonymous ID cache entry
 * after reassigning records to the real authenticated user.
 */
export const deleteEntitlementCache = internalAction({
  args: { userId: v.string() },
  handler: async (_ctx, args) => {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) return;

    const key = getEntitlementKey(args.userId);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REDIS_FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(
        `${url}/del/${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        },
      );

      if (!resp.ok) {
        // Same rationale as the SET path — surface persistent failures
        // via Convex auto-Sentry. DEL is idempotent so retry is safe.
        throw new Error(
          `[cacheActions] Redis DEL failed: HTTP ${resp.status} for key ${key}`,
        );
      }
    } catch (err) {
      console.warn(
        "[cacheActions] Redis cache delete failed:",
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  },
});
