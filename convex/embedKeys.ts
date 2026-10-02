import { assertAccountWritable } from "./accountDeletion/guard";
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireUserId, resolveUserId, resolveUserIdentity } from "./lib/auth";
import { mergeEntitlementFeatures } from "./lib/entitlements";
import { hasAccountEmbedAccess } from "../shared/embed-access";
import { TOUCH_DEBOUNCE_MS } from "./apiKeys";

/** Maximum number of active (non-revoked) embed keys per user. */
const MAX_EMBED_KEYS_PER_USER = 5;
/** Cap on declared embed origins per key — a partner declares sites, not a CDN. */
const MAX_ALLOWED_ORIGINS = 10;

/**
 * Normalize declared embed origins: trimmed, deduped, sorted, and each one a
 * bare origin (`https://partner.example`) rather than a URL with a path.
 * Validation only — nothing enforces these at request time (see schema.ts).
 */
function normalizeAllowedOrigins(origins: string[] | undefined): string[] | undefined {
  if (origins === undefined) return undefined;
  const normalized = new Set<string>();
  for (const raw of origins) {
    const value = raw.trim();
    if (!value) continue;
    let origin: string;
    try {
      origin = new URL(value).origin;
    } catch {
      throw new ConvexError("INVALID_ORIGIN");
    }
    if (origin !== value) throw new ConvexError("INVALID_ORIGIN");
    normalized.add(origin);
  }
  if (normalized.size === 0) return undefined;
  if (normalized.size > MAX_ALLOWED_ORIGINS) throw new ConvexError("TOO_MANY_ORIGINS");
  return [...normalized].sort();
}

// ---------------------------------------------------------------------------
// Public mutations & queries (require Clerk JWT via ctx.auth)
// ---------------------------------------------------------------------------

/**
 * Create a new partner-embed key.
 *
 * Same shown-once discipline as `convex/apiKeys.ts`: the caller generates the
 * random key client-side and passes the SHA-256 hex hash + the display prefix.
 * The plaintext key is NEVER stored in Convex.
 *
 * The gate is the shared account embed predicate — a verified Clerk PRO role
 * or active paid embed entitlement — NOT `apiAccess`. An embed key is
 * published in the partner's HTML, so it must be mintable by every paid tier;
 * Pro and Pro Business are `apiAccess: false` and `createApiKey` rejects them.
 */
export const createEmbedKey = mutation({
  args: {
    name: v.string(),
    keyPrefix: v.string(),
    keyHash: v.string(),
    allowedOrigins: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const identity = await resolveUserIdentity(ctx);
    const userId = identity?.subject ?? await requireUserId(ctx);
    await assertAccountWritable(ctx, userId);

    const entitlement = await ctx.db
      .query("entitlements")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .first();
    // Merge before gating, unlike createApiKey. `apiAccess` has existed since
    // the first entitlement row, so reading it raw is safe; `embedAccess` is
    // new, so EVERY row written before this deploy omits it and the predicate
    // is fail-closed on `undefined`. Gating on the stored value alone would
    // lock every existing paid subscriber out of the feature until a Dodo
    // billing event happened to rewrite their row.
    const merged = entitlement
      ? {
          features: mergeEntitlementFeatures(entitlement.planKey, entitlement.features),
          validUntil: entitlement.validUntil,
        }
      : null;
    if (!hasAccountEmbedAccess(identity?.plan, merged, Date.now())) {
      throw new ConvexError("EMBED_ACCESS_REQUIRED");
    }

    if (!args.name.trim()) {
      throw new ConvexError("INVALID_NAME");
    }
    if (!/^wme_[a-f0-9]{5}$/.test(args.keyPrefix)) {
      throw new ConvexError("INVALID_PREFIX");
    }
    if (!/^[a-f0-9]{64}$/.test(args.keyHash)) {
      throw new ConvexError("INVALID_HASH");
    }
    const allowedOrigins = normalizeAllowedOrigins(args.allowedOrigins);

    const active = await ctx.db
      .query("embedKeys")
      .withIndex("by_userId_revokedAt", (q) =>
        q.eq("userId", userId).eq("revokedAt", undefined),
      )
      .collect();
    if (active.length >= MAX_EMBED_KEYS_PER_USER) {
      throw new ConvexError("KEY_LIMIT_REACHED");
    }

    // Guard against duplicate hash (astronomically unlikely, but belt-and-suspenders)
    const dup = await ctx.db
      .query("embedKeys")
      .withIndex("by_keyHash", (q) => q.eq("keyHash", args.keyHash))
      .first();
    if (dup) {
      throw new ConvexError("DUPLICATE_KEY");
    }

    const id = await ctx.db.insert("embedKeys", {
      userId,
      name: args.name.trim(),
      keyPrefix: args.keyPrefix,
      keyHash: args.keyHash,
      allowedOrigins,
      createdAt: Date.now(),
    });

    return { id, name: args.name.trim(), keyPrefix: args.keyPrefix, allowedOrigins };
  },
});

/** List all embed keys for the current user (active + revoked). */
export const listEmbedKeys = query({
  args: {},
  handler: async (ctx) => {
    // Mirrors listApiKeys: a transient unauthenticated window on the Convex
    // WebSocket (sign-out, initial auth, token rotation) must return [] rather
    // than throw — the UI already gates this behind a signed-in shell, and
    // AUTH_REQUIRED from that race pages through Convex auto-Sentry.
    const userId = await resolveUserId(ctx);
    if (!userId) return [];
    const keys = await ctx.db
      .query("embedKeys")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();

    return keys.map((k) => ({
      id: k._id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      revokedAt: k.revokedAt,
      supersededAt: k.supersededAt,
      allowedOrigins: k.allowedOrigins,
    }));
  },
});

/** Revoke an embed key owned by the current user. */
export const revokeEmbedKey = mutation({
  args: { keyId: v.id("embedKeys") },
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
 * Look up an embed key by its SHA-256 hash.
 * Returns the key row (with userId) if found and not revoked, else null.
 * Used by the embed edge handler to resolve the embedding account.
 */
export const validateKeyByHash = internalQuery({
  args: { keyHash: v.string() },
  handler: async (ctx, args) => {
    const key = await ctx.db
      .query("embedKeys")
      .withIndex("by_keyHash", (q) => q.eq("keyHash", args.keyHash))
      .first();

    if (!key || key.revokedAt) return null;

    return {
      id: key._id,
      userId: key.userId,
      name: key.name,
      // Consumed ONLY by the /api/internal-validate-embed-key route to decide
      // whether scheduling touchKeyLastUsed is worthwhile; the route strips it
      // before responding, so the edge cache blob is unchanged.
      lastUsedAt: key.lastUsedAt,
    };
  },
});

/**
 * Bump lastUsedAt for an embed key (fire-and-forget from the edge).
 *
 * Shares `TOUCH_DEBOUNCE_MS` with `userApiKeys` rather than declaring a second
 * number: the debounce exists to keep concurrent touches from stampeding one
 * hot document, and that write-conflict arithmetic is identical for both
 * tables. See the note in `apiKeys.ts` for why the schedule site checks it too.
 */
export const touchKeyLastUsed = internalMutation({
  args: { keyId: v.id("embedKeys") },
  handler: async (ctx, args) => {
    const key = await ctx.db.get(args.keyId);
    if (!key || key.revokedAt) return;
    if (key.lastUsedAt && key.lastUsedAt > Date.now() - TOUCH_DEBOUNCE_MS) return;
    await ctx.db.patch(args.keyId, { lastUsedAt: Date.now() });
  },
});
