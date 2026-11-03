import { ConvexError } from "convex/values";
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
): Promise<{ subject: string; name?: string; givenName?: string; familyName?: string; email?: string; plan?: 'free' | 'pro' } | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) return null;
  const plan = identity.plan === 'free' || identity.plan === 'pro' ? identity.plan : undefined;
  return { ...identity, plan };
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
    // ConvexError so clients can narrow AUTH_REQUIRED via the ConvexError
    // contract (error.data). It is NOT exempt from Convex→Sentry reporting —
    // expected denials still appear as Uncaught ConvexError (e.g. WORLDMONITOR-XM).
    // High-frequency expected denials need a return value, not a throw, to stay
    // out of exception ingest; do not suppress these codes by message at Sentry.
    throw new ConvexError("AUTH_REQUIRED");
  }
  return userId;
}
