import { ConvexError } from "convex/values";
import type { ActionCtx } from "../_generated/server";
import { DEV_USER_ID, isDev } from "./auth";

/**
 * Liveness of the Clerk session a verified JWT names (`sid`).
 *
 * `ctx.auth` only proves the token was signed: a session revoked by sign-out,
 * "sign out other devices" or an admin stays usable until `exp`. A function
 * that mints a credential outliving that token (an API or desktop key) must
 * ask Clerk, every time — liveness is the question, so nothing is cached.
 * Mirrors `verifyClerkSessionActive` in server/auth-session.ts for the Convex
 * runtime, which cannot import the edge module.
 */
export type ClerkSessionCheck = "active" | "inactive" | "unavailable";

const CLERK_SESSION_TIMEOUT_MS = 5_000;

export async function verifyClerkSessionActive(sessionId: string, userId: string): Promise<ClerkSessionCheck> {
  const secret = process.env.CLERK_SECRET_KEY;
  if (!secret) return "unavailable";
  if (!sessionId || !userId) return "inactive";
  try {
    const response = await fetch(`https://api.clerk.com/v1/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${secret}`, "User-Agent": "worldmonitor-convex/1.0" },
      signal: AbortSignal.timeout(CLERK_SESSION_TIMEOUT_MS),
    });
    // Clerk answered about THIS session: it does not exist.
    if (response.status === 404) return "inactive";
    if (!response.ok) {
      console.warn(`[clerk-session] session check unavailable: http-${response.status}`);
      return "unavailable";
    }
    const session = (await response.json()) as { id?: unknown; status?: unknown; user_id?: unknown };
    return session.id === sessionId && session.status === "active" && session.user_id === userId
      ? "active"
      : "inactive";
  } catch (err) {
    // sentry-coverage-ok the outage is reported by the SESSION_VERIFICATION_UNAVAILABLE ConvexError the caller throws (Convex auto-Sentry).
    console.warn("[clerk-session] session check unavailable:", err instanceof Error ? err.message : String(err));
    return "unavailable";
  }
}

/** Clerk session lookups one account may force per window (matches the desktop /authorize limit). */
const CLERK_LIVENESS_BUDGET = 10;
const CLERK_LIVENESS_WINDOW_SECONDS = 600;

/**
 * Per-caller budget for the uncached lookup above.
 *
 * A public action that calls `requireLiveClerkSession` is reachable by any
 * signed-in client, and every call spends one request of the instance-wide
 * Clerk Backend API quota. Without a ceiling one account could drive that
 * quota to 429 and fail every other user's session check closed. Counted in
 * the shared Upstash Redis (raw key, like the edge limiters). Fails open when
 * the counter store is absent or unreachable: this bounds abuse, it is not an
 * authorization decision — the liveness check itself still runs.
 */
export async function consumeClerkLivenessBudget(userId: string): Promise<boolean> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return true;
  const key = `clerk-liveness:${userId}`;
  try {
    const response = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "worldmonitor-convex/1.0" },
      body: JSON.stringify([
        ["INCR", key],
        ["EXPIRE", key, CLERK_LIVENESS_WINDOW_SECONDS, "NX"],
      ]),
      signal: AbortSignal.timeout(CLERK_SESSION_TIMEOUT_MS),
    });
    if (!response.ok) return true;
    const results = (await response.json()) as Array<{ result?: unknown }>;
    const count = results[0]?.result;
    return typeof count !== "number" || count <= CLERK_LIVENESS_BUDGET;
  } catch (err) {
    // sentry-coverage-ok a counter outage must not block sign-in; the Clerk check below still decides.
    console.warn("[clerk-session] liveness budget unavailable:", err instanceof Error ? err.message : String(err));
    return true;
  }
}

/**
 * The caller's userId, only once Clerk confirms the token's session is live.
 *
 * Actions only: a mutation cannot reach Clerk. Throws `AUTH_REQUIRED` when
 * there is no identity, no `sid`, or the session is no longer active (sign in
 * again is the fix), `SESSION_CHECK_RATE_LIMITED` when this account has used
 * its lookup budget, and `SESSION_VERIFICATION_UNAVAILABLE` when Clerk could
 * not answer — fail closed, never mint on a guess.
 */
export async function requireLiveClerkSession(ctx: ActionCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) {
    // Same dev-only fallback as resolveUserId: `convex dev` has no Clerk session.
    if (isDev) return DEV_USER_ID;
    throw new ConvexError("AUTH_REQUIRED");
  }
  // Clerk's `sid` is a reserved claim on every token it mints; Convex exposes
  // non-OIDC claims on the identity. Absent means this is not a session token.
  const sessionId = identity.sid;
  if (typeof sessionId !== "string" || !sessionId) throw new ConvexError("AUTH_REQUIRED");
  // Network-free identity keys the budget, so the budget runs before Clerk.
  if (!(await consumeClerkLivenessBudget(identity.subject))) {
    throw new ConvexError("SESSION_CHECK_RATE_LIMITED");
  }
  const check = await verifyClerkSessionActive(sessionId, identity.subject);
  if (check === "unavailable") throw new ConvexError("SESSION_VERIFICATION_UNAVAILABLE");
  if (check !== "active") throw new ConvexError("AUTH_REQUIRED");
  return identity.subject;
}
