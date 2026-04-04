import { QueryCtx, MutationCtx, ActionCtx } from "../_generated/server";

export const DEV_USER_ID = "test-user-001";

/**
 * True only when explicitly running `convex dev` (which sets CONVEX_IS_DEV).
 * Never infer dev mode from missing env vars — that would make production
 * behave like dev if CONVEX_CLOUD_URL happens to be unset.
 */
export const isDev = process.env.CONVEX_IS_DEV === "true";

/**
 * Returns the current user's ID, or null if unauthenticated.
 *
 * Resolution order:
 *   1. Real auth identity from Clerk/Convex auth (ctx.auth.getUserIdentity)
 *   2. Dev-only fallback to test-user-001 (only when CONVEX_IS_DEV=true)
 *
 * This is the sole entry point for resolving the current user —
 * no Convex function should call auth APIs directly.
 */
export async function resolveUserId(
  ctx: QueryCtx | MutationCtx | ActionCtx,
): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity?.subject) {
    return identity.subject;
  }

  if (isDev) {
    return DEV_USER_ID;
  }

  return null;
}

/**
 * Returns the full user identity (name, email, etc.) or null.
 * Use when you need more than just the user ID (e.g., checkout prefill).
 */
export async function resolveUserIdentity(
  ctx: QueryCtx | MutationCtx | ActionCtx,
): Promise<{ subject: string; name?: string; givenName?: string; familyName?: string; email?: string } | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity?.subject) return identity;
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
