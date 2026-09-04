import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { TOUCH_DEBOUNCE_MS } from "./apiKeys";
import { requireUserId, resolveUserId } from "./lib/auth";
import { mergeEntitlementFeatures } from "./lib/entitlements";

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

// The touch debounce window is imported from apiKeys.ts — the comment above
// says "matches apiKeys", and a shared constant is what makes that true by
// construction (http.ts gates BOTH validate routes on the same window).

// ---------------------------------------------------------------------------
// Internal (service-to-service) — called from edge/HTTP actions
// ---------------------------------------------------------------------------

/**
 * Issue a new Pro MCP token row.
 *
 * Called from the edge at `/oauth/authorize-pro` after the cross-subdomain
 * Clerk grant has been validated. The caller passes the verified Clerk
 * `userId`. Verifies active Pro MCP entitlement defensively; the edge checks
 * too, but this mutation is the authoritative row-insertion gate.
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

    const entitlement = await ctx.db
      .query("entitlements")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();
    const mergedFeatures = entitlement
      ? mergeEntitlementFeatures(entitlement.planKey, entitlement.features)
      : null;
    const isPro = Boolean(
      entitlement
      && mergedFeatures
      && entitlement.validUntil >= Date.now()
      && mergedFeatures.tier >= 1
      && mergedFeatures.mcpAccess === true,
    );
    // #6716 — a CONFIRMED free account may also hold a token.
    //
    // Comment-enforced mirror of `isConfirmedFreeMcpAccount` in
    // server/_shared/pro-mcp-gate.ts; the Convex runtime cannot import from
    // server/_shared, which is why that file's header already lists this
    // function as a hand-spelled mirror. Keep the two predicates in step.
    //
    // No row at all is the never-subscribed case, and here that is
    // unambiguous: this is a direct ctx.db read, so there is no
    // "backend unconfigured" state to confuse with an absent row the way the
    // edge has. A stored row must be a complete tier-0 `free` shape — an
    // expired or disabled paid row, or a row whose features were overridden to
    // look tier-0 while planKey names a paid plan, is a data fault and still
    // fails closed.
    // Coverage that has ENDED is a free account, matching the normalisation
    // `getEntitlementsHandler` already applies at read time ("Expired
    // entitlements fall back to free tier"). That is what makes this a faithful
    // mirror: the edge never sees an expired paid row — it sees
    // FREE_TIER_DEFAULTS — so a gate here that read the RAW row and refused
    // would admit a churned user at the three edge gates and then throw
    // PRO_REQUIRED on the final step.
    //
    // Dunning does not land here either: `isCoveringAt` keeps an `on_hold` row
    // covering, so its entitlement `validUntil` is still in the future and it
    // takes the `isPro` branch above with full access.
    const coverageEnded = !entitlement || entitlement.validUntil < Date.now();
    const isConfirmedFreeAccount = coverageEnded || Boolean(
      mergedFeatures
      && entitlement.planKey === "free"
      && mergedFeatures.tier === 0
      && mergedFeatures.mcpAccess === false,
    );
    // The token proves IDENTITY, not entitlement: `validateProMcpToken` returns
    // only `{userId, lastUsedAt}`, and api/mcp/auth.ts re-derives the verdict on
    // every gated call. Issuing to a free account therefore grants nothing on
    // its own — the allowance and its cache-backed-tool restriction are applied
    // at the call site.
    if (!isPro && !isConfirmedFreeAccount) {
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
    // Read at most MAX+1 active rows per query. If an old race left more than
    // that, continue in bounded batches instead of scanning revoked history or
    // assuming six is the largest possible anomaly.
    while (true) {
      const active = await ctx.db
        .query("mcpProTokens")
        .withIndex("by_userId_revokedAt_createdAt", (q) => q
          .eq("userId", args.userId)
          .eq("revokedAt", undefined))
        .order("asc")
        .take(MAX_TOKENS_PER_USER + 1);
      if (active.length < MAX_TOKENS_PER_USER) break;

      // Leave MAX-1 active rows before insertion. A full batch may mean more
      // active rows remain, so query again; a short batch was the whole set.
      const toRevoke = active.slice(0, active.length - (MAX_TOKENS_PER_USER - 1));
      const now = Date.now();
      for (const row of toRevoke) {
        await ctx.db.patch(row._id, { revokedAt: now });
      }
      if (active.length < MAX_TOKENS_PER_USER + 1) break;
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
    // lastUsedAt is consumed ONLY by the validate route's touch-scheduling
    // gate (http.ts) and stripped before the response — the wire contract
    // stays exactly `{ userId }` (pinned by mcpProTokens.test.ts).
    return { userId: row.userId, lastUsedAt: row.lastUsedAt };
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
 *
 * Uses `resolveUserId` (not `requireUserId`) and returns an empty array
 * when unauthenticated, because this is a REACTIVE query: the client
 * WebSocket subscription fires it on every state change including the
 * brief unauth windows during sign-out, initial page load before Clerk
 * resolves, and token-rotation races. Throwing `AUTH_REQUIRED` from a
 * reactive query path causes Convex's server-side Sentry integration
 * to page on those transient races (WORLDMONITOR-RD, sibling of N3),
 * even though the `requireUserId` ConvexError throw was explicitly
 * designed not to. Returning `[]` is observationally identical to
 * "user has no tokens yet" — the only legitimate caller is the
 * settings UI, which already gates this query behind a signed-in
 * shell.
 */
export const listProMcpTokens = query({
  args: {},
  handler: async (ctx) => {
    const userId = await resolveUserId(ctx);
    if (!userId) return [];
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
