import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "../_generated/server";
import { applyOwnerDeletedFence } from "../companyMonitoring/accounts";
import { requireUserId, resolveUserId } from "../lib/auth";
import { runEraseBatch, scheduleEraseContinuation } from "./batches";
import {
  normalizeVerifiedEmail,
  sha256Hex,
} from "./registry";

const eraseSourceValidator = v.union(
  v.literal("support"),
  v.literal("clerk_webhook"),
);

const eraseResultValidator = v.object({
  status: v.union(
    v.literal("pending"),
    v.literal("complete"),
    v.literal("already_deleted"),
  ),
  userIdHash: v.string(),
});

type EraseResult = {
  status: "pending" | "complete" | "already_deleted";
  userIdHash: string;
};

function requireNonEmptyUserId(userId: string): string {
  const trimmed = userId.trim();
  if (!trimmed) {
    throw new ConvexError("USER_ID_REQUIRED");
  }
  return trimmed;
}

async function loadSubscriptions(ctx: MutationCtx, userId: string) {
  return ctx.db
    .query("subscriptions")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .take(256);
}

async function captureVerifiedEmail(
  ctx: MutationCtx,
  userId: string,
  fallbackEmail?: string,
): Promise<string | undefined> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  return (
    normalizeVerifiedEmail(user?.normalizedEmail) ??
    normalizeVerifiedEmail(user?.email) ??
    normalizeVerifiedEmail(fallbackEmail)
  );
}

async function scheduleAdvance(
  ctx: MutationCtx,
  deletionId: Id<"accountDeletions">,
): Promise<void> {
  const row = await ctx.db.get(deletionId);
  if (!row) return;
  await scheduleEraseContinuation(ctx, row);
}

async function beginErase(
  ctx: MutationCtx,
  userId: string,
  source: Doc<"accountDeletions">["source"],
  fallbackEmail?: string,
): Promise<EraseResult> {
  const confirmedUserId = requireNonEmptyUserId(userId);
  const existing = await ctx.db
    .query("accountDeletions")
    .withIndex("by_userId", (q) => q.eq("userId", confirmedUserId))
    .unique();

  if (existing?.status === "complete") {
    return { status: "already_deleted", userIdHash: existing.userIdHash };
  }

  const now = Date.now();
  const userIdHash = existing?.userIdHash ?? (await sha256Hex(confirmedUserId));
  const verifiedEmail =
    existing?.verifiedEmail ??
    (await captureVerifiedEmail(ctx, confirmedUserId, fallbackEmail));
  const subscriptions =
    existing?.dodoSubscriptionIds && existing.subscriptionDocIds
      ? null
      : await loadSubscriptions(ctx, confirmedUserId);

  let deletionId: Id<"accountDeletions">;
  if (existing) {
    deletionId = existing._id;
    await ctx.db.patch(existing._id, {
      source: existing.source,
      status: "pending",
      lastError: undefined,
      verifiedEmail,
      dodoSubscriptionIds:
        existing.dodoSubscriptionIds ??
        subscriptions?.map((row) => row.dodoSubscriptionId),
      subscriptionDocIds:
        existing.subscriptionDocIds ?? subscriptions?.map((row) => row._id),
      updatedAt: now,
    });
  } else {
    deletionId = await ctx.db.insert("accountDeletions", {
      userId: confirmedUserId,
      userIdHash,
      source,
      status: "pending",
      step: "follows",
      personalTableIndex: 0,
      verifiedEmail,
      dodoSubscriptionIds: subscriptions?.map((row) => row.dodoSubscriptionId),
      subscriptionDocIds: subscriptions?.map((row) => row._id),
      startedAt: now,
      updatedAt: now,
    });
  }

  const row = await ctx.db.get(deletionId);
  if (!row) {
    throw new ConvexError("DELETION_ROW_MISSING");
  }

  if (!row.fenceAppliedAt) {
    await applyOwnerDeletedFence(ctx, confirmedUserId);
    await ctx.db.patch(deletionId, { fenceAppliedAt: Date.now(), updatedAt: Date.now() });
  }

  const after = await runEraseBatch(ctx, deletionId);
  if (!after || after.status !== "complete") {
    await scheduleAdvance(ctx, deletionId);
    return { status: "pending", userIdHash };
  }
  return { status: "complete", userIdHash };
}

export const requestAccountDeletion = mutation({
  args: {},
  returns: eraseResultValidator,
  handler: async (ctx): Promise<EraseResult> => {
    const userId = await requireUserId(ctx);
    const identity = await ctx.auth.getUserIdentity();
    return beginErase(ctx, userId, "self", identity?.email);
  },
});

export const eraseConfirmedUser = internalMutation({
  args: {
    userId: v.string(),
    source: eraseSourceValidator,
  },
  returns: eraseResultValidator,
  handler: async (ctx, args): Promise<EraseResult> => {
    return beginErase(ctx, args.userId, args.source);
  },
});

export const ingestClerkUserDeleted = internalMutation({
  args: {
    webhookId: v.string(),
    userId: v.string(),
  },
  returns: v.object({
    status: v.union(
      v.literal("pending"),
      v.literal("complete"),
      v.literal("already_deleted"),
      v.literal("duplicate"),
    ),
    userIdHash: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("webhookEvents")
      .withIndex("by_webhookId", (q) => q.eq("webhookId", args.webhookId))
      .unique();
    if (existing) {
      return { status: "duplicate" as const };
    }
    // Erase first so a failed first delivery is retried. Inserting the
    // idempotency row before beginErase would turn Clerk's retry into a
    // no-op and leave Convex data behind.
    const result = await beginErase(ctx, args.userId, "clerk_webhook");
    await ctx.db.insert("webhookEvents", {
      webhookId: args.webhookId,
      eventType: "user.deleted",
      rawPayload: { type: "user.deleted", data: { id: args.userId } },
      processedAt: Date.now(),
      status: "processed",
    });
    return { status: result.status, userIdHash: result.userIdHash };
  },
});

const deletionStatusValidator = v.union(
  v.null(),
  v.object({
    status: v.union(
      v.literal("pending"),
      v.literal("complete"),
      v.literal("failed"),
    ),
    step: v.union(
      v.literal("follows"),
      v.literal("personal"),
      v.literal("grants"),
      v.literal("anonymize"),
      v.literal("email_keyed"),
      v.literal("external"),
      v.literal("complete"),
    ),
    userIdHash: v.string(),
    lastError: v.optional(v.string()),
  }),
);

export const getOwnDeletionStatus = query({
  args: {},
  returns: deletionStatusValidator,
  handler: async (ctx) => {
    const userId = await resolveUserId(ctx);
    if (!userId) return null;
    const row = await ctx.db
      .query("accountDeletions")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (!row) return null;
    return {
      status: row.status,
      step: row.step,
      userIdHash: row.userIdHash,
      lastError: row.lastError,
    };
  },
});

const externalSnapshotValidator = v.union(
  v.null(),
  v.object({
    deletionId: v.id("accountDeletions"),
    userId: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("complete"),
      v.literal("failed"),
    ),
    step: v.union(
      v.literal("follows"),
      v.literal("personal"),
      v.literal("grants"),
      v.literal("anonymize"),
      v.literal("email_keyed"),
      v.literal("external"),
      v.literal("complete"),
    ),
    dodoSubscriptionIds: v.array(v.string()),
    cancelledDodoSubscriptionIds: v.array(v.string()),
    keyHashes: v.array(v.string()),
    embedKeyHashes: v.array(v.string()),
    mcpTokenIds: v.array(v.string()),
    redisClearedAt: v.optional(v.number()),
    clerkDeletedAt: v.optional(v.number()),
  }),
);

export const getExternalEraseSnapshot = internalQuery({
  args: { deletionId: v.id("accountDeletions") },
  returns: externalSnapshotValidator,
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.deletionId);
    if (!row) return null;
    return {
      deletionId: row._id,
      userId: row.userId,
      status: row.status,
      step: row.step,
      dodoSubscriptionIds: row.dodoSubscriptionIds ?? [],
      cancelledDodoSubscriptionIds: row.cancelledDodoSubscriptionIds ?? [],
      keyHashes: row.keyHashes ?? [],
      embedKeyHashes: row.embedKeyHashes ?? [],
      mcpTokenIds: row.mcpTokenIds ?? [],
      redisClearedAt: row.redisClearedAt,
      clerkDeletedAt: row.clerkDeletedAt,
    };
  },
});

export const recordExternalProgress = internalMutation({
  args: {
    deletionId: v.id("accountDeletions"),
    cancelledDodoSubscriptionIds: v.optional(v.array(v.string())),
    redisClearedAt: v.optional(v.number()),
    clerkDeletedAt: v.optional(v.number()),
    lastError: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.deletionId);
    if (!row || row.status === "complete") return null;
    await ctx.db.patch(args.deletionId, {
      ...(args.cancelledDodoSubscriptionIds
        ? { cancelledDodoSubscriptionIds: args.cancelledDodoSubscriptionIds }
        : {}),
      ...(args.redisClearedAt !== undefined
        ? { redisClearedAt: args.redisClearedAt }
        : {}),
      ...(args.clerkDeletedAt !== undefined
        ? { clerkDeletedAt: args.clerkDeletedAt }
        : {}),
      lastError: args.lastError === null ? undefined : args.lastError,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const markExternalComplete = internalMutation({
  args: { deletionId: v.id("accountDeletions") },
  returns: eraseResultValidator,
  handler: async (ctx, args): Promise<EraseResult> => {
    const row = await ctx.db.get(args.deletionId);
    if (!row) {
      throw new ConvexError("DELETION_ROW_MISSING");
    }
    if (row.status === "complete") {
      return { status: "already_deleted", userIdHash: row.userIdHash };
    }
    const now = Date.now();
    await ctx.db.patch(args.deletionId, {
      step: "complete",
      status: "complete",
      verifiedEmail: undefined,
      lastError: undefined,
      completedAt: now,
      updatedAt: now,
    });
    return { status: "complete", userIdHash: row.userIdHash };
  },
});
