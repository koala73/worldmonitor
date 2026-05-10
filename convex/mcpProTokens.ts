import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireUserId } from "./lib/auth";
import { getFeaturesForPlan } from "./lib/entitlements";

/**
 * Pro MCP token (non-key) identity rows.
 *
 * Mirrors the structure of `convex/apiKeys.ts` — same per-user 5-row cap,
 * same debounce on lastUsedAt — but stores no key material. The row's
 * `_id` IS the bearer identifier (referenced from OAuth code/token records
 * as `mcpTokenId`). See plan
 * docs/plans/2026-05-10-001-feat-pro-mcp-clerk-auth-quota-plan.md.
 */

/** Maximum number of active (non-revoked) Pro MCP tokens per user. */
const MAX_TOKENS_PER_USER = 5;

/** Debounce window for touchProMcpTokenLastUsed (matches apiKeys). */
const TOUCH_DEBOUNCE_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Internal (service-to-service) — called from edge/HTTP actions
// ---------------------------------------------------------------------------

/**
 * Issue a new Pro MCP token row.
 *
 * Called from the edge at `/oauth/authorize-pro` after the cross-subdomain
 * Clerk grant has been validated. The caller passes the verified Clerk
 * `userId`. Verifies entitlement (tier ≥ 1, `validUntil >= now`) defensively
 * — the edge re-checks too, but the row insert is the authoritative gate.
 *
 * Per-user 5-row cap with silent oldest rotation: if the user already has
 * 5 active rows we revoke the oldest (by createdAt) before inserting the
 * new one — never delete (preserves audit trail).
 */
export const issueProMcpToken = internalMutation({
  args: {
    userId: v.string(),
    clientId: v.optional(v.string()),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!args.userId) {
      throw new ConvexError("INVALID_USER_ID");
    }

    // Entitlement gate: Pro is the minimum (tier ≥ 1). API_STARTER+ (tier 2+)
    // also passes, since Pro is the floor — the plan explicitly notes
    // "Pro is the minimum, not exclusive."
    //
    // Mirror downstream MCP-edge gate: BOTH tier ≥ 1 AND mcpAccess === true
    // are required. Reviewer round-2 P2 — gating on tier alone allowed a
    // tier-1 user without mcpAccess to mint a token that would then fail
    // every tools/call at the gateway. PRE-FIELD legacy entitlement rows
    // are handled by the read-time merge in convex/entitlements.ts; this
    // direct ctx.db read of the row uses the catalog default explicitly.
    const entitlement = await ctx.db
      .query("entitlements")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();
    const catalogDefaults = entitlement
      ? getFeaturesForPlan(entitlement.planKey)
      : null;
    const mergedFeatures = entitlement && catalogDefaults
      ? { ...catalogDefaults, ...entitlement.features }
      : null;
    if (
      !entitlement ||
      !mergedFeatures ||
      entitlement.validUntil < Date.now() ||
      mergedFeatures.tier < 1 ||
      mergedFeatures.mcpAccess !== true
    ) {
      throw new ConvexError("PRO_REQUIRED");
    }

    // Enforce per-user cap with silent oldest rotation. Match the pattern
    // used by createApiKey at convex/apiKeys.ts:62 — count only non-revoked
    // rows, but unlike apiKeys we silently rotate instead of throwing.
    //
    // F5 (U7+U8 review pass): "exactly oldest" rotation has a race —
    // two concurrent issue calls can both observe `active.length === 4`,
    // both insert, and produce 6 active rows. Convex doesn't serialise
    // mutations across the entire table; per-userId concurrency is real.
    // To converge back to the cap even after a brief race window, revoke
    // ALL rows beyond `MAX_TOKENS_PER_USER - 1` (sorted by createdAt).
    // This makes the cap "eventually MAX" rather than "atomically MAX":
    // the next issue call's check trims any temporary overshoot.
    const existing = await ctx.db
      .query("mcpProTokens")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    const active = existing.filter((r) => !r.revokedAt);
    if (active.length >= MAX_TOKENS_PER_USER) {
      // Sort ascending by createdAt — oldest first.
      active.sort((a, b) => a.createdAt - b.createdAt);
      // Revoke all rows beyond `MAX - 1` so the table converges to MAX
      // active rows after the upcoming insert. In the no-race case this
      // is exactly one row (matching the prior behaviour); in a race
      // where 6 actives slipped through, it's two rows.
      const toRevoke = active.slice(0, active.length - (MAX_TOKENS_PER_USER - 1));
      const now = Date.now();
      for (const row of toRevoke) {
        await ctx.db.patch(row._id, { revokedAt: now });
      }
    }

    const tokenId = await ctx.db.insert("mcpProTokens", {
      userId: args.userId,
      clientId: args.clientId,
      name: args.name,
      createdAt: Date.now(),
    });

    return { tokenId };
  },
});

/**
 * Validate a Pro MCP token by id.
 *
 * Returns `{userId}` if the row exists and is not revoked. Returns null
 * otherwise. NOT positive-cached at the edge layer (per plan U2) — every
 * Pro MCP request hits this query.
 */
export const validateProMcpToken = internalQuery({
  args: { tokenId: v.id("mcpProTokens") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.tokenId);
    if (!row || row.revokedAt) return null;
    return { userId: row.userId };
  },
});

/**
 * Service-to-service revoke. Takes an explicit userId + tokenId and
 * validates ownership in-mutation (so the edge caller doesn't need a
 * Clerk identity context — used by `/oauth/authorize-pro` rollback when
 * a code-write fails AFTER `issueProMcpToken` succeeds).
 *
 * Tenancy gate: `userId` must match `row.userId`. Mismatch → NOT_FOUND
 * (don't leak existence of other users' tokens to a misbehaving caller).
 */
export const internalRevokeProMcpToken = internalMutation({
  args: { userId: v.string(), tokenId: v.id("mcpProTokens") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.tokenId);
    if (!row || row.userId !== args.userId) {
      throw new ConvexError("NOT_FOUND");
    }
    if (row.revokedAt) {
      throw new ConvexError("ALREADY_REVOKED");
    }
    await ctx.db.patch(args.tokenId, { revokedAt: Date.now() });
    return { ok: true };
  },
});

/**
 * Bump lastUsedAt for a Pro MCP token (fire-and-forget from the edge).
 * Skips the write if lastUsedAt was updated within the last 5 minutes
 * to reduce Convex write load on hot tokens. Mirrors
 * `apiKeys.touchKeyLastUsed`.
 *
 * No-op on a revoked row — we don't want lastUsedAt to keep moving on
 * tokens whose access has already been cut.
 */
export const touchProMcpTokenLastUsed = internalMutation({
  args: { tokenId: v.id("mcpProTokens") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.tokenId);
    if (!row || row.revokedAt) return;
    if (row.lastUsedAt && row.lastUsedAt > Date.now() - TOUCH_DEBOUNCE_MS) return;
    await ctx.db.patch(args.tokenId, { lastUsedAt: Date.now() });
  },
});

// ---------------------------------------------------------------------------
// Public — require Clerk JWT via ctx.auth (settings UI, U9)
// ---------------------------------------------------------------------------

/**
 * List all Pro MCP tokens for the current user (active + revoked).
 *
 * Returns ALL rows — including revoked — for transparency. The settings UI
 * surfaces revoked rows greyed-out so the user has a record of past grants.
 */
export const listProMcpTokens = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const rows = await ctx.db
      .query("mcpProTokens")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();

    return rows.map((r) => ({
      id: r._id,
      name: r.name,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      revokedAt: r.revokedAt,
    }));
  },
});

/**
 * Revoke a Pro MCP token row owned by the current user.
 *
 * Tenancy gate: the caller must own the row. Non-owner attempts surface
 * as `NOT_FOUND` (don't leak existence of other users' tokens). Mirrors
 * `apiKeys.revokeApiKey`.
 */
export const revokeProMcpToken = mutation({
  args: { tokenId: v.id("mcpProTokens") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const row = await ctx.db.get(args.tokenId);

    if (!row || row.userId !== userId) {
      throw new ConvexError("NOT_FOUND");
    }
    if (row.revokedAt) {
      throw new ConvexError("ALREADY_REVOKED");
    }

    await ctx.db.patch(args.tokenId, { revokedAt: Date.now() });
    return { ok: true };
  },
});
