import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "../_generated/server";
import { userIdToShard } from "../lib/shards";
import { recomputeEntitlementFromAllSubs } from "../payments/subscriptionHelpers";
import {
  ERASE_WRITE_BUDGET,
  mergeUniqueStrings,
  redactBillingPayload,
  tombstoneUserId,
} from "./registry";

const PERSONAL_DELETE_TABLES = [
  "userPreferences",
  "userPreferenceWriteRateLimits",
  "notificationChannels",
  "alertRules",
  "telegramPairingTokens",
  "userApiKeys",
  "embedKeys",
  "mcpProTokens",
  "userReferralCodes",
  "userReferralCredits",
  "entitlements",
  "apiUsageRollups",
  "apiPlanLimitNotices",
  "checkoutAdmissions",
  "followedCountriesUserMeta",
  "users",
] as const;

type PersonalDeleteTable = (typeof PERSONAL_DELETE_TABLES)[number];

type DeletionDoc = Doc<"accountDeletions">;

async function takePersonalRows(
  ctx: MutationCtx,
  table: PersonalDeleteTable,
  userId: string,
  limit: number,
): Promise<Array<Doc<PersonalDeleteTable>>> {
  switch (table) {
    case "userPreferences":
      return ctx.db
        .query("userPreferences")
        .withIndex("by_user_variant", (q) => q.eq("userId", userId))
        .take(limit);
    case "userPreferenceWriteRateLimits":
      return ctx.db
        .query("userPreferenceWriteRateLimits")
        .withIndex("by_user_window", (q) => q.eq("userId", userId))
        .take(limit);
    case "notificationChannels":
      return ctx.db
        .query("notificationChannels")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(limit);
    case "alertRules":
      return ctx.db
        .query("alertRules")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(limit);
    case "telegramPairingTokens":
      return ctx.db
        .query("telegramPairingTokens")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(limit);
    case "userApiKeys":
      return ctx.db
        .query("userApiKeys")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(limit);
    case "embedKeys":
      return ctx.db
        .query("embedKeys")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(limit);
    case "mcpProTokens":
      return ctx.db
        .query("mcpProTokens")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(limit);
    case "userReferralCodes":
      return ctx.db
        .query("userReferralCodes")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(limit);
    case "userReferralCredits":
      return ctx.db
        .query("userReferralCredits")
        .withIndex("by_referrer", (q) => q.eq("referrerUserId", userId))
        .take(limit);
    case "entitlements":
      return ctx.db
        .query("entitlements")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(limit);
    case "apiUsageRollups":
      return ctx.db
        .query("apiUsageRollups")
        .withIndex("by_user_window", (q) => q.eq("userId", userId))
        .take(limit);
    case "apiPlanLimitNotices":
      return ctx.db
        .query("apiPlanLimitNotices")
        .withIndex("by_user_dimension_current", (q) => q.eq("userId", userId))
        .take(limit);
    case "checkoutAdmissions":
      return ctx.db
        .query("checkoutAdmissions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(limit);
    case "followedCountriesUserMeta":
      return ctx.db
        .query("followedCountriesUserMeta")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(limit);
    case "users":
      return ctx.db
        .query("users")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(limit);
    default: {
      const exhaustive: never = table;
      throw new Error(`Unhandled personal table: ${exhaustive}`);
    }
  }
}

async function decrementCountryCountIfSeeded(
  ctx: MutationCtx,
  country: string,
): Promise<number> {
  const lock = await ctx.db
    .query("followedCountriesCountryLocks")
    .withIndex("by_country", (q) => q.eq("country", country))
    .first();
  if (!lock) {
    console.warn(
      JSON.stringify({
        breadcrumb: "account_deletion_follow_count_skipped",
        country,
        reason: "country_lock_missing",
      }),
    );
    return 0;
  }

  const rows = await ctx.db
    .query("followedCountriesCounts")
    .withIndex("by_country", (q) => q.eq("country", country))
    .collect();
  rows.sort((a, b) => a._creationTime - b._creationTime);
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const nextCount = Math.max(0, total - 1);
  const now = Date.now();
  let writes = 0;
  const primary = rows[0];
  if (primary) {
    await ctx.db.patch(primary._id, { count: nextCount, updatedAt: now });
    writes += 1;
    for (let i = 1; i < rows.length; i++) {
      const duplicate = rows[i];
      if (duplicate) {
        await ctx.db.delete(duplicate._id);
        writes += 1;
      }
    }
  }
  await ctx.db.patch(lock._id, { lastTouchedAt: now });
  return writes + 1;
}

async function touchFollowShardIfSeeded(
  ctx: MutationCtx,
  userId: string,
): Promise<number> {
  const shardId = userIdToShard(userId);
  const shard = await ctx.db
    .query("followedCountriesShards")
    .withIndex("by_shard", (q) => q.eq("shardId", shardId))
    .first();
  if (!shard) {
    console.warn(
      JSON.stringify({
        breadcrumb: "account_deletion_follow_shard_skipped",
        shardId,
        reason: "shard_missing",
      }),
    );
    return 0;
  }
  await ctx.db.patch(shard._id, { lastTouchedAt: Date.now() });
  return 1;
}

async function eraseFollows(
  ctx: MutationCtx,
  deletion: DeletionDoc,
  budget: number,
): Promise<{ writes: number; done: boolean }> {
  const followBudget = Math.max(1, Math.floor(budget / 4));
  const rows = await ctx.db
    .query("followedCountries")
    .withIndex("by_user", (q) => q.eq("userId", deletion.userId))
    .take(followBudget);
  if (rows.length === 0) {
    return { writes: 0, done: true };
  }

  let writes = 0;
  for (const row of rows) {
    await ctx.db.delete(row._id);
    writes += 1;
    writes += await decrementCountryCountIfSeeded(ctx, row.country);
    if (writes >= budget) break;
  }
  writes += await touchFollowShardIfSeeded(ctx, deletion.userId);
  const remaining = await ctx.db
    .query("followedCountries")
    .withIndex("by_user", (q) => q.eq("userId", deletion.userId))
    .take(1);
  return { writes, done: remaining.length === 0 };
}

async function erasePersonal(
  ctx: MutationCtx,
  deletion: DeletionDoc,
  budget: number,
): Promise<{ writes: number; nextTableIndex: number; done: boolean }> {
  let tableIndex = deletion.personalTableIndex ?? 0;
  let writes = 0;
  while (tableIndex < PERSONAL_DELETE_TABLES.length && writes < budget) {
    const table = PERSONAL_DELETE_TABLES[tableIndex];
    if (!table) break;
    const remaining = budget - writes;
    const rows = await takePersonalRows(ctx, table, deletion.userId, remaining);
    if (table === "userApiKeys") {
      writes += await mergeDeletionStrings(
        ctx,
        deletion._id,
        "keyHashes",
        rows.map((row) => (row as Doc<"userApiKeys">).keyHash),
      );
    } else if (table === "embedKeys") {
      writes += await mergeDeletionStrings(
        ctx,
        deletion._id,
        "embedKeyHashes",
        rows.map((row) => (row as Doc<"embedKeys">).keyHash),
      );
    } else if (table === "mcpProTokens") {
      writes += await mergeDeletionStrings(
        ctx,
        deletion._id,
        "mcpTokenIds",
        rows.map((row) => String(row._id)),
      );
    }
    for (const row of rows) {
      await ctx.db.delete(row._id);
      writes += 1;
    }
    if (rows.length < remaining) {
      tableIndex += 1;
    } else {
      break;
    }
  }
  return {
    writes,
    nextTableIndex: tableIndex,
    done: tableIndex >= PERSONAL_DELETE_TABLES.length,
  };
}

async function collectGrantIds(
  ctx: MutationCtx,
  deletion: DeletionDoc,
): Promise<Id<"businessProGrants">[]> {
  const ids = new Set<string>();
  const grants: Doc<"businessProGrants">[] = [];

  const dodoSubscriptionIds = deletion.dodoSubscriptionIds ?? [];
  for (const dodoSubscriptionId of dodoSubscriptionIds) {
    const owned = await ctx.db
      .query("businessProGrants")
      .withIndex("by_businessSubscriptionId", (q) =>
        q.eq("businessSubscriptionId", dodoSubscriptionId),
      )
      .take(ERASE_WRITE_BUDGET);
    for (const grant of owned) grants.push(grant);
  }

  const asInvitee = await ctx.db
    .query("businessProGrants")
    .withIndex("by_inviteeUserId", (q) => q.eq("inviteeUserId", deletion.userId))
    .take(ERASE_WRITE_BUDGET);
  for (const grant of asInvitee) grants.push(grant);

  if (deletion.verifiedEmail) {
    const byEmail = await ctx.db
      .query("businessProGrants")
      .withIndex("by_inviteeEmail", (q) =>
        q.eq("inviteeEmail", deletion.verifiedEmail!),
      )
      .take(ERASE_WRITE_BUDGET);
    for (const grant of byEmail) grants.push(grant);
  }

  const unique: Doc<"businessProGrants">[] = [];
  for (const grant of grants) {
    if (ids.has(grant._id)) continue;
    ids.add(grant._id);
    unique.push(grant);
  }
  return unique.map((grant) => grant._id);
}

async function eraseGrants(
  ctx: MutationCtx,
  deletion: DeletionDoc,
  budget: number,
): Promise<{ writes: number; done: boolean }> {
  const grantIds = await collectGrantIds(ctx, deletion);
  let writes = 0;
  for (const grantId of grantIds) {
    if (writes >= budget) break;
    const existing = await ctx.db.get(grantId);
    if (existing) {
      const inviteeUserId = existing.status === "accepted"
        ? existing.inviteeUserId
        : undefined;
      const deletingInvitee = inviteeUserId && inviteeUserId !== deletion.userId
        ? await ctx.db.query("accountDeletions")
          .withIndex("by_userId", (q) => q.eq("userId", inviteeUserId))
          .first()
        : null;
      const recomputeInvitee = inviteeUserId && inviteeUserId !== deletion.userId && !deletingInvitee;
      if (recomputeInvitee && writes + 2 > budget) break;
      await ctx.db.delete(grantId);
      writes += 1;
      if (recomputeInvitee) {
        await recomputeEntitlementFromAllSubs(ctx, inviteeUserId, Date.now());
        writes += 1;
      }
    }
  }
  const leftover = await collectGrantIds(ctx, deletion);
  return { writes, done: leftover.length === 0 };
}

async function anonymizeBilling(
  ctx: MutationCtx,
  deletion: DeletionDoc,
  budget: number,
): Promise<{ writes: number; done: boolean }> {
  const replacement = tombstoneUserId(deletion.userIdHash);
  let writes = 0;

  const customers = await ctx.db
    .query("customers")
    .withIndex("by_userId", (q) => q.eq("userId", deletion.userId))
    .take(budget - writes);
  for (const row of customers) {
    await ctx.db.patch(row._id, {
      userId: replacement,
      email: replacement,
      normalizedEmail: replacement,
      updatedAt: Date.now(),
    });
    writes += 1;
    if (writes >= budget) return { writes, done: false };
  }

  const subscriptions = await ctx.db
    .query("subscriptions")
    .withIndex("by_userId", (q) => q.eq("userId", deletion.userId))
    .take(budget - writes);
  for (const row of subscriptions) {
    await ctx.db.patch(row._id, {
      userId: replacement,
      rawPayload: redactBillingPayload(row.rawPayload),
      updatedAt: Date.now(),
    });
    writes += 1;
    if (writes >= budget) return { writes, done: false };
  }

  const payments = await ctx.db
    .query("paymentEvents")
    .withIndex("by_userId", (q) => q.eq("userId", deletion.userId))
    .take(budget - writes);
  for (const row of payments) {
    await ctx.db.patch(row._id, {
      userId: replacement,
      rawPayload: redactBillingPayload(row.rawPayload),
    });
    writes += 1;
    if (writes >= budget) return { writes, done: false };
  }

  const deletedCustomers = await ctx.db
    .query("deletedSubscriptionCustomers")
    .withIndex("by_userId", (q) => q.eq("userId", deletion.userId))
    .take(budget - writes);
  for (const row of deletedCustomers) {
    await ctx.db.patch(row._id, { userId: replacement });
    writes += 1;
    if (writes >= budget) return { writes, done: false };
  }

  const dodoSubscriptionIds = deletion.dodoSubscriptionIds ?? [];
  for (const dodoSubscriptionId of dodoSubscriptionIds) {
    const dunning = await ctx.db
      .query("dunningEmails")
      .withIndex("by_sub_step_episode", (q) =>
        q.eq("dodoSubscriptionId", dodoSubscriptionId),
      )
      .filter((q) => q.neq(q.field("email"), replacement))
      .take(budget - writes);
    for (const row of dunning) {
      await ctx.db.patch(row._id, { email: replacement });
      writes += 1;
      if (writes >= budget) return { writes, done: false };
    }
  }

  const subscriptionDocIds = deletion.subscriptionDocIds ?? [];
  for (const subscriptionId of subscriptionDocIds) {
    const presentations = await ctx.db
      .query("proActivationPresentations")
      .withIndex("by_subscription_cohort", (q) =>
        q.eq("subscriptionId", subscriptionId),
      )
      .take(budget - writes);
    for (const row of presentations) {
      await ctx.db.delete(row._id);
      writes += 1;
      if (writes >= budget) return { writes, done: false };
    }
  }

  const stillLiveCustomers = await ctx.db
    .query("customers")
    .withIndex("by_userId", (q) => q.eq("userId", deletion.userId))
    .take(1);
  const stillLiveSubs = await ctx.db
    .query("subscriptions")
    .withIndex("by_userId", (q) => q.eq("userId", deletion.userId))
    .take(1);
  const stillLivePayments = await ctx.db
    .query("paymentEvents")
    .withIndex("by_userId", (q) => q.eq("userId", deletion.userId))
    .take(1);
  const stillLiveDeletedCustomers = await ctx.db
    .query("deletedSubscriptionCustomers")
    .withIndex("by_userId", (q) => q.eq("userId", deletion.userId))
    .take(1);

  let leftoverDunning = false;
  for (const dodoSubscriptionId of dodoSubscriptionIds) {
    const rows = await ctx.db
      .query("dunningEmails")
      .withIndex("by_sub_step_episode", (q) =>
        q.eq("dodoSubscriptionId", dodoSubscriptionId),
      )
      .filter((q) => q.neq(q.field("email"), replacement))
      .take(1);
    if (rows.length > 0) {
      leftoverDunning = true;
      break;
    }
  }

  let leftoverPresentations = false;
  for (const subscriptionId of subscriptionDocIds) {
    const rows = await ctx.db
      .query("proActivationPresentations")
      .withIndex("by_subscription_cohort", (q) =>
        q.eq("subscriptionId", subscriptionId),
      )
      .take(1);
    if (rows.length > 0) {
      leftoverPresentations = true;
      break;
    }
  }

  return {
    writes,
    done:
      stillLiveCustomers.length === 0 &&
      stillLiveSubs.length === 0 &&
      stillLivePayments.length === 0 &&
      stillLiveDeletedCustomers.length === 0 &&
      !leftoverDunning &&
      !leftoverPresentations,
  };
}

async function eraseEmailKeyed(
  ctx: MutationCtx,
  deletion: DeletionDoc,
  budget: number,
): Promise<{ writes: number; done: boolean }> {
  const email = deletion.verifiedEmail;
  if (!email) return { writes: 0, done: true };

  let writes = 0;
  const referralCredits = await ctx.db
    .query("userReferralCredits")
    .withIndex("by_refereeEmail", (q) => q.eq("refereeEmail", email))
    .take(budget - writes);
  for (const row of referralCredits) {
    await ctx.db.patch(row._id, {
      refereeEmail: tombstoneUserId(deletion.userIdHash),
    });
    writes += 1;
    if (writes >= budget) return { writes, done: false };
  }
  const registrations = await ctx.db
    .query("registrations")
    .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", email))
    .take(budget - writes);
  for (const row of registrations) {
    await ctx.db.delete(row._id);
    writes += 1;
    if (writes >= budget) return { writes, done: false };
  }

  const contacts = await ctx.db
    .query("contactMessages")
    .withIndex("by_normalized_email_received", (q) =>
      q.eq("normalizedEmail", email),
    )
    .take(budget - writes);
  for (const row of contacts) {
    await ctx.db.delete(row._id);
    writes += 1;
    if (writes >= budget) return { writes, done: false };
  }

  const leftoverReg = await ctx.db
    .query("registrations")
    .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", email))
    .take(1);
  const leftoverContact = await ctx.db
    .query("contactMessages")
    .withIndex("by_normalized_email_received", (q) =>
      q.eq("normalizedEmail", email),
    )
    .take(1);
  return {
    writes,
    done: leftoverReg.length === 0 && leftoverContact.length === 0,
  };
}

async function mergeDeletionStrings(
  ctx: MutationCtx,
  deletionId: Id<"accountDeletions">,
  field: "keyHashes" | "embedKeyHashes" | "mcpTokenIds",
  extras: string[],
): Promise<number> {
  if (extras.length === 0) return 0;
  const row = await ctx.db.get(deletionId);
  if (!row) return 0;
  const current = row[field] ?? [];
  const merged = mergeUniqueStrings(current, extras);
  if (merged.length === current.length) return 0;
  await ctx.db.patch(deletionId, { [field]: merged, updatedAt: Date.now() });
  return 1;
}

async function patchDeletion(
  ctx: MutationCtx,
  deletionId: Id<"accountDeletions">,
  patch: Partial<DeletionDoc>,
): Promise<void> {
  await ctx.db.patch(deletionId, { ...patch, updatedAt: Date.now() });
}

export async function runEraseBatch(
  ctx: MutationCtx,
  deletionId: Id<"accountDeletions">,
): Promise<DeletionDoc | null> {
  const deletion = await ctx.db.get(deletionId);
  if (!deletion) return null;
  if (deletion.status !== "pending") return deletion;

  let current = deletion;
  let remaining = ERASE_WRITE_BUDGET;

  if (current.step === "follows" && remaining > 0) {
    const result = await eraseFollows(ctx, current, remaining);
    remaining -= result.writes;
    if (result.done) {
      await patchDeletion(ctx, deletionId, { step: "personal", personalTableIndex: 0 });
      current = (await ctx.db.get(deletionId))!;
    } else {
      return current;
    }
  }

  if (current.step === "personal" && remaining > 0) {
    const result = await erasePersonal(ctx, current, remaining);
    remaining -= result.writes;
    if (result.done) {
      await patchDeletion(ctx, deletionId, {
        step: "grants",
        personalTableIndex: result.nextTableIndex,
      });
      current = (await ctx.db.get(deletionId))!;
    } else {
      await patchDeletion(ctx, deletionId, {
        personalTableIndex: result.nextTableIndex,
      });
      return (await ctx.db.get(deletionId))!;
    }
  }

  if (current.step === "grants" && remaining > 0) {
    const result = await eraseGrants(ctx, current, remaining);
    remaining -= result.writes;
    if (result.done) {
      await patchDeletion(ctx, deletionId, { step: "anonymize" });
      current = (await ctx.db.get(deletionId))!;
    } else {
      return current;
    }
  }

  if (current.step === "anonymize" && remaining > 0) {
    const result = await anonymizeBilling(ctx, current, remaining);
    remaining -= result.writes;
    if (result.done) {
      await patchDeletion(ctx, deletionId, { step: "email_keyed" });
      current = (await ctx.db.get(deletionId))!;
    } else {
      return current;
    }
  }

  if (current.step === "email_keyed" && remaining > 0) {
    const result = await eraseEmailKeyed(ctx, current, remaining);
    remaining -= result.writes;
    if (!result.done) return current;
    await patchDeletion(ctx, deletionId, {
      step: "external",
      lastError: undefined,
    });
    return await ctx.db.get(deletionId);
  }

  return await ctx.db.get(deletionId);
}

export async function scheduleEraseContinuation(
  ctx: MutationCtx,
  after: DeletionDoc,
): Promise<void> {
  if (after.status !== "pending") return;
  if (after.step === "external") {
    await ctx.scheduler.runAfter(
      0,
      internal.accountDeletion.sideEffects.runExternalErase,
      { deletionId: after._id },
    );
    return;
  }
  await ctx.scheduler.runAfter(0, internal.accountDeletion.batches.advanceEraseSafely, {
    deletionId: after._id,
  });
}

export const advanceErase = internalMutation({
  args: { deletionId: v.id("accountDeletions") },
  returns: v.object({
    status: v.union(
      v.literal("pending"),
      v.literal("complete"),
      v.literal("failed"),
      v.literal("missing"),
    ),
    step: v.union(
      v.literal("follows"),
      v.literal("personal"),
      v.literal("grants"),
      v.literal("anonymize"),
      v.literal("email_keyed"),
      v.literal("external"),
      v.literal("complete"),
      v.null(),
    ),
  }),
  handler: async (ctx, args) => {
    const before = await ctx.db.get(args.deletionId);
    const after = await runEraseBatch(ctx, args.deletionId);
    if (!after) return { status: "missing" as const, step: null };
    if (after.status === "pending") {
      // A page can delete rows without advancing its table/step cursor. Stamp
      // every committed page, even within one millisecond, so a stale action's
      // failure cannot overwrite this transaction's successful progress.
      await ctx.db.patch(after._id, {
        updatedAt: Math.max(Date.now(), before?.updatedAt ?? 0, after.updatedAt) + 1,
      });
    }
    await scheduleEraseContinuation(ctx, after);
    return { status: after.status, step: after.step };
  },
});

export const getBatchSnapshot = internalQuery({
  args: { deletionId: v.id("accountDeletions") },
  handler: async (ctx, args): Promise<{
    step: DeletionDoc["step"];
    personalTableIndex?: number;
    updatedAt: number;
  } | null> => {
    const row = await ctx.db.get(args.deletionId);
    if (!row || row.status !== "pending") return null;
    return { step: row.step, personalTableIndex: row.personalTableIndex, updatedAt: row.updatedAt };
  },
});

export const markBatchFailed = internalMutation({
  args: {
    deletionId: v.id("accountDeletions"),
    step: v.string(),
    personalTableIndex: v.optional(v.number()),
    updatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.deletionId);
    // A separate continuation or explicit retry may have advanced since the
    // action read its snapshot. Never overwrite that newer progress.
    if (!row || row.status !== "pending" || row.step !== args.step
      || row.personalTableIndex !== args.personalTableIndex || row.updatedAt !== args.updatedAt) return;
    await ctx.db.patch(row._id, {
      status: "failed",
      lastError: "ERASE_BATCH_FAILED",
      updatedAt: Date.now(),
    });
  },
});

export const advanceEraseSafely = internalAction({
  args: { deletionId: v.id("accountDeletions") },
  handler: async (ctx, args): Promise<void> => {
    const snapshot = await ctx.runQuery(internal.accountDeletion.batches.getBatchSnapshot, args);
    if (!snapshot) return;
    try {
      await ctx.runMutation(internal.accountDeletion.batches.advanceErase, args);
    } catch {
      // sentry-coverage-ok: persist the failure for the status UI and explicit
      // retry. The failed mutation rolls back all batch writes before this
      // separate transaction records failure; no unbounded retry is queued.
      await ctx.runMutation(internal.accountDeletion.batches.markBatchFailed, {
        ...args, ...snapshot,
      });
    }
  },
});
