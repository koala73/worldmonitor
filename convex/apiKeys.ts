import { assertAccountWritable } from "./accountDeletion/guard";
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireUserId, resolveUserId } from "./lib/auth";
import { mergeEntitlementFeatures } from "./lib/entitlements";
import { activeAccountForOwner } from "./companyMonitoring/_shared";
import { ensureActiveAccount } from "./companyMonitoring/accounts";
import {
  COMPANY_MONITORING_RPC_SCOPES,
  type CompanyMonitoringApiScope,
} from "../shared/company-monitoring-contract";
import { hasDesktopKeyAccess } from "../shared/desktop-key-access";
import type { Doc } from "./_generated/dataModel";

/**
 * Maximum number of active (non-revoked) API keys per user. Desktop keys are
 * capped separately by the plan's `maxDesktopKeys` and never count here.
 */
const MAX_KEYS_PER_USER = 5;

export type ApiKeyKind = "api" | "desktop";
const keyKindValidator = v.union(v.literal("api"), v.literal("desktop"));

/** A row's kind. Rows written before `keyKind` existed are API keys (KTD2). */
function keyKindOf(key: Pick<Doc<"userApiKeys">, "keyKind">): ApiKeyKind {
  return key.keyKind === "desktop" ? "desktop" : "api";
}

/**
 * Desktop-key switch (Deploy Order, plan 2026-10-25-001). Off unless the Convex
 * env var is exactly "true". It gates BOTH issuance (`createDesktopKey`) and
 * validation (`validateKeyByHash` answers null for a desktop row while off):
 * the edge validators must be live and kind-aware before any desktop row can
 * be used, and "flip the flag off before rolling the edge back" only holds if
 * existing desktop rows also stop validating — an older edge's generic
 * validators accept any entry with a userId, so a desktop row reaching one
 * would be granted API scope. Flipping the flag off suspends every desktop
 * key once its edge cache entry expires (`user-api-key:` TTL, 60 s), which is
 * why the rollback waits that long; flipping it back on restores them (no row
 * is rewritten).
 */
function desktopKeysEnabled(): boolean {
  return process.env.DESKTOP_KEYS_ENABLED === "true";
}
const COMPANY_MONITORING_SCOPES = [
  ...new Set(Object.values(COMPANY_MONITORING_RPC_SCOPES)),
] as CompanyMonitoringApiScope[];

function normalizeCompanyMonitoringScopes(scopes: string[] | undefined) {
  if (!scopes || scopes.length === 0) return undefined;
  if (scopes.length > COMPANY_MONITORING_SCOPES.length || new Set(scopes).size !== scopes.length) {
    throw new ConvexError("INVALID_API_KEY_SCOPES");
  }
  if (scopes.some((scope) => !(COMPANY_MONITORING_SCOPES as readonly string[]).includes(scope))) {
    throw new ConvexError("INVALID_API_KEY_SCOPES");
  }
  return [...scopes].sort() as CompanyMonitoringApiScope[];
}

// ---------------------------------------------------------------------------
// Internal key issuance and public key management (Clerk JWT via ctx.auth)
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
/**
 * Source columns for a new key: the owner's sign-up source, stamped on the
 * users row when the account was created. Read server-side so a key is
 * credited to the agent link that brought its owner in, never to a ref some
 * other account left in the same browser.
 */
async function keySourceFields(
  ctx: MutationCtx,
  userId: string,
): Promise<{ sourceRef?: string; source?: string }> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  if (!user?.signupRef) return {};
  return { sourceRef: user.signupRef, ...(user.signupSource ? { source: user.signupSource } : {}) };
}

// Only the live-session-gated edge relay may issue keys.
export const createApiKeyForUser = internalMutation({
  args: {
    userId: v.string(),
    name: v.string(),
    keyPrefix: v.string(),
    keyHash: v.string(),
    scopes: v.optional(v.array(v.string())),
    // Omitted means "api", so every existing caller is unchanged.
    keyKind: v.optional(keyKindValidator),
  },
  handler: async (ctx, args) => {
    const userId = args.userId;
    await assertAccountWritable(ctx, userId);

    if (args.keyKind === "desktop") {
      return await createDesktopKey(ctx, userId, args);
    }

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

    const scopes = normalizeCompanyMonitoringScopes(args.scopes);
    // Issuing a scoped key is a first-use entry point, so it provisions the
    // root. Requesting no scopes must stay entirely off Company Monitoring.
    const companyMonitoringAccount = scopes
      ? await ensureActiveAccount(ctx, userId, entitlement)
      : null;
    if (scopes && !companyMonitoringAccount) {
      throw new ConvexError("COMPANY_MONITORING_ACCESS_DENIED");
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

    // Enforce per-user key limit (count only non-revoked keys).
    //
    // API keys intentionally reject at the cap instead of silently rotating a
    // valid key. If a prior race left too many active rows, converge by
    // revoking enough oldest overflow rows to make room for this create.
    const existing = await ctx.db
      .query("userApiKeys")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    // Desktop keys have their own cap and must never be revoked by this
    // convergence, so only API rows count here.
    const active = existing.filter((k) => !k.revokedAt && keyKindOf(k) === "api");
    let activeCount = active.length;
    if (active.length > MAX_KEYS_PER_USER) {
      active.sort((a, b) => a.createdAt - b.createdAt);
      const toRevoke = active.slice(0, active.length - (MAX_KEYS_PER_USER - 1));
      const now = Date.now();
      for (const key of toRevoke) {
        await ctx.db.patch(key._id, { revokedAt: now });
      }
      // After revoking overflow keys there is always exactly one slot free.
      activeCount = MAX_KEYS_PER_USER - 1;
    }
    if (activeCount >= MAX_KEYS_PER_USER) {
      throw new ConvexError("KEY_LIMIT_REACHED");
    }

    await assertUniqueKeyHash(ctx, args.keyHash);

    const id = await ctx.db.insert("userApiKeys", {
      userId,
      name: args.name.trim(),
      keyPrefix: args.keyPrefix,
      keyHash: args.keyHash,
      scopes,
      companyMonitoringAccountId: companyMonitoringAccount?.logicalAccountId,
      keyKind: "api",
      createdAt: Date.now(),
      ...(await keySourceFields(ctx, userId)),
    });

    return {
      id,
      name: args.name.trim(),
      keyPrefix: args.keyPrefix,
      scopes,
      companyMonitoringAccountId: companyMonitoringAccount?.logicalAccountId,
      keyKind: "api" as const,
    };
  },
});

// Guard against duplicate hash (astronomically unlikely, but belt-and-suspenders)
async function assertUniqueKeyHash(ctx: MutationCtx, keyHash: string) {
  const dup = await ctx.db
    .query("userApiKeys")
    .withIndex("by_keyHash", (q) => q.eq("keyHash", keyHash))
    .first();
  if (dup) {
    throw new ConvexError("DUPLICATE_KEY");
  }
}

/**
 * Issue a desktop key (plan 2026-10-25-001, U2): a `wm_` key that reaches what
 * a signed-in Pro session reaches minus the API-only surfaces. Same shown-once
 * discipline and key shape as an API key; the kind is stored server-side.
 *
 * Gated by the Deploy Order flag, then the shared desktop-key predicate on the
 * MERGED features, as `createEmbedKey` does: rows written before
 * `desktopKeyAccess` existed omit it, and the predicate is fail-closed on
 * `undefined`. The cap is the plan's `maxDesktopKeys` (also catalog-merged).
 */
async function createDesktopKey(
  ctx: MutationCtx,
  userId: string,
  args: { name: string; keyPrefix: string; keyHash: string; scopes?: string[] },
) {
  if (!desktopKeysEnabled()) {
    throw new ConvexError("DESKTOP_KEYS_DISABLED");
  }

  const entitlement = await ctx.db
    .query("entitlements")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .first();
  const merged = entitlement
    ? {
        features: mergeEntitlementFeatures(entitlement.planKey, entitlement.features),
        validUntil: entitlement.validUntil,
      }
    : null;
  if (!merged || !hasDesktopKeyAccess(merged, Date.now())) {
    throw new ConvexError("DESKTOP_KEY_ACCESS_REQUIRED");
  }

  // Company Monitoring scopes belong to API-plan keys only.
  if (args.scopes && args.scopes.length > 0) {
    throw new ConvexError("INVALID_API_KEY_SCOPES");
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

  // R5 / KTD5: an owner without apiAccess (a downgraded API customer) keeps
  // their generic keys working at desktop scope, up to the same cap, so those
  // count toward it too. Unlike the API path this never revokes to make room.
  const ownerHasApiAccess = merged.features.apiAccess === true;
  const counted = (await activeDesktopSlotKeys(ctx, userId)).filter(
    (k) => keyKindOf(k) === "desktop" || !ownerHasApiAccess,
  ).length;
  if (counted >= (merged.features.maxDesktopKeys ?? 0)) {
    throw new ConvexError("DESKTOP_KEY_LIMIT_REACHED");
  }

  await assertUniqueKeyHash(ctx, args.keyHash);

  const id = await ctx.db.insert("userApiKeys", {
    userId,
    name: args.name.trim(),
    keyPrefix: args.keyPrefix,
    keyHash: args.keyHash,
    keyKind: "desktop",
    createdAt: Date.now(),
    ...(await keySourceFields(ctx, userId)),
  });

  return {
    id,
    name: args.name.trim(),
    keyPrefix: args.keyPrefix,
    scopes: undefined,
    companyMonitoringAccountId: undefined,
    keyKind: "desktop" as const,
  };
}

/** List all API keys for the current user (active + revoked). */
export const listApiKeys = query({
  args: {},
  handler: async (ctx) => {
    // This query is called from the settings UI after a best-effort auth
    // readiness wait, but the Convex WebSocket can still observe a brief
    // unauthenticated window during sign-out, initial auth, or token rotation.
    // Throwing AUTH_REQUIRED from that race pages through Convex auto-Sentry
    // (WORLDMONITOR-XM). The UI already gates this query behind a signed-in
    // shell, so [] is the honest transient result and cannot expose another
    // user's keys.
    const userId = await resolveUserId(ctx);
    if (!userId) return [];
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
      scopes: k.scopes,
      companyMonitoringAccountId: k.companyMonitoringAccountId,
      keyKind: keyKindOf(k),
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
    await scheduleSiblingKeyCacheInvalidation(ctx, userId, key.keyHash);
    return { ok: true, keyHash: key.keyHash };
  },
});

/**
 * A revocation changes every sibling's `activeKeyRank` (plan 2026-10-25-001
 * KTD5 / R5): the next-oldest key moves within `maxDesktopKeys` the moment
 * one above it is revoked. The edge caches that rank on the shared
 * `user-api-key:<hash>` entry for 60 s, and the client-driven
 * `/api/invalidate-user-api-key-cache` only drops the REVOKED key's entry, so
 * without this a denied third key stays denied until its sibling entry ages
 * out. Invalidate the revoked key and every other active key of the owner
 * through the same action the account lifecycle uses. Scheduled only when
 * Redis is configured, matching `scheduleScopedKeyCacheInvalidation`.
 */
async function scheduleSiblingKeyCacheInvalidation(
  ctx: MutationCtx,
  ownerUserId: string,
  revokedKeyHash: string,
): Promise<void> {
  if (!process.env.UPSTASH_REDIS_REST_URL && !process.env.UPSTASH_REDIS_REST_TOKEN) return;
  const active = await ctx.db
    .query("userApiKeys")
    .withIndex("by_userId_revokedAt", (q) =>
      q.eq("userId", ownerUserId).eq("revokedAt", undefined),
    )
    .collect();
  const keyHashes = [revokedKeyHash, ...active.map((k) => k.keyHash).filter((h) => h !== revokedKeyHash)];
  await ctx.scheduler.runAfter(
    0,
    internal.payments.cacheActions.invalidateUserApiKeyCaches,
    { keyHashes },
  );
}

// ---------------------------------------------------------------------------
// Internal (service-to-service) — called from HTTP actions / middleware
// ---------------------------------------------------------------------------

/**
 * Look up an API key by its SHA-256 hash.
 * Returns the key row (with userId) if found and not revoked, else null.
 * Used by the edge gateway to validate incoming API keys.
 *
 * `keyKind` is always explicit ("api" for legacy rows), so the edge never has
 * to guess a key's scope from a missing field (KTD2, KTD3).
 */
export const validateKeyByHash = internalQuery({
  args: { keyHash: v.string() },
  handler: async (ctx, args) => {
    const key = await ctx.db
      .query("userApiKeys")
      .withIndex("by_keyHash", (q) => q.eq("keyHash", args.keyHash))
      .first();

    if (!key || key.revokedAt) return null;
    // Kill switch: with DESKTOP_KEYS_ENABLED off, a desktop row is unknown to
    // every validator (see `desktopKeysEnabled`). API rows are unaffected.
    if (keyKindOf(key) === "desktop" && !desktopKeysEnabled()) return null;

    if (key.scopes && key.scopes.length > 0) {
      let scopes: string[] | undefined;
      try {
        scopes = normalizeCompanyMonitoringScopes(key.scopes);
      } catch {
        return null;
      }
      const account = await activeAccountForOwner(ctx, key.userId);
      if (
        !scopes ||
        !account ||
        !key.companyMonitoringAccountId ||
        account.logicalAccountId !== key.companyMonitoringAccountId
      ) {
        return null;
      }
    } else if (key.companyMonitoringAccountId) {
      // A binding without issued scopes is malformed/ownerless credential
      // state and must never authenticate through a legacy fallback.
      return null;
    }

    return {
      id: key._id,
      userId: key.userId,
      name: key.name,
      scopes: key.scopes,
      companyMonitoringAccountId: key.companyMonitoringAccountId,
      keyKind: keyKindOf(key),
      activeKeyRank: await activeKeyRankOf(ctx, key),
      // Consumed ONLY by the /api/internal-validate-api-key route to decide
      // whether scheduling touchKeyLastUsed is worthwhile; the route strips
      // it before responding, so the gateway cache blob is unchanged.
      lastUsedAt: key.lastUsedAt,
    };
  },
});

/**
 * 0-based position of `key` among its owner's ACTIVE, unscoped keys of
 * BOTH kinds, oldest first (plan 2026-10-25-001 KTD5 / R5).
 *
 * The edge needs this to apply "only the owner's oldest active keys up to
 * `maxDesktopKeys` qualify" to a downgraded owner's generic keys, and it has
 * no view of sibling rows. Both kinds count because `createDesktopKey` counts
 * both for an owner without apiAccess: a desktop key the owner minted while
 * on Pro occupies one of the same slots, so ranking generic keys among api
 * rows alone would let the owner run `maxDesktopKeys` desktop keys PLUS
 * `maxDesktopKeys` generic keys at desktop scope. Ties on `createdAt` break
 * on the insertion order Convex recorded, so the rank is stable across reads.
 */
async function activeKeyRankOf(ctx: QueryCtx, key: Doc<"userApiKeys">): Promise<number> {
  const active = (await activeDesktopSlotKeys(ctx, key.userId))
    .sort((a, b) => a.createdAt - b.createdAt || a._creationTime - b._creationTime);
  const rank = active.findIndex((k) => k._id === key._id);
  // A Company Monitoring key holds no slot, so it is not found; nor is a
  // malformed read. Either way the edge must never see -1 below a cap.
  return rank < 0 ? Number.MAX_SAFE_INTEGER : rank;
}

/**
 * The owner's active keys that can hold a desktop slot. Company Monitoring
 * keys are excluded: every desktop-aware validator rejects a scoped key, so
 * counting one would spend an allowance it can never use.
 */
async function activeDesktopSlotKeys(
  ctx: QueryCtx,
  userId: string,
): Promise<Doc<"userApiKeys">[]> {
  const active = await ctx.db
    .query("userApiKeys")
    .withIndex("by_userId_revokedAt", (q) => q.eq("userId", userId).eq("revokedAt", undefined))
    .collect();
  return active.filter((k) => !k.companyMonitoringAccountId && !(k.scopes && k.scopes.length > 0));
}

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
 *
 * Exported because the debounce check ALSO runs in http.ts before the touch
 * is even scheduled. The in-mutation check alone was a read-then-write race:
 * every validation scheduled a touch, and at each debounce boundary all
 * concurrently scheduled touches read the same stale lastUsedAt and patched
 * the same hot document — 1,036 OCC write conflicts on userApiKeys in 14
 * days, reaching retry depth 3 (Convex Insights, 2026-08). Gating at the
 * schedule site keeps the herd from forming; this in-mutation check stays as
 * the second line, making any touch that does race a no-op on retry.
 */
export const TOUCH_DEBOUNCE_MS = 5 * 60 * 1000;

export const touchKeyLastUsed = internalMutation({
  args: { keyId: v.id("userApiKeys") },
  handler: async (ctx, args) => {
    const key = await ctx.db.get(args.keyId);
    if (!key || key.revokedAt) return;
    if (key.lastUsedAt && key.lastUsedAt > Date.now() - TOUCH_DEBOUNCE_MS) return;
    await ctx.db.patch(args.keyId, { lastUsedAt: Date.now() });
  },
});
