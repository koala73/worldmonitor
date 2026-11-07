/**
 * Enterprise contract accounts: one account per contract customer whose
 * members share one request pool and one AI token allowance.
 *
 * Operator-only. Every function here is internal and runs through
 * `npx convex run enterpriseAccounts:<name> '<json>'`.
 *
 * Effects of membership:
 *   - Entitlement: an active member of a LIVE contract (contractStart <= now <
 *     contractEnd) has an Enterprise candidate in
 *     recomputeEntitlementFromAllSubs, valid until contractEnd.
 *   - AI routing: an active member inherits the account's allowedProviders
 *     (convex/lib/enterpriseAccounts.ts resolveAiRoutingPolicy), also after the
 *     contract ends, until the operator removes them.
 *
 * Every member change recomputes that member's entitlement and deletes their
 * edge entitlement and AI routing cache entries; every account edit does the
 * same for each active member.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { assertAccountWritable } from "./accountDeletion/guard";
import { validateAllowedProviders } from "./entitlements";
import { ENTITLEMENT_CACHE_RESYNC_DELAY_MS, recomputeEntitlementFromAllSubs } from "./payments/subscriptionHelpers";
import { isContractLive, liveAccountBlockForUser } from "./lib/enterpriseAccounts";

const DEFAULT_BREAKER_MULTIPLE = 5;

const POSITIVE_INTEGER_FIELDS = [
  "dailyRequestAllowance",
  "perMinuteBurst",
  "monthlyInputTokens",
  "monthlyOutputTokens",
  "breakerMultiple",
  "seatCap",
] as const;

const NON_NEGATIVE_RATE_FIELDS = [
  "overagePerThousandRequestsUsd",
  "overagePerMillionInputTokensUsd",
  "overagePerMillionOutputTokensUsd",
] as const;

type AccountTerms = Pick<
  Doc<"enterpriseAccounts">,
  | "name"
  | "contractStart"
  | "contractEnd"
  | (typeof POSITIVE_INTEGER_FIELDS)[number]
  | (typeof NON_NEGATIVE_RATE_FIELDS)[number]
  | "allowedProviders"
>;

function validateTerms(terms: AccountTerms): AccountTerms {
  const name = terms.name.trim();
  if (!name) throw new Error("name is required");
  if (!Number.isFinite(terms.contractStart) || !Number.isFinite(terms.contractEnd)) {
    throw new Error("contractStart and contractEnd must be epoch milliseconds");
  }
  if (terms.contractEnd <= terms.contractStart) {
    throw new Error("contractEnd must be after contractStart");
  }
  for (const field of POSITIVE_INTEGER_FIELDS) {
    const value = terms[field];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${field} must be a positive integer, got ${value}`);
    }
  }
  for (const field of NON_NEGATIVE_RATE_FIELDS) {
    const value = terms[field];
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${field} must be a non-negative number, got ${value}`);
    }
  }
  // Rebuilt field by field so a full row passed in (updateAccount merges the
  // stored document) never carries system or job fields into the patch.
  return {
    name,
    contractStart: terms.contractStart,
    contractEnd: terms.contractEnd,
    dailyRequestAllowance: terms.dailyRequestAllowance,
    perMinuteBurst: terms.perMinuteBurst,
    monthlyInputTokens: terms.monthlyInputTokens,
    monthlyOutputTokens: terms.monthlyOutputTokens,
    breakerMultiple: terms.breakerMultiple,
    seatCap: terms.seatCap,
    overagePerThousandRequestsUsd: terms.overagePerThousandRequestsUsd,
    overagePerMillionInputTokensUsd: terms.overagePerMillionInputTokensUsd,
    overagePerMillionOutputTokensUsd: terms.overagePerMillionOutputTokensUsd,
    allowedProviders: validateAllowedProviders(terms.allowedProviders),
  };
}

async function requireAccount(ctx: MutationCtx, accountId: Id<"enterpriseAccounts">) {
  const account = await ctx.db.get(accountId);
  if (!account) throw new Error(`ACCOUNT_NOT_FOUND: ${accountId}`);
  return account;
}

/**
 * Touch-or-insert the account's lock row. Every mutation that changes an
 * account's seats reads AND writes it, so Convex OCC serializes concurrent
 * seat changes and two adds cannot both pass the cap check.
 */
export async function touchAccountLock(ctx: MutationCtx, accountId: Id<"enterpriseAccounts">, now: number) {
  const lock = await ctx.db
    .query("enterpriseAccountLocks")
    .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
    .unique();
  if (lock) await ctx.db.patch(lock._id, { lastTouchedAt: now });
  else await ctx.db.insert("enterpriseAccountLocks", { accountId, lastTouchedAt: now });
}

export async function accountMembers(ctx: MutationCtx, accountId: Id<"enterpriseAccounts">) {
  return ctx.db
    .query("enterpriseMembers")
    .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
    .collect();
}

/**
 * Active members hold a seat, and so do pending invites until they expire.
 * Operator-created pending rows carry no expiry and hold their seat until
 * removed.
 */
export function holdsSeat(member: Doc<"enterpriseMembers">, at: number) {
  if (member.status === "active") return true;
  if (member.status !== "pending") return false;
  return member.inviteExpiresAt === undefined || member.inviteExpiresAt > at;
}

/**
 * Recompute a member's entitlement and drop both edge cache entries so the
 * change applies on the next request rather than after the cache TTL. The
 * cache actions no-op when Upstash is not configured.
 *
 * The routing-policy cache is dropped twice. An edge lookup that read Convex
 * before this mutation committed can write its old decision back after the
 * immediate delete, and the edge then serves it for the routing cache's 60 s
 * TTL (server/_shared/ai-routing-policy.ts). The second delete runs after the
 * same delay as the entitlement cache's race-covering resync, which outlasts
 * an edge request's Convex-read to Redis-write span.
 */
export async function applyMemberChange(ctx: MutationCtx, userId: string, now: number) {
  await recomputeEntitlementFromAllSubs(ctx, userId, now);
  await ctx.scheduler.runAfter(0, internal.payments.cacheActions.deleteEntitlementCache, { userId });
  await ctx.scheduler.runAfter(0, internal.payments.cacheActions.deleteAiRoutingPolicyCache, { userId });
  await ctx.scheduler.runAfter(
    ENTITLEMENT_CACHE_RESYNC_DELAY_MS,
    internal.payments.cacheActions.deleteAiRoutingPolicyCache,
    { userId },
  );
}

async function applyToActiveMembers(ctx: MutationCtx, accountId: Id<"enterpriseAccounts">, now: number) {
  const members = await accountMembers(ctx, accountId);
  const userIds = [...new Set(members.filter((m) => m.status === "active" && m.userId).map((m) => m.userId!))];
  for (const userId of userIds) await applyMemberChange(ctx, userId, now);
  return userIds.length;
}

/**
 * Keep one pending recompute at contractStart and one at contractEnd while
 * they are in the future. A start in the future is the only boundary nothing
 * else would notice; the end job also clears the account block and caches
 * when another entitlement source outlives the contract.
 */
async function syncContractBoundaryJobs(ctx: MutationCtx, account: Doc<"enterpriseAccounts">, now: number) {
  const patch: Partial<Doc<"enterpriseAccounts">> = {};
  for (const [field, at] of [
    ["contractStartJobId", account.contractStart],
    ["contractEndJobId", account.contractEnd],
  ] as const) {
    const stored = account[field];
    const job = stored ? await ctx.db.system.get(stored) : null;
    if (job?.state.kind === "pending") {
      if (job.scheduledTime === at) continue;
      await ctx.scheduler.cancel(job._id);
    }
    patch[field] = at > now
      ? await ctx.scheduler.runAt(at, internal.enterpriseAccounts.recomputeAccountMembers, { accountId: account._id })
      : undefined;
  }
  await ctx.db.patch(account._id, patch);
}

const termsArgs = {
  name: v.string(),
  contractStart: v.number(),
  contractEnd: v.number(),
  dailyRequestAllowance: v.number(),
  perMinuteBurst: v.number(),
  monthlyInputTokens: v.number(),
  monthlyOutputTokens: v.number(),
  overagePerThousandRequestsUsd: v.number(),
  overagePerMillionInputTokensUsd: v.number(),
  overagePerMillionOutputTokensUsd: v.number(),
  seatCap: v.number(),
  allowedProviders: v.array(v.string()),
};

/**
 *   npx convex run enterpriseAccounts:createAccount '{"name":"Hexion",
 *     "contractStart":<ms>,"contractEnd":<ms>,"dailyRequestAllowance":50000,
 *     "perMinuteBurst":300,"monthlyInputTokens":50000000,
 *     "monthlyOutputTokens":5000000,"overagePerThousandRequestsUsd":2,
 *     "overagePerMillionInputTokensUsd":4,"overagePerMillionOutputTokensUsd":20,
 *     "seatCap":10,"allowedProviders":["anthropic"]}'
 */
export const createAccount = internalMutation({
  args: { ...termsArgs, breakerMultiple: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const terms = validateTerms({ ...args, breakerMultiple: args.breakerMultiple ?? DEFAULT_BREAKER_MULTIPLE });
    const accountId = await ctx.db.insert("enterpriseAccounts", { ...terms, createdAt: now, updatedAt: now });
    await syncContractBoundaryJobs(ctx, (await ctx.db.get(accountId))!, now);
    return { accountId };
  },
});

/** Edits any subset of the account's terms; every active member is recomputed and their caches dropped. */
export const updateAccount = internalMutation({
  args: {
    accountId: v.id("enterpriseAccounts"),
    name: v.optional(v.string()),
    contractStart: v.optional(v.number()),
    contractEnd: v.optional(v.number()),
    dailyRequestAllowance: v.optional(v.number()),
    perMinuteBurst: v.optional(v.number()),
    monthlyInputTokens: v.optional(v.number()),
    monthlyOutputTokens: v.optional(v.number()),
    overagePerThousandRequestsUsd: v.optional(v.number()),
    overagePerMillionInputTokensUsd: v.optional(v.number()),
    overagePerMillionOutputTokensUsd: v.optional(v.number()),
    breakerMultiple: v.optional(v.number()),
    seatCap: v.optional(v.number()),
    allowedProviders: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { accountId, ...changes }) => {
    const now = Date.now();
    const account = await requireAccount(ctx, accountId);
    const defined = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
    const terms = validateTerms({ ...account, ...defined } as AccountTerms);
    await touchAccountLock(ctx, accountId, now);
    const seats = (await accountMembers(ctx, accountId)).filter((m) => holdsSeat(m, now)).length;
    if (terms.seatCap < seats) {
      throw new Error(`SEAT_CAP_BELOW_MEMBERS: ${seats} seats are taken; remove members before lowering the cap to ${terms.seatCap}`);
    }
    await ctx.db.patch(accountId, { ...terms, updatedAt: now });
    await syncContractBoundaryJobs(ctx, (await ctx.db.get(accountId))!, now);
    const membersUpdated = await applyToActiveMembers(ctx, accountId, now);
    return { accountId, membersUpdated };
  },
});

/** Adds a signed-up user as an active member. Idempotent for an existing active member. */
export const addMemberByUserId = internalMutation({
  args: {
    accountId: v.id("enterpriseAccounts"),
    userId: v.string(),
    role: v.optional(v.union(v.literal("admin"), v.literal("member"))),
  },
  handler: async (ctx, args) => {
    const userId = args.userId.trim();
    if (!userId) throw new Error("userId is required");
    await assertAccountWritable(ctx, userId);
    const now = Date.now();
    const account = await requireAccount(ctx, args.accountId);
    await touchAccountLock(ctx, account._id, now);

    const own = await ctx.db
      .query("enterpriseMembers")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    const elsewhere = own.find((m) => m.status === "active" && m.accountId !== account._id);
    if (elsewhere) {
      throw new Error(`ALREADY_MEMBER_OF_ANOTHER_ACCOUNT: ${userId} is active in ${elsewhere.accountId}; remove them there first`);
    }
    const existing = own.find((m) => m.accountId === account._id && m.status === "active");
    if (existing) return { memberId: existing._id, status: "already_active" as const };

    // A pending seat already held for this user is promoted, not double-counted.
    const pending = own.find((m) => m.accountId === account._id && m.status === "pending");
    let memberId: Id<"enterpriseMembers">;
    if (pending) {
      await ctx.db.patch(pending._id, { status: "active", joinedAt: now, updatedAt: now });
      memberId = pending._id;
    } else {
      const seats = (await accountMembers(ctx, account._id)).filter((m) => holdsSeat(m, now)).length;
      if (seats >= account.seatCap) {
        throw new Error(`SEAT_CAP_REACHED: ${account.name} uses ${seats} of ${account.seatCap} seats`);
      }
      memberId = await ctx.db.insert("enterpriseMembers", {
        accountId: account._id,
        userId,
        status: "active",
        role: "member",
        invitedAt: now,
        joinedAt: now,
        updatedAt: now,
      });
    }
    if (args.role === "admin") await makeAdmin(ctx, account._id, memberId, now);
    await applyMemberChange(ctx, userId, now);
    return { memberId, status: "added" as const };
  },
});

/** Removes a member (active or pending). Their entitlement and AI routing fall back at once. */
export const removeMember = internalMutation({
  args: { accountId: v.id("enterpriseAccounts"), userId: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    await requireAccount(ctx, args.accountId);
    await touchAccountLock(ctx, args.accountId, now);
    const rows = (await ctx.db
      .query("enterpriseMembers")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect()).filter((m) => m.accountId === args.accountId && (m.status === "active" || m.status === "pending"));
    if (rows.length === 0) throw new Error(`NOT_A_MEMBER: ${args.userId} holds no seat in ${args.accountId}`);
    // Admin is a role of an active member, so a removed row drops it.
    for (const row of rows) {
      await ctx.db.patch(row._id, { status: "removed", role: "member", removedAt: now, updatedAt: now });
    }
    await applyMemberChange(ctx, args.userId, now);
    return { accountId: args.accountId, userId: args.userId, removed: rows.length };
  },
});

async function makeAdmin(
  ctx: MutationCtx,
  accountId: Id<"enterpriseAccounts">,
  memberId: Id<"enterpriseMembers">,
  now: number,
) {
  for (const member of await accountMembers(ctx, accountId)) {
    if (member._id !== memberId && member.role === "admin") {
      await ctx.db.patch(member._id, { role: "member", updatedAt: now });
    }
  }
  await ctx.db.patch(memberId, { role: "admin", updatedAt: now });
}

/** Makes an active member the account's single admin; the previous admin becomes a member. */
export const setAdmin = internalMutation({
  args: { accountId: v.id("enterpriseAccounts"), userId: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    await requireAccount(ctx, args.accountId);
    await touchAccountLock(ctx, args.accountId, now);
    const target = (await ctx.db
      .query("enterpriseMembers")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect()).find((m) => m.accountId === args.accountId && m.status === "active");
    if (!target) throw new Error(`ADMIN_MUST_BE_ACTIVE_MEMBER: ${args.userId} is not an active member of ${args.accountId}`);
    await makeAdmin(ctx, args.accountId, target._id, now);
    return { accountId: args.accountId, adminUserId: args.userId };
  },
});

/** Scheduled at contractStart and contractEnd; also safe to run by hand. */
export const recomputeAccountMembers = internalMutation({
  args: { accountId: v.id("enterpriseAccounts") },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) return { membersUpdated: 0 };
    return { membersUpdated: await applyToActiveMembers(ctx, args.accountId, Date.now()) };
  },
});

/** Operator read: the account, its member rows (all statuses), seats used and contract state. */
export const getAccountWithMembers = internalQuery({
  args: { accountId: v.id("enterpriseAccounts") },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) return null;
    const members = await ctx.db
      .query("enterpriseMembers")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();
    const now = Date.now();
    return {
      account,
      members,
      seatsUsed: members.filter((m) => holdsSeat(m, now)).length,
      contractState: isContractLive(account, now)
        ? "live" as const
        : now < account.contractStart ? "not_started" as const : "ended" as const,
    };
  },
});

/** Operator read: every account, newest first. */
export const listAccounts = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query("enterpriseAccounts").order("desc").collect()),
});

/** The edge `account` block for a member of a live contract, or null. Read at cache-write time. */
export const getLiveAccountBlockByUserId = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => liveAccountBlockForUser(ctx, args.userId, Date.now()),
});
