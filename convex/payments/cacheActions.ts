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
import { internal } from "../_generated/api";
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
      planLimits: v.optional(v.object({
        apiRequestsPerDay: v.union(v.number(), v.null()),
        apiBurstRequestsPerMinute: v.union(v.number(), v.null()),
        mcpCallsPerDay: v.union(v.number(), v.null()),
        // Optional so cache sync remains compatible with legacy rows/jobs that
        // predate the dashboard-AI dimension.
        dashboardAiCallsPerDay: v.optional(v.union(v.number(), v.null())),
        mcpBurstRequestsPerMinute: v.union(v.number(), v.null()),
      })),
      prioritySupport: v.boolean(),
      exportFormats: v.array(v.string()),
      // Optional — legacy entitlement rows pre-dating plan 2026-05-10-001
      // do not carry mcpAccess. Schema validator must accept their reads.
      mcpAccess: v.optional(v.boolean()),
      // Optional — per-account daily REST allowance (#3199). Catalog-sourced
      // writes set it; legacy rows omit it (rate-limit consumer fail-opens).
      apiDailyAllowance: v.optional(v.number()),
      // Optional — data-export entitlement (plan 2026-07-25-001). Catalog
      // writes set it; legacy rows omit it (export gate fail-opens at tier 2+).
      dataExport: v.optional(v.boolean()),
    }),
    validUntil: v.number(),
  },
  handler: async (_ctx, args) => {
    await writeEntitlementCacheToRedis(args.userId, args);
  },
});

/**
 * Re-syncs a user's entitlement cache from the CURRENT database state.
 *
 * Used for the delayed race-covering sync (#4770 review): replaying the
 * caller's upsert-time snapshot could revert a newer entitlement write that
 * landed inside the delay (e.g. a renewal followed by a cancellation),
 * re-granting stale paid access for up to the cache TTL. Reading at fire
 * time means the delayed write always reflects the latest state.
 */
export const resyncEntitlementCacheFromDb = internalAction({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const current = await ctx.runQuery(
      internal.entitlements.getEntitlementsByUserId,
      { userId: args.userId },
    );
    await writeEntitlementCacheToRedis(args.userId, current);
  },
});

async function writeEntitlementCacheToRedis(
  userId: string,
  payload: { planKey: string; features: unknown; validUntil: number },
): Promise<void> {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
      console.warn(
        "[cacheActions] UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not set -- skipping cache sync",
      );
      return;
    }

    const key = getEntitlementKey(userId);
    const value = JSON.stringify({
      planKey: payload.planKey,
      features: payload.features,
      validUntil: payload.validUntil,
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
          `[cacheActions] Redis SET failed: HTTP ${resp.status} for user ${userId}`,
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
}

/**
 * Deletes a user's entitlement cache entry from Redis.
 *
 * Used by claimSubscription to clear the stale anonymous ID cache entry
 * after reassigning records to the real authenticated user. The deleted
 * key is unreachable post-claim (read path uses the real userId) and
 * self-expires at ENTITLEMENT_CACHE_TTL_SECONDS, so a failed DEL has no
 * user impact — warn and swallow rather than surfacing transient
 * Upstash latency blips to Convex auto-Sentry.
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
        console.warn(
          `[cacheActions] Redis DEL failed: HTTP ${resp.status} for key ${key}`,
        );
      }
    } catch (err) {
      // sentry-coverage-ok — DEL failure has no user impact (key is
      // unreachable post-claim, self-expires at 15-min TTL); a 5s
      // AbortError from a transient Upstash latency blip should not
      // page via Convex auto-Sentry.
      console.warn(
        "[cacheActions] Redis cache delete failed:",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      clearTimeout(timeout);
    }
  },
});

/**
 * Invalidates warm production user-key entries after an account lifecycle
 * transition. Company Monitoring scopes are account-bound inside the cached
 * validation payload, so a lapse/terminal fence must not wait for the 60s TTL.
 */
export const invalidateUserApiKeyCaches = internalAction({
  args: { keyHashes: v.array(v.string()) },
  handler: async (_ctx, args) => {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url && !token) return;
    if (!url || !token) {
      throw new Error(
        "[cacheActions] UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be configured together for user API key cache invalidation",
      );
    }
    if (args.keyHashes.length === 0) return;
    // Convex actions do not inherit Vercel deployment metadata. Lifecycle
    // invalidation therefore targets the production, unprefixed namespace;
    // preview-key namespacing remains local to the Vercel validators.
    const commands = args.keyHashes.flatMap((keyHash) => [
      ["DEL", `user-api-key:${keyHash}`],
      ["DEL", `bootstrap-user-api-key-invalid:${keyHash}`],
    ]);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REDIS_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${url}/pipeline`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "worldmonitor-server/1.0 (redis)",
        },
        body: JSON.stringify(commands),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`[cacheActions] user API key cache DEL failed: HTTP ${response.status}`);
      }
      const results: unknown = await response.json();
      if (!Array.isArray(results) || results.length !== commands.length) {
        throw new Error("[cacheActions] user API key cache DEL returned malformed pipeline results");
      }
      for (const [index, entry] of results.entries()) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new Error(`[cacheActions] user API key cache DEL failed at pipeline index ${index}`);
        }
        const result = entry as Record<string, unknown>;
        const value = result.result;
        if (
          Object.prototype.hasOwnProperty.call(result, "error") ||
          !Object.prototype.hasOwnProperty.call(result, "result") ||
          (value !== 0 && value !== 1 && value !== "0" && value !== "1")
        ) {
          throw new Error(`[cacheActions] user API key cache DEL failed at pipeline index ${index}`);
        }
      }
    } finally {
      clearTimeout(timeout);
    }
  },
});
