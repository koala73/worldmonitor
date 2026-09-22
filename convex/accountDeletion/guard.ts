import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/** Read in the writing transaction so deletion and new personal data conflict. */
export async function isAccountDeleting(
  ctx: QueryCtx | MutationCtx,
  userId: string,
): Promise<boolean> {
  const deletion = await ctx.db
    .query("accountDeletions")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  // Failed and completed requests retain the fence too: a stale session or
  // delayed callback must not recreate data after its cleanup batch passed.
  return deletion !== null;
}

export async function assertAccountWritable(
  ctx: MutationCtx,
  userId: string,
): Promise<void> {
  if (await isAccountDeleting(ctx, userId)) {
    throw new ConvexError("ACCOUNT_DELETION_IN_PROGRESS");
  }
}
