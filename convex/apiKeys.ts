import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireUserId } from "./lib/auth";

/** Maximum number of active (non-revoked) API keys per user. */
const MAX_KEYS_PER_USER = 5;

// ---------------------------------------------------------------------------
// Public mutations & queries (require Clerk JWT via ctx.auth)
// ---------------------------------------------------------------------------

/**
 * Create a new API key.
 *
 * The caller must generate the random key client-side (or in the HTTP action)
 * and pass the SHA-256 hex hash + the first 8 chars (prefix) here.
 * The plaintext key is NEVER stored in Convex.
 *
 * Requires an active entitlement with apiAccess=true (API_STARTER+ plans).
 * Pro plans (tier 1) have apiAccess=false and cannot create keys.
 */
export const createApiKey = mutation({
  args: {
    name: v.string(),
    keyPrefix: v.string(),
    keyHash: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);

    // Entitlement gate: only users with apiAccess may create API keys.
    // This is catalog-driven — Pro (tier 1) has apiAccess=false;
    // API_STARTER+ (tier 2+) have apiAccess=true.
    const entitlement = await ctx.db
      .query("entitlements")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .first();
    if (
      !entitlement ||
      entitlement.validUntil < Date.now() ||
      !entitlement.features.apiAccess
    ) {
      throw new ConvexError("API_ACCESS_REQUIRED");
    }

    if (!args.name.trim()) {
      throw new ConvexError("INVALID_NAME");
    }
    if (!/^wm_[a-f0-9]{5}$/.test(args.keyPrefix)) {
      throw new ConvexError("INVALID_PREFIX");
    }
    if (!/^[a-f0-9]{64}$/.test(args.keyHash)) {
      throw new ConvexError("INVALID_HASH");
    }

    // Enforce per-user key limit (count only non-revoked keys)
    const existing = await ctx.db
      .query("userApiKeys")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    const activeCount = existing.filter((k) => !k.revokedAt).length;
    if (activeCount >= MAX_KEYS_PER_USER) {
      throw new ConvexError("KEY_LIMIT_REACHED");
    }

    // Guard against duplicate hash (astronomically unlikely, but belt-and-suspenders)
    const dup = await ctx.db
      .query("userApiKeys")
      .withIndex("by_keyHash", (q) => q.eq("keyHash", args.keyHash))
      .first();
    if (dup) {
      throw new ConvexError("DUPLICATE_KEY");
    }

    const id = await ctx.db.insert("userApiKeys", {
      userId,
      name: args.name.trim(),
      keyPrefix: args.keyPrefix,
      keyHash: args.keyHash,
      createdAt: Date.now(),
    });

    return { id, name: args.name.trim(), keyPrefix: args.keyPrefix };
  },
});

/** List all API keys for the current user (active + revoked). */
export const listApiKeys = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const keys = await ctx.db
      .query("userApiKeys")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();

    return keys.map((k) => ({
      id: k._id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      revokedAt: k.revokedAt,
    }));
  },
});

/** Revoke a key owned by the current user. */
export const revokeApiKey = mutation({
  args: { keyId: v.id("userApiKeys") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const key = await ctx.db.get(args.keyId);

    if (!key || key.userId !== userId) {
      throw new ConvexError("NOT_FOUND");
    }
    if (key.revokedAt) {
      throw new ConvexError("ALREADY_REVOKED");
    }

    await ctx.db.patch(args.keyId, { revokedAt: Date.now() });
    return { ok: true, keyHash: key.keyHash };
  },
});

// ---------------------------------------------------------------------------
// Internal (service-to-service) — called from HTTP actions / middleware
// ---------------------------------------------------------------------------

/**
 * Look up an API key by its SHA-256 hash.
 * Returns the key row (with userId) if found and not revoked, else null.
 * Used by the edge gateway to validate incoming API keys.
 */
export const validateKeyByHash = internalQuery({
  args: { keyHash: v.string() },
  handler: async (ctx, args) => {
    const key = await ctx.db
      .query("userApiKeys")
      .withIndex("by_keyHash", (q) => q.eq("keyHash", args.keyHash))
      .first();

    if (!key || key.revokedAt) return null;

    return {
      id: key._id,
      userId: key.userId,
      name: key.name,
    };
  },
});

/**
 * Look up the owner of a key by its hash, regardless of revoked status.
 * Used by the cache-invalidation endpoint to verify tenancy.
 */
export const getKeyOwner = internalQuery({
  args: { keyHash: v.string() },
  handler: async (ctx, args) => {
    const key = await ctx.db
      .query("userApiKeys")
      .withIndex("by_keyHash", (q) => q.eq("keyHash", args.keyHash))
      .first();
    return key ? { userId: key.userId } : null;
  },
});

/**
 * Bump lastUsedAt for a key (fire-and-forget from the gateway).
 * Skips the write if lastUsedAt was updated within the last 5 minutes
 * to reduce Convex write load for hot keys.
 */
const TOUCH_DEBOUNCE_MS = 5 * 60 * 1000;

export const touchKeyLastUsed = internalMutation({
  args: { keyId: v.id("userApiKeys") },
  handler: async (ctx, args) => {
    const key = await ctx.db.get(args.keyId);
    if (!key || key.revokedAt) return;
    if (key.lastUsedAt && key.lastUsedAt > Date.now() - TOUCH_DEBOUNCE_MS) return;
    await ctx.db.patch(args.keyId, { lastUsedAt: Date.now() });
  },
});
