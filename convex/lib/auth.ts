import { QueryCtx, MutationCtx, ActionCtx } from "../_generated/server";

const DEV_USER_ID = "test-user-001";
const isDev =
  process.env.CONVEX_CLOUD_URL?.includes("localhost") ||
  !process.env.CONVEX_CLOUD_URL;

/**
 * Returns the current user's ID, or null if unauthenticated.
 * In development, returns a hardcoded test user ID.
 *
 * This is the sole entry point for resolving the current user —
 * no Convex function should call auth APIs directly.
 *
 * TODO: Replace with real auth resolution when PR #1812 merges
 */
export async function resolveUserId(
  ctx: QueryCtx | MutationCtx | ActionCtx,
): Promise<string | null> {
  if (isDev) {
    return DEV_USER_ID;
  }
  // TODO: Replace with real auth resolution when PR #1812 merges
  // const identity = await ctx.auth.getUserIdentity();
  // return identity?.subject ?? null;
  return null;
}

/**
 * Returns the current user's ID or throws if unauthenticated.
 * Use for mutations/actions that always require auth.
 */
export async function requireUserId(
  ctx: QueryCtx | MutationCtx | ActionCtx,
): Promise<string> {
  const userId = await resolveUserId(ctx);
  if (!userId) {
    throw new Error("Authentication required");
  }
  return userId;
}
