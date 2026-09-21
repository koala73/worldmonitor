import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  mutation,
  type MutationCtx,
} from "../_generated/server";
import { applyOwnerDeletedFence } from "../companyMonitoring/accounts";
import { requireUserId } from "../lib/auth";
import { runEraseBatch } from "./batches";
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
  await ctx.scheduler.runAfter(0, internal.accountDeletion.batches.advanceErase, {
    deletionId,
  });
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
