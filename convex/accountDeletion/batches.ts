import { ConvexError, v } from "convex/values";
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
  PENDING_STALE_AFTER_MS,
  mergeUniqueStrings,
  normalizeVerifiedEmail,
  redactBillingPayload,
  tombstoneUserId,
} from "./registry";

/**
 * Tables the generic personal-delete stepper walks.
 *
 * Exported so `accountDeletion.test.ts` can cross-check it against
 * ACCOUNT_DELETION_REGISTRY. The registry's header states that adding a table
 * means updating both files, and nothing enforced that until that test existed.
 */
export const PERSONAL_DELETE_TABLES = [
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

/** Bounded retries for a thrown batch before the deletion goes terminal. */
const MAX_BATCH_ATTEMPTS = 5;
const BATCH_RETRY_BASE_DELAY_MS = 2_000;
const BATCH_RETRY_MAX_DELAY_MS = 60_000;

function batchRetryDelayMs(attempts: number): number {
  return Math.min(
    BATCH_RETRY_MAX_DELAY_MS,
    BATCH_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1),
  );
}

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
  // One country per transaction. followedCountriesCounts and its country lock
  // are globally shared, write-hot rows (convex/users.ts documents 1,618
  // conflicts in a day on this table class), so batching many of them into one
  // transaction multiplies the chance that the whole batch loses an optimistic
  // -concurrency retry. Paging one at a time keeps each transaction's shared
  // write set at a single aggregate row plus its lock; the step repeats until
  // `done`, so the extra transactions cost scheduling, not correctness.
  const rows = await ctx.db
    .query("followedCountries")
    .withIndex("by_user", (q) => q.eq("userId", deletion.userId))
    .take(1);
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
  const remaining = await ctx.db
    .query("followedCountries")
    .withIndex("by_user", (q) => q.eq("userId", deletion.userId))
    .take(1);
  const done = remaining.length === 0;
  // The shard row is shared by every user in the shard, so touch it once when
  // the step finishes rather than on each single-country page.
  if (done) {
    writes += await touchFollowShardIfSeeded(ctx, deletion.userId);
  }
  return { writes, done };
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
      !leftoverPresentations,
  };
}

async function eraseEmailKeyed(
  ctx: MutationCtx,
  deletion: DeletionDoc,
  budget: number,
): Promise<{ writes: number; done: boolean }> {
  const email = deletion.verifiedEmail;
  if (!email) {
    // No verified proof of this subject's address was captured before Clerk
    // removed the user — the webhook path never has one. Matching waitlist and
    // contact rows on a cached profile address instead would risk deleting a
    // third party's data, which is exactly why this engine refuses to. But
    // completing silently made the gap permanent AND invisible: every later
    // entry point skips the Clerk lookup once a deletion row exists, so no
    // amount of re-running the runbook command repairs it. Record it instead.
    if (!deletion.emailKeyedSkipped) {
      await ctx.db.patch(deletion._id, { emailKeyedSkipped: true });
      return { writes: 1, done: true };
    }
    return { writes: 0, done: true };
  }
  // An operator supplied confirmed proof; the gap is closed.
  if (deletion.emailKeyedSkipped) {
    await ctx.db.patch(deletion._id, { emailKeyedSkipped: undefined });
  }

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
      // Committed progress also clears the retry counter: the ladder in
      // markBatchFailed counts consecutive failures, not lifetime ones.
      await ctx.db.patch(after._id, {
        batchAttempts: undefined,
        updatedAt: Math.max(Date.now(), before?.updatedAt ?? 0, after.updatedAt) + 1,
      });
    }
    await scheduleEraseContinuation(ctx, after);
    return { status: after.status, step: after.step };
  },
});

type BatchSnapshot = {
  step: DeletionDoc["step"];
  personalTableIndex?: number;
  updatedAt: number;
};

export const getBatchSnapshot = internalQuery({
  args: { deletionId: v.id("accountDeletions") },
  handler: async (ctx, args): Promise<BatchSnapshot | null> => {
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
  returns: v.union(v.literal("retrying"), v.literal("failed"), v.literal("stale")),
  handler: async (ctx, args): Promise<"retrying" | "failed" | "stale"> => {
    const row = await ctx.db.get(args.deletionId);
    // A separate continuation or explicit retry may have advanced since the
    // action read its snapshot. Never overwrite that newer progress.
    if (!row || row.status !== "pending" || row.step !== args.step
      || row.personalTableIndex !== args.personalTableIndex || row.updatedAt !== args.updatedAt) {
      // `updatedAt` is also bumped by writers outside this pipeline — a late
      // Dodo event patches it on an already-pending row and schedules nothing.
      // When that lands between the snapshot and the failure, the batch that
      // just threw would otherwise be forgotten: no attempt recorded, no
      // continuation queued, row pending forever. Re-arm instead. Re-running a
      // step is safe because every stepper re-queries its leftovers.
      // Delayed, not immediate: this branch records no attempt, so it has no
      // counter of its own to stop it. A writer bumping `updatedAt` on every
      // pass would otherwise spin a zero-delay reschedule loop.
      if (row && row.status === "pending") {
        await ctx.scheduler.runAfter(
          BATCH_RETRY_BASE_DELAY_MS,
          internal.accountDeletion.batches.advanceEraseSafely,
          { deletionId: row._id },
        );
      }
      return "stale";
    }

    // A batch throw is usually a lost optimistic-concurrency retry on a shared
    // aggregate row, not a broken deletion. Going terminal on the first one
    // strands a half-erased account behind the write fence with its
    // subscription still billing, so retry a bounded number of times first.
    // Counted rather than classified on purpose: Convex does not expose a
    // stable, documented discriminator for an exhausted OCC retry, and a
    // counter is correct whatever the cause.
    const attempts = (row.batchAttempts ?? 0) + 1;
    if (attempts < MAX_BATCH_ATTEMPTS) {
      await ctx.db.patch(row._id, {
        batchAttempts: attempts,
        lastError: "ERASE_BATCH_RETRY",
        // Advance past the stamp this call matched on, the same guarantee
        // advanceErase makes. A bare Date.now() can land in the same
        // millisecond, leaving the row matchable by another in-flight action
        // holding the identical snapshot, which would burn a second attempt
        // for one failure.
        updatedAt: Math.max(Date.now(), row.updatedAt) + 1,
      });
      await ctx.scheduler.runAfter(
        batchRetryDelayMs(attempts),
        internal.accountDeletion.batches.advanceEraseSafely,
        { deletionId: row._id },
      );
      return "retrying";
    }

    await ctx.db.patch(row._id, {
      status: "failed",
      batchAttempts: attempts,
      lastError: "ERASE_BATCH_FAILED",
      updatedAt: Date.now(),
    });
    return "failed";
  },
});

/**
 * Finish email-keyed cleanup for a deletion that ran without verified proof.
 *
 * A `user.deleted` webhook arrives after Clerk has already destroyed the
 * subject, so `beginErase` has no address to attribute waitlist, contact-form
 * or invitee-email-keyed rows with, and every later entry point skips the Clerk
 * lookup once a deletion row exists. Those rows would otherwise survive
 * forever with no command able to remove them.
 *
 * The email is an argument for the same reason the Clerk subject is an argument
 * to `eraseConfirmedUser`: a human confirms it out of band first. Do not pass a
 * cached profile address — that is precisely the proof this engine refuses.
 *
 * Idempotent and budgeted. Both steppers re-query their own leftovers, so
 * re-running is safe and rows already erased are simply not found; it
 * reschedules itself until both report done.
 */
export const completeEmailKeyedErasure = internalMutation({
  args: { userId: v.string(), verifiedEmail: v.string() },
  returns: v.object({
    status: v.union(v.literal("done"), v.literal("continuing"), v.literal("missing")),
    writes: v.number(),
  }),
  handler: async (ctx, args): Promise<{
    status: "done" | "continuing" | "missing";
    writes: number;
  }> => {
    const email = normalizeVerifiedEmail(args.verifiedEmail);
    if (!email) throw new ConvexError("VERIFIED_EMAIL_REQUIRED");

    const row = await ctx.db
      .query("accountDeletions")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId.trim()))
      .unique();
    if (!row) return { status: "missing" as const, writes: 0 };

    if (row.verifiedEmail !== email) {
      await ctx.db.patch(row._id, { verifiedEmail: email });
    }
    const withProof = await ctx.db.get(row._id);
    if (!withProof) return { status: "missing" as const, writes: 0 };

    // Grants first: collectGrantIds only sweeps by_inviteeEmail once the row
    // carries a verified address, so this is the pass that was skipped.
    const grants = await eraseGrants(ctx, withProof, ERASE_WRITE_BUDGET);
    const remaining = ERASE_WRITE_BUDGET - grants.writes;
    const keyed = remaining > 0
      ? await eraseEmailKeyed(ctx, withProof, remaining)
      : { writes: 0, done: false };

    const writes = grants.writes + keyed.writes;
    const done = grants.done && keyed.done;
    if (!done) {
      await ctx.scheduler.runAfter(
        0,
        internal.accountDeletion.batches.completeEmailKeyedErasure,
        { userId: args.userId, verifiedEmail: email },
      );
    }
    return { status: done ? "done" as const : "continuing" as const, writes };
  },
});

/** How many stalled deletions one sweeper tick will re-arm. */
const REAP_STALLED_LIMIT = 20;

/**
 * Bounded recovery for deletions whose scheduled continuation was dropped.
 *
 * Without this, the `by_status_updatedAt` index had no reader and the only way
 * back from a lost continuation was the deleting user happening to click again,
 * or support running the runbook — while the account sat write-fenced, already
 * anonymized, with its subscription still billing. Mirrors the existing
 * company-monitoring stalled-purge reaper.
 *
 * Safe to re-run: `scheduleEraseContinuation` only acts on `pending` rows, and
 * every stepper re-queries its own leftovers, so a duplicate wake is a no-op
 * rather than a second erase. The staleness bound is the same one `beginErase`
 * uses, so a live retry backoff is never doubled.
 */
export const reapStalledDeletions = internalMutation({
  args: {},
  returns: v.object({ rearmed: v.number() }),
  handler: async (ctx): Promise<{ rearmed: number }> => {
    const cutoff = Date.now() - PENDING_STALE_AFTER_MS;
    const stalled = await ctx.db
      .query("accountDeletions")
      .withIndex("by_status_updatedAt", (q) =>
        q.eq("status", "pending").lt("updatedAt", cutoff),
      )
      .take(REAP_STALLED_LIMIT);

    for (const row of stalled) {
      // Bump first so the next tick does not re-arm the same row while this
      // continuation is still starting.
      await ctx.db.patch(row._id, { updatedAt: Date.now() });
      const rearmed = await ctx.db.get(row._id);
      if (rearmed) await scheduleEraseContinuation(ctx, rearmed);
    }

    if (stalled.length > 0) {
      // sentry-coverage-ok: structured console.error is forwarded by Convex.
      // Re-arming is the recovery, but a deletion that stalled at all is an
      // operator signal — silence here is how the original gap stayed invisible.
      console.error(JSON.stringify({
        breadcrumb: "account_deletion_stalled_rearmed",
        count: stalled.length,
        deletionIds: stalled.map((row) => row._id),
      }));
    }
    return { rearmed: stalled.length };
  },
});

export const advanceEraseSafely = internalAction({
  args: { deletionId: v.id("accountDeletions") },
  handler: async (ctx, args): Promise<void> => {
    // The snapshot read is inside the try with everything else: a throw here
    // (a transient Convex failure, an exhausted OCC retry, a stale internal.*
    // reference after a deploy) used to escape the handler, recording no
    // failure and scheduling nothing. The row then sat at `pending` looking
    // like a healthy in-progress deletion, with the write fence on and the
    // Clerk login still live, and beginErase's early return made re-running
    // the operator command a no-op.
    let snapshot: BatchSnapshot | null = null;
    try {
      snapshot = await ctx.runQuery(internal.accountDeletion.batches.getBatchSnapshot, args);
      if (!snapshot) return;
      await ctx.runMutation(internal.accountDeletion.batches.advanceErase, args);
    } catch (err) {
      if (!snapshot) {
        // The snapshot read itself failed, so there is no cursor to match on
        // and markBatchFailed would be unsafe. Leave the row untouched and let
        // the staleness re-arm in beginErase recover it.
        console.error(JSON.stringify({
          breadcrumb: "account_deletion_batch_snapshot_failed",
          deletionId: args.deletionId,
          error: err instanceof Error ? err.message : String(err),
        }));
        return;
      }
      // sentry-coverage-ok: persist the failure for the status UI and the
      // bounded retry ladder. The failed mutation rolls back all batch writes
      // before this separate transaction records the attempt.
      const outcome = await ctx.runMutation(internal.accountDeletion.batches.markBatchFailed, {
        ...args, ...snapshot,
      });
      if (outcome === "failed") {
        console.error(JSON.stringify({
          breadcrumb: "account_deletion_batch_failed",
          deletionId: args.deletionId,
          step: snapshot.step,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    }
  },
});
