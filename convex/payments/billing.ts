/**
 * Billing queries and actions for subscription management.
 *
 * Provides:
 * - getSubscriptionForUser: authenticated query for frontend status display
 * - getCustomerByUserId: internal query for portal session creation
 * - getActiveSubscription: internal query for plan change validation
 * - getCustomerPortalUrl: authenticated action to create a Dodo Customer Portal session
 * - claimSubscription: mutation to migrate entitlements from anon ID to authed user
 */

import { ConvexError, v } from "convex/values";
import { action, mutation, query, internalAction, internalMutation, internalQuery, type ActionCtx, type QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { DodoPayments } from "dodopayments";
import type { Subscription as DodoSubscription } from "dodopayments/resources/subscriptions";
import type { Id } from "../_generated/dataModel";
import { resolveUserId, requireUserId } from "../lib/auth";
import { getFeaturesForPlan } from "../lib/entitlements";
import { ANON_ID_V4_REGEX, verifyAnonClaimToken } from "../lib/identitySigning";
import { PLAN_PRECEDENCE, PRODUCT_CATALOG, resolveProductToPlan } from "../config/productCatalog";
import {
  isNewerEvent,
  recomputeEntitlementFromAllSubs,
  resolvePlanKey,
  type SubscriptionStatus,
} from "./subscriptionHelpers";

// ---------------------------------------------------------------------------
// Shared SDK config (direct REST SDK, not the Convex component from lib/dodo.ts)
// ---------------------------------------------------------------------------

/**
 * Returns a direct DodoPayments REST SDK client.
 *
 * This uses the "dodopayments" npm package (REST SDK) for API calls
 * such as customer portal creation and plan changes. It is distinct from
 * the @dodopayments/convex component SDK in lib/dodo.ts, which handles
 * checkout and webhook verification.
 *
 * Canonical env var: DODO_API_KEY.
 */
function getDodoClient(
  options: { timeout?: number; maxRetries?: number } = {},
): DodoPayments {
  const apiKey = process.env.DODO_API_KEY;
  if (!apiKey) {
    // Structured throw (object-typed `data`) so the client receives
    // `err.data.kind` instead of an opaque `[Request ID: X] Server Error`
    // (Convex's HTTP runtime drops `errorData` for string-data throws).
    // Surfaces a config drift bug at error level so on-call sees the real cause.
    throw new ConvexError({ kind: "DODO_API_KEY_MISSING" });
  }
  const isLive = process.env.DODO_PAYMENTS_ENVIRONMENT === "live_mode";
  return new DodoPayments({
    bearerToken: apiKey,
    ...(isLive ? {} : { environment: "test_mode" as const }),
    ...options,
  });
}

function compareEntitlementPlans(
  a: { planKey: string; validUntil: number },
  b: { planKey: string; validUntil: number },
): number {
  const tierDelta = getFeaturesForPlan(a.planKey).tier - getFeaturesForPlan(b.planKey).tier;
  if (tierDelta !== 0) return tierDelta;
  const rankDelta = (PLAN_PRECEDENCE[a.planKey] ?? 0) - (PLAN_PRECEDENCE[b.planKey] ?? 0);
  if (rankDelta !== 0) return rankDelta;
  return a.validUntil - b.validUntil;
}

// Max Dodo lookups attempted per action INVOCATION (each retrieve is a paid
// REST round-trip). The daily cron drains a larger backlog across continuation
// invocations (see MAX_CONTINUATIONS).
const DODO_RENEWAL_RECONCILIATION_BATCH_SIZE = 50;
// Max candidate rows the stale-scan query returns per call. Bounds each query's
// read cost. Continuations page forward via a currentPeriodEnd cursor (see the
// scheduling block), so a backlog larger than this — or a window fully within
// its backoff — no longer strands healthy rows behind it: the cursor advances
// past a drained/saturated window to the next one. The only repeated scan is
// re-reading the SAME window while draining its eligible rows in batches of
// `limit` (bounded by that window's eligible count), after which the cursor
// moves on.
const DODO_RENEWAL_RECONCILIATION_SCAN_LIMIT = 500;
const DODO_RENEWAL_RECONCILIATION_TIMEOUT_MS = 10_000;
// Wall-clock budget per invocation. Worst case a full batch of slow Dodo
// lookups (retry/timeout) could exceed Convex's 10-min action cap, so we bail
// with a summary and continuation-schedule the remainder well before it.
const DODO_RENEWAL_RECONCILIATION_TIME_BUDGET_MS = 8 * 60 * 1000;
// Hard ceiling on self-scheduled continuations per cron cycle. The chain is the
// initial invocation plus continuations at budget MAX_CONTINUATIONS-1..0, so it
// bounds total Dodo calls to (MAX_CONTINUATIONS + 1) * BATCH_SIZE and guarantees
// termination.
const DODO_RENEWAL_RECONCILIATION_MAX_CONTINUATIONS = 25;
// Backoff after a failed/no-progress reconcile attempt. The FIRST failure backs
// off only a few hours — enough to skip the rest of the current cron cycle's
// continuations (same `now`) but short enough that a transient Dodo error still
// gets retried at the very next daily run, so it does not over-delay a
// legitimate downgrade of a lapsed sub. Repeated failures then back off
// exponentially (2d, 4d, 8d, … capped) so a permanently-failing row is retried
// geometrically less often instead of hogging a scan slot every run.
const DODO_RENEWAL_RECONCILIATION_BACKOFF_FIRST_MS = 6 * 60 * 60 * 1000;
const DODO_RENEWAL_RECONCILIATION_BACKOFF_BASE_MS = 2 * 24 * 60 * 60 * 1000;
const DODO_RENEWAL_RECONCILIATION_BACKOFF_MAX_MS = 30 * 24 * 60 * 60 * 1000;

// Request-path renewal verification (#4770). Only subscriptions whose paid
// period ended in the last three days are eligible: this closes the daily-cron
// denial window without turning every long-lapsed request into a Dodo lookup.
const ON_DEMAND_RENEWAL_RECENT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
// The gateway gives /api/internal-entitlements three seconds. Leave one second
// for Convex/query/mutation overhead and disable SDK retries below.
const ON_DEMAND_RENEWAL_TIMEOUT_MS = 2_000;
// A durable lease coalesces simultaneous route/API-key hits across action
// instances. It exceeds the provider timeout so a second request observes
// `pending` while the first owns the lookup.
const ON_DEMAND_RENEWAL_LEASE_MS = 15_000;
// Concurrent waiters retry against the leader's EXPECTED completion (provider
// timeout + Convex overhead), not the full lease: the lease is a crash-safety
// bound, and quoting it as Retry-After made a waiting paid client sit out 15s
// for a lookup that resolves in 2-3s. A stuck leader just means a few 1s polls
// until the lease reopens.
const ON_DEMAND_RENEWAL_EXPECTED_COMPLETION_MS = ON_DEMAND_RENEWAL_TIMEOUT_MS + 1_000;
// Transient failures are retryable, but no more than once per minute per
// subscription. The response carries the remaining cooldown to callers.
const ON_DEMAND_RENEWAL_FAILURE_COOLDOWN_MS = 60_000;
// If Dodo is reachable but still reports no covering period, avoid re-querying
// on every route hit. Organic webhooks clear this state immediately.
const ON_DEMAND_RENEWAL_LAPSED_COOLDOWN_MS = 5 * 60_000;
// A request that affirmatively resolves one subscription as non-covering can
// leave another recently-stale subscription to inspect. Tell the caller to
// retry promptly without starting a second provider call in this invocation.
const ON_DEMAND_RENEWAL_PROGRESS_RETRY_SECONDS = 1;

function reconcileBackoffMs(failureCount: number): number {
  if (failureCount <= 0) return 0;
  if (failureCount === 1) return DODO_RENEWAL_RECONCILIATION_BACKOFF_FIRST_MS;
  const exponent = Math.min(failureCount - 2, 5);
  return Math.min(
    DODO_RENEWAL_RECONCILIATION_BACKOFF_BASE_MS * 2 ** exponent,
    DODO_RENEWAL_RECONCILIATION_BACKOFF_MAX_MS,
  );
}

function isReconcileEligible(
  candidate: { lastReconcileAttemptAt?: number; reconcileFailureCount?: number },
  now: number,
): boolean {
  if (candidate.lastReconcileAttemptAt == null) return true;
  return now - candidate.lastReconcileAttemptAt >= reconcileBackoffMs(candidate.reconcileFailureCount ?? 0);
}

// Confirmation threshold before a definitive Dodo not-found downgrades the local
// row: only when the row ALREADY has >= this many recorded failures (i.e. this
// is at least the 2nd consecutive definitive 404, across >= 2 daily runs) do we
// expire it. Blocks a single flaky 404 from revoking a paying customer. The
// batch-level mass-404 circuit breaker (below) bounds the correlated case where
// a misconfig makes every live sub 404 at once.
const DODO_RENEWAL_TERMINAL_NOTFOUND_MIN_PRIOR_FAILURES = 1;

// Mass-404 circuit breaker: the max confirmed-not-found DOWNGRADES a single
// invocation will perform. Beyond `min(this, ceil(plannedAttempts / 2))` the run
// stops downgrading and routes the rest to the backoff path, on the theory that
// a whole batch 404ing is far more likely a wrong-environment/API-key misconfig
// than that many subscriptions genuinely vanishing at once. A real handful of
// deleted subs still gets cleaned; a config error downgrades at most the
// threshold before self-halting (and the loud console.error pages ops first).
const DODO_RENEWAL_MASS_NOTFOUND_ABSOLUTE_CAP = 5;

// A definitive "this subscription does not exist in Dodo" — the SDK throws
// `NotFoundError extends APIError<404>` (a `.status` of 404). Transient failures
// (network, timeout, 5xx, 429) carry a different/absent status and must stay on
// the backoff-and-retry path, never downgrade.
function isDefinitiveDodoNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status?: unknown }).status === 404
  );
}

const dodoReconciliationRemoteSubscriptionValidator = v.object({
  subscription_id: v.string(),
  product_id: v.string(),
  status: v.string(),
  previous_billing_date: v.union(v.string(), v.number()),
  next_billing_date: v.union(v.string(), v.number()),
  customer: v.optional(v.object({
    customer_id: v.optional(v.string()),
    email: v.optional(v.string()),
  })),
  metadata: v.optional(v.record(v.string(), v.string())),
  recurring_pre_tax_amount: v.optional(v.number()),
  currency: v.optional(v.string()),
  tax_inclusive: v.optional(v.boolean()),
  discount_id: v.optional(v.union(v.string(), v.null())),
  cancelled_at: v.optional(v.union(v.string(), v.number(), v.null())),
});

type DodoReconciliationRemoteSubscription = {
  subscription_id: string;
  product_id: string;
  status: string;
  previous_billing_date: string | number;
  next_billing_date: string | number;
  customer?: { customer_id?: string; email?: string };
  metadata?: Record<string, string>;
  recurring_pre_tax_amount?: number;
  currency?: string;
  tax_inclusive?: boolean;
  discount_id?: string | null;
  cancelled_at?: string | number | null;
};

type StaleActiveSubscriptionForRenewalReconciliation = {
  _id: Id<"subscriptions">;
  userId: string;
  dodoSubscriptionId: string;
  currentPeriodEnd: number;
  lastReconcileAttemptAt?: number;
  reconcileFailureCount?: number;
  reconcileNotFoundCount?: number;
};

type StaleActiveSubscriptionsPage = {
  page: StaleActiveSubscriptionForRenewalReconciliation[];
  continueCursor: string;
  isDone: boolean;
};

// Shared cooldown vocabulary for the on-demand renewal state machines below:
// a live pending lease, a failed-verification cooldown, or an affirmative
// lapse. Composed (not repeated) so a shape change propagates to every union.
type RenewalCooldownOutcome =
  | { kind: "pending"; retryAfterSeconds: number }
  | { kind: "failed"; retryAfterSeconds: number }
  | { kind: "lapsed" };

type OnDemandRenewalClaim =
  | {
      kind: "claimed";
      claimedAt: number;
      subscription: StaleActiveSubscriptionForRenewalReconciliation;
    }
  | RenewalCooldownOutcome
  | { kind: "not_applicable" };

type OnDemandRenewalCandidate = {
  _id: Id<"subscriptions">;
  planKey: string;
  currentPeriodEnd: number;
  renewalVerificationState?: "pending" | "failed" | "lapsed";
  renewalVerificationAttemptAt?: number;
};

type OnDemandRenewalCandidateSelection<T extends OnDemandRenewalCandidate> =
  | { kind: "candidate"; candidate: T }
  | RenewalCooldownOutcome;

type OnDemandRenewalResolution =
  | { kind: "active" }
  | { kind: "unresolved" }
  | RenewalCooldownOutcome;

type OnDemandRenewalResult =
  | { status: "active" }
  | { status: "subscription_lapsed" }
  | {
      status: "renewal_verification_pending" | "renewal_verification_failed";
      retryAfterSeconds: number;
    }
  | { status: "not_applicable" };

type ReconciliationSkipReason =
  | "local_missing"
  | "local_updated_concurrently"
  | "local_no_longer_stale"
  | "remote_not_newer";

type ReconciliationMutationResult =
  | {
      kind: "reconciled";
      status: SubscriptionStatus;
      planKey: string;
      currentPeriodEnd: number;
    }
  | { kind: "skipped"; reason: ReconciliationSkipReason };

type ReconciliationSummary = {
  inspected: number;
  reconciled: number;
  // Rows the reconciler downgraded to `expired` because a CONFIRMED terminal
  // Dodo not-found (>= 2 consecutive definitive 404s) proved the subscription no
  // longer exists — distinct from a transient lookup `failed`.
  expiredMissing: number;
  skipped: number;
  failed: number;
  limit: number;
  // hasMore can be true while continuationScheduled is false only in the
  // degenerate case handled by `windowSaturated` below (documented at the
  // scheduling guard in the action).
  hasMore: boolean;
  timeBudgetExhausted: boolean;
  // The scanned window was entirely within its reconcile backoff (all rows
  // ineligible). Surfaced so an operator can tell "cooldown-saturated" from
  // "nothing stale"; the action advances its scan cursor past the window.
  windowSaturated: boolean;
  continuationScheduled: boolean;
  failures: Array<{ dodoSubscriptionId: string; error: string }>;
};

function normalizeDodoStatus(status: string): SubscriptionStatus | null {
  switch (status) {
    case "active":
    case "on_hold":
    case "cancelled":
    case "expired":
      return status;
    case "failed":
      // Dodo `failed` = the subscription's mandate/payment permanently failed.
      // The SDK `SubscriptionStatus` union carries it separately from `expired`,
      // but locally it means the same thing: no longer covering. Map to
      // `expired` so `recomputeEntitlementFromAllSubs` downgrades the user
      // (a local-active row would otherwise keep full entitlement forever via
      // `isCoveringAt`).
      return "expired";
    default:
      // `pending` and any unknown status → caller skips + escalates. `pending`
      // is a real SDK status (initial payment in flight) but not a state we act
      // on from the reconciler.
      return null;
  }
}

function toReconciliationEpochMs(value: string | number, fieldName: string): number {
  const ms = typeof value === "number" ? value : new Date(value).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`[billing/reconcile] invalid Dodo ${fieldName}: ${String(value)}`);
  }
  return ms;
}

function normalizeRemoteSubscription(
  remote: DodoSubscription | DodoReconciliationRemoteSubscription,
) {
  const status = normalizeDodoStatus(remote.status);
  if (!status) {
    return {
      kind: "skip" as const,
      reason: remote.status === "pending" ? ("pending" as const) : ("unsupported-status" as const),
      status: remote.status,
      dodoSubscriptionId: remote.subscription_id,
    };
  }

  const cancelledAt = remote.cancelled_at == null
    ? undefined
    : toReconciliationEpochMs(remote.cancelled_at, "cancelled_at");

  return {
    kind: "supported" as const,
    value: {
      dodoSubscriptionId: remote.subscription_id,
      productId: remote.product_id,
      status,
      currentPeriodStart: toReconciliationEpochMs(
        remote.previous_billing_date,
        "previous_billing_date",
      ),
      currentPeriodEnd: toReconciliationEpochMs(
        remote.next_billing_date,
        "next_billing_date",
      ),
      dodoCustomerId: remote.customer?.customer_id,
      cancelledAt,
      rawPayload: remote,
    },
  };
}

/**
 * Resolve the Dodo Customer Portal URL for a Clerk-authenticated user.
 *
 * Delegates the Dodo customer_id lookup to
 * `getDodoCustomerIdForUserPortal`, which is a 3-tier resolver biased
 * toward per-Clerk-userId evidence:
 *
 *   1. `subscriptions.dodoCustomerId` — the stable top-level column,
 *      preserved across lifecycle webhook patches by
 *      `mergeDodoCustomerId` in `subscriptionHelpers.ts`. Per-Clerk-
 *      userId by construction (sub rows are keyed by the HMAC-signed
 *      Clerk userId at checkout) and never patched away.
 *   2. `subscriptions.rawPayload.customer.customer_id` — fallback for
 *      rows that pre-date the column (deploy / backfill window).
 *   3. `customers.dodoCustomerId` for the SAME userId — last-resort
 *      rescue for pre-PR rows whose rawPayload was wiped by a
 *      lifecycle event before this PR shipped (matches by userId, so
 *      no silent cross-user re-attribution).
 *
 * Why not "customers row by userId" as the primary source: that table
 * races under concurrent webhooks. `subscriptionHelpers.ts:533-539`
 * patches the row's `userId` whenever a `subscription.active` event
 * arrives with a matching dodoCustomerId — same Dodo customer (one per
 * email, Dodo dedupes by email) bouncing between Clerk userIds when
 * one human checks out under multiple Clerk accounts. Tier 1+2 use
 * the per-Clerk-userId subscription rows precisely to avoid that
 * race. Tier 3 only kicks in when both sub-side tiers miss AND the
 * customers row's `userId` happens to match the requester.
 *
 * Result: every Clerk account with a valid subscription opens the
 * right portal regardless of how many other Clerk accounts share the
 * same Dodo customer. No Clerk REST lookup needed.
 *
 * WORLDMONITOR-R5: the original opaque `[Request ID: X] Server Error`
 * came from this path throwing on a missing customers row when both
 * the rawPayload and a same-user customers row still held the answer.
 */
export async function createCustomerPortalUrlForUser(
  ctx: Pick<ActionCtx, "runQuery">,
  userId: string,
): Promise<{ portal_url: string }> {
  const dodoCustomerId = await ctx.runQuery(
    internal.payments.billing.getDodoCustomerIdForUserPortal,
    { userId },
  );

  if (!dodoCustomerId) {
    // User has no subscription at all, or every sub's rawPayload lacks a
    // usable customer_id (very rare — would mean every webhook delivery
    // for this user dropped the customer field). Throw structured so
    // the client surfaces the existing "contact support" toast
    // (object-typed `data` so `err.data.kind` survives the wire — see
    // `api/_convex-error.js`).
    throw new ConvexError({ kind: "NO_CUSTOMER" });
  }

  const client = getDodoClient();
  let session;
  try {
    session = await client.customers.customerPortal.create(
      dodoCustomerId,
      { send_email: false },
    );
  } catch (err) {
    // The Dodo REST SDK throws a plain Error (APIError on a non-2xx Dodo
    // response, or a transport failure) when the portal-session create
    // fails. Convex's action runtime then masks any NON-ConvexError throw
    // as an opaque `[Request ID: X] Server Error`, dropping the real cause
    // from the wire — the exact opacity WORLDMONITOR-R5 fought for the
    // missing-customer path above (this was the last unwrapped throw site).
    // Re-throw as a structured ConvexError so the client receives
    // `err.data.kind === 'DODO_PORTAL_ERROR'` for proper Sentry
    // classification (browser → `extractBillingErrorKind` → tag
    // `billing_error_kind`; the user still falls back to the generic Dodo
    // portal), and log the underlying cause here so it survives in the
    // Convex function logs for server-side triage. WORLDMONITOR-ST.
    const cause = err instanceof Error ? err.message : String(err);
    console.error(
      `[billing] Dodo customer-portal create failed for customer ${dodoCustomerId}:`,
      cause,
    );
    throw new ConvexError({ kind: "DODO_PORTAL_ERROR" });
  }

  return { portal_url: session.link };
}

function getSubscriptionStatusPriority(status: string): number {
  switch (status) {
    case "active":
      return 0;
    case "on_hold":
      return 1;
    case "cancelled":
      return 2;
    default:
      return 3;
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Returns the most recent subscription for a given user, enriched with
 * the plan's display name from the productPlans table.
 *
 * Used by the frontend billing UI to show current plan status.
 */
export const getSubscriptionForUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await resolveUserId(ctx);
    if (!userId) {
      return null;
    }

    // Fetch all subscriptions for user and prefer active/on_hold over cancelled/expired.
    // Avoids the bug where a cancelled sub created after an active one hides the active one.
    const allSubs = await ctx.db
      .query("subscriptions")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .take(50);

    if (allSubs.length === 0) return null;

    allSubs.sort((a, b) => {
      // Ended subscriptions are equivalent for display selection. Prefer the
      // one whose coverage ended most recently so returning-subscriber links
      // preserve the latest plan instead of always favoring cancelled.
      const pa = a.status === "active" ? 0 : a.status === "on_hold" ? 1 : 2;
      const pb = b.status === "active" ? 0 : b.status === "on_hold" ? 1 : 2;
      if (pa !== pb) return pa - pb; // active first
      if (pa === 2) {
        const periodDelta = b.currentPeriodEnd - a.currentPeriodEnd;
        if (periodDelta !== 0) return periodDelta;
      }
      return b.updatedAt - a.updatedAt;
    });

    // Safe: we checked length > 0 above
    const subscription = allSubs[0]!;

    // Look up display name from productPlans
    const productPlan = await ctx.db
      .query("productPlans")
      .withIndex("by_planKey", (q) => q.eq("planKey", subscription.planKey))
      .first();

    return {
      planKey: subscription.planKey,
      displayName: productPlan?.displayName ?? subscription.planKey,
      status: subscription.status,
      currentPeriodEnd: subscription.currentPeriodEnd,
      // #4771: request-path renewal verification verdict (#4770), so the
      // frontend can show "verifying your renewal" instead of a generic
      // Upgrade CTA when local paid evidence goes stale. Normalized to null
      // (not undefined) for a stable wire shape.
      renewalVerificationState: subscription.renewalVerificationState ?? null,
    };
  },
});

/**
 * Internal query to retrieve a customer record by userId.
 *
 * NOTE: As of WORLDMONITOR-R5 follow-up, this is no longer used by the
 * Manage Billing flow — see `getDodoCustomerIdForUserPortal` below for
 * the rationale. Still consumed by callers that legitimately want the
 * customers row (broadcast paid-set membership, comp-grant lookups,
 * etc.); those tolerate the latest-writer-wins quirk on shared-email
 * Dodo customers because they only need "is this user a paid customer
 * at all", not "which Dodo customer should the portal session open
 * for this specific Clerk userId".
 */
export const getCustomerByUserId = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    // Use .first() instead of .unique() — defensive against duplicate customer rows
    return await ctx.db
      .query("customers")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();
  },
});

/**
 * Resolve the Dodo customer_id this user's "Manage Billing" click
 * should open a portal session for.
 *
 * Three-tier resolution, preferring per-Clerk-user evidence:
 *   1. `subscriptions.dodoCustomerId` — the stable top-level column
 *      written by the webhook handler and preserved across lifecycle
 *      patches via `mergeDodoCustomerId` in `subscriptionHelpers.ts`.
 *      Per-Clerk-userId by construction (subscription rows are keyed
 *      by the HMAC-signed userId at checkout).
 *   2. `subscriptions.rawPayload.customer.customer_id` — fallback for
 *      rows that pre-date the schema change AND whose rawPayload still
 *      carries the customer field (covers the deploy / backfill window).
 *   3. `customers.dodoCustomerId` for the SAME userId — last-resort
 *      fallback for the pre-PR pathological case: a row whose
 *      rawPayload was wiped by a lifecycle event BEFORE the schema
 *      change, leaving neither tier 1 nor tier 2 with data. The
 *      customers row may have been re-attributed under webhook race
 *      (latest-writer-wins on `subscriptionHelpers.ts:533-539`), but
 *      when it DOES match the requesting userId, it's the best
 *      remaining signal — better than NO_CUSTOMER for a paying user.
 *
 * Subscription preference (within tier 1+2): active → on_hold →
 * cancelled → other; tie-break by newest `updatedAt`. A given userId
 * may have multiple subscription rows over time (cancelled + new), so
 * sorting is required — there's no per-userId uniqueness invariant.
 *
 * Returns null only when all three tiers fail (no subs at all OR no
 * customer_id anywhere across subs/customers). Caller throws
 * NO_CUSTOMER → client surfaces the "contact support" toast.
 */
export const getDodoCustomerIdForUserPortal = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const subs = await ctx.db
      .query("subscriptions")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .take(50);

    if (subs.length > 0) {
      const sorted = [...subs].sort((a, b) => {
        const pa = getSubscriptionStatusPriority(a.status);
        const pb = getSubscriptionStatusPriority(b.status);
        if (pa !== pb) return pa - pb;
        return b.updatedAt - a.updatedAt;
      });

      for (const sub of sorted) {
        // Tier 1: stable column populated by the webhook handler.
        if (typeof sub.dodoCustomerId === "string" && sub.dodoCustomerId.length > 0) {
          return sub.dodoCustomerId;
        }
        // Tier 2: rawPayload fallback for pre-schema-change rows whose
        // rawPayload still carries the customer field.
        const payload = sub.rawPayload as
          | { customer?: { customer_id?: unknown } }
          | null
          | undefined;
        const id = payload?.customer?.customer_id;
        if (typeof id === "string" && id.length > 0) return id;
      }
    }

    // Tier 3: same-user customers row fallback. Covers pre-PR rows that
    // had their rawPayload wiped by a lifecycle event before the
    // schema change shipped — neither sub-side tier has data, but the
    // customers row may still hold a usable `dodoCustomerId` for this
    // exact userId. Skipped if a different Clerk user currently owns
    // the row (cross-user race) — that's a refusal-to-impersonate, not
    // a fallback we should bridge silently.
    const customer = await ctx.db
      .query("customers")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();
    if (
      customer &&
      typeof customer.dodoCustomerId === "string" &&
      customer.dodoCustomerId.length > 0
    ) {
      return customer.dodoCustomerId;
    }

    return null;
  },
});

export const listStaleActiveSubscriptionsForRenewalReconciliation = internalQuery({
  args: {
    now: v.number(),
    scanLimit: v.number(),
    // Opaque Convex pagination cursor threaded through continuations so a cron
    // cycle pages forward by DOCUMENT POSITION rather than by currentPeriodEnd.
    // Position-based paging is why >scanLimit rows sharing one currentPeriodEnd
    // (a tie) can't strand rows behind them, and why a page fully consumed or
    // fully backed-off is skipped without re-scanning. `null` (or omitted)
    // starts from the beginning of the stale set.
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("subscriptions")
      // Reuses the by_status_currentPeriodEnd index added by the dunning/
      // winback work (#4935) — same ["status","currentPeriodEnd"] shape, so
      // no duplicate index is needed. The cron pages by opaque Convex cursor
      // (position-based), so the index range is just the stale-active window.
      .withIndex("by_status_currentPeriodEnd", (q) =>
        q.eq("status", "active").lt("currentPeriodEnd", args.now),
      )
      .order("asc")
      .paginate({ cursor: args.cursor ?? null, numItems: args.scanLimit });
    // Slim projection — the action only needs identity + the reconcile
    // bookkeeping fields to decide eligibility. Dropping `rawPayload` (v.any(),
    // potentially large) keeps the query→action transfer bounded.
    return {
      page: result.page.map((row) => ({
        _id: row._id,
        userId: row.userId,
        dodoSubscriptionId: row.dodoSubscriptionId,
        currentPeriodEnd: row.currentPeriodEnd,
        lastReconcileAttemptAt: row.lastReconcileAttemptAt,
        reconcileFailureCount: row.reconcileFailureCount,
        reconcileNotFoundCount: row.reconcileNotFoundCount,
      })),
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

function retryAfterSeconds(windowMs: number, elapsedMs: number): number {
  return Math.max(1, Math.ceil((windowMs - elapsedMs) / 1000));
}

function queryRecentlyStaleActiveSubscriptions(
  ctx: QueryCtx,
  userId: string,
  now: number,
) {
  const recentCutoff = now - ON_DEMAND_RENEWAL_RECENT_WINDOW_MS;
  return ctx.db
    .query("subscriptions")
    .withIndex("by_userId_status_currentPeriodEnd", (q) =>
      q
        .eq("userId", userId)
        .eq("status", "active")
        .gte("currentPeriodEnd", recentCutoff)
        .lt("currentPeriodEnd", now),
    )
    .collect();
}

/**
 * Returns the known-good current fallback plus the strongest recently-stale
 * plan that may still be restored by on-demand verification.
 *
 * The materialized entitlement row can temporarily point at that stale,
 * stronger subscription while another lower plan is still current. Keeping
 * both sides of the comparison lets the request path preserve known coverage
 * without retaining a billing marker after an equal-or-stronger concurrent
 * entitlement refresh.
 */
export const getOnDemandRenewalFallbackState = internalQuery({
  args: {
    userId: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const subscriptions = await ctx.db
      .query("subscriptions")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();

    const currentSubscription = subscriptions
      .filter((subscription) =>
        subscription.currentPeriodEnd >= args.now &&
        (
          subscription.status === "active" ||
          subscription.status === "on_hold" ||
          subscription.status === "cancelled"
        ),
      )
      .sort((a, b) =>
        compareEntitlementPlans(
          { planKey: b.planKey, validUntil: b.currentPeriodEnd },
          { planKey: a.planKey, validUntil: a.currentPeriodEnd },
        ),
      )[0];

    const recentCutoff = args.now - ON_DEMAND_RENEWAL_RECENT_WINDOW_MS;
    const strongestRecentlyStaleSubscription = subscriptions
      .filter((subscription) =>
        subscription.status === "active" &&
        subscription.currentPeriodEnd >= recentCutoff &&
        subscription.currentPeriodEnd < args.now,
      )
      .sort((a, b) =>
        compareEntitlementPlans(
          { planKey: b.planKey, validUntil: b.currentPeriodEnd },
          { planKey: a.planKey, validUntil: a.currentPeriodEnd },
        ),
      )[0];

    return {
      currentEntitlement: currentSubscription
        ? {
            planKey: currentSubscription.planKey,
            features: getFeaturesForPlan(currentSubscription.planKey),
            validUntil: currentSubscription.currentPeriodEnd,
          }
        : null,
      strongestRecentlyStaleFeatures: strongestRecentlyStaleSubscription
        ? getFeaturesForPlan(strongestRecentlyStaleSubscription.planKey)
        : null,
    };
  },
});

/**
 * Classifies all recently-stale rows for one user without starting provider
 * work. A live pending lease is user-scoped: claiming a different row while
 * it is in flight would fan concurrent requests out to Dodo. Failed and
 * affirmatively-lapsed cooldowns, however, do not block progress to the next
 * unresolved row.
 */
function selectOnDemandRenewalCandidate<T extends OnDemandRenewalCandidate>(
  subscriptions: T[],
  now: number,
): OnDemandRenewalCandidateSelection<T> {
  const ordered = [...subscriptions].sort((a, b) =>
    compareEntitlementPlans(
      { planKey: b.planKey, validUntil: b.currentPeriodEnd },
      { planKey: a.planKey, validUntil: a.currentPeriodEnd },
    ),
  );

  // A request already verifying any row may restore the user's entitlement.
  // Coalesce at the user level before looking for another claimable row.
  for (const subscription of ordered) {
    const attemptedAt = subscription.renewalVerificationAttemptAt;
    if (
      attemptedAt != null &&
      subscription.renewalVerificationState === "pending"
    ) {
      const elapsed = Math.max(0, now - attemptedAt);
      if (elapsed < ON_DEMAND_RENEWAL_LEASE_MS) {
        return {
          kind: "pending",
          retryAfterSeconds: retryAfterSeconds(
            ON_DEMAND_RENEWAL_EXPECTED_COMPLETION_MS,
            elapsed,
          ),
        };
      }
    }
  }

  let failedRetryAfterSeconds: number | null = null;
  for (const subscription of ordered) {
    const attemptedAt = subscription.renewalVerificationAttemptAt;
    if (attemptedAt != null) {
      const elapsed = Math.max(0, now - attemptedAt);
      if (
        subscription.renewalVerificationState === "failed" &&
        elapsed < ON_DEMAND_RENEWAL_FAILURE_COOLDOWN_MS
      ) {
        failedRetryAfterSeconds = Math.max(
          failedRetryAfterSeconds ?? 0,
          retryAfterSeconds(ON_DEMAND_RENEWAL_FAILURE_COOLDOWN_MS, elapsed),
        );
        continue;
      }
      if (
        subscription.renewalVerificationState === "lapsed" &&
        elapsed < ON_DEMAND_RENEWAL_LAPSED_COOLDOWN_MS
      ) {
        continue;
      }
    }

    return { kind: "candidate", candidate: subscription };
  }

  if (failedRetryAfterSeconds != null) {
    return { kind: "failed", retryAfterSeconds: failedRetryAfterSeconds };
  }
  return { kind: "lapsed" };
}

/**
 * Atomically claims the strongest recently-stale active subscription for a
 * user. Convex mutations serialize conflicting writes, so concurrent premium
 * requests see one `claimed` result and the rest see the durable `pending`
 * lease instead of each starting a Dodo request.
 */
export const claimRecentlyStaleSubscriptionForVerification = internalMutation({
  args: {
    userId: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args): Promise<OnDemandRenewalClaim> => {
    const subscriptions = await queryRecentlyStaleActiveSubscriptions(
      ctx,
      args.userId,
      args.now,
    );

    if (subscriptions.length === 0) {
      // A caller with billing history but no recently-stale active row has no
      // uncertain provider state to verify on the request path. Preserve a
      // definitive lapse signal for corrected inactive rows and old churn.
      const hasBillingHistory = await ctx.db
        .query("subscriptions")
        .withIndex("by_userId", (q) => q.eq("userId", args.userId))
        .first();
      return hasBillingHistory ? { kind: "lapsed" } : { kind: "not_applicable" };
    }

    const selection = selectOnDemandRenewalCandidate(subscriptions, args.now);
    if (selection.kind !== "candidate") {
      return selection;
    }
    const candidate = selection.candidate;

    await ctx.db.patch(candidate._id, {
      renewalVerificationState: "pending",
      renewalVerificationAttemptAt: args.now,
    });
    return {
      kind: "claimed",
      claimedAt: args.now,
      subscription: {
        _id: candidate._id,
        userId: candidate.userId,
        dodoSubscriptionId: candidate.dodoSubscriptionId,
        currentPeriodEnd: candidate.currentPeriodEnd,
        lastReconcileAttemptAt: candidate.lastReconcileAttemptAt,
        reconcileFailureCount: candidate.reconcileFailureCount,
        reconcileNotFoundCount: candidate.reconcileNotFoundCount,
      },
    };
  },
});

/**
 * Resolves the user-level state after one claimed row has been reconciled.
 * This is deliberately read-only: if another row is unresolved, the current
 * action returns a short retry instead of claiming it and accidentally
 * stranding a lease without making the corresponding provider call.
 */
export const getOnDemandRenewalResolution = internalQuery({
  args: {
    userId: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args): Promise<OnDemandRenewalResolution> => {
    const entitlement = await ctx.db
      .query("entitlements")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();
    if (
      entitlement &&
      entitlement.features.tier > 0 &&
      entitlement.validUntil >= args.now
    ) {
      return { kind: "active" };
    }

    const subscriptions = await queryRecentlyStaleActiveSubscriptions(
      ctx,
      args.userId,
      args.now,
    );

    if (subscriptions.length === 0) {
      return { kind: "lapsed" };
    }

    const selection = selectOnDemandRenewalCandidate(subscriptions, args.now);
    return selection.kind === "candidate"
      ? { kind: "unresolved" }
      : selection;
  },
});

export const finalizeRecentlyStaleSubscriptionVerification = internalMutation({
  args: {
    subscriptionId: v.id("subscriptions"),
    claimedAt: v.number(),
    status: v.union(
      v.literal("active"),
      v.literal("failed"),
      v.literal("lapsed"),
    ),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.subscriptionId);
    if (
      !existing ||
      existing.renewalVerificationState !== "pending" ||
      existing.renewalVerificationAttemptAt !== args.claimedAt
    ) {
      return;
    }
    await ctx.db.patch(args.subscriptionId, args.status === "active"
      ? {
          renewalVerificationState: undefined,
          renewalVerificationAttemptAt: undefined,
        }
      : { renewalVerificationState: args.status });
  },
});

/**
 * Marks a reconcile attempt on a stale-active subscription row: bumps
 * `reconcileFailureCount` and stamps `lastReconcileAttemptAt` so the
 * exponential backoff in `isReconcileEligible` de-prioritises permanently-
 * failing rows and they stop hogging the scan window.
 *
 * Used ONLY for no-progress outcomes that never reach
 * `applyDodoSubscriptionReconciliation` — a failed Dodo lookup and an
 * unsupported/pending remote status. The remote-not-newer and
 * concurrently-updated skips record their own attempt inside `apply`'s
 * transaction (no separate round-trip).
 *
 * Deliberately does NOT touch `updatedAt` — that field carries webhook
 * ordering semantics (`isNewerEvent`) and must not be perturbed by a
 * bookkeeping write. Skips rows a concurrent webhook already moved out of the
 * active set.
 */
export const markDodoReconcileAttempt = internalMutation({
  args: {
    subscriptionId: v.id("subscriptions"),
    observedAt: v.number(),
    // Whether THIS attempt was a definitive Dodo 404. Advances the
    // consecutive-not-found counter that gates the terminal downgrade; a
    // non-404 attempt resets that streak (a 404 must REPEAT consecutively).
    notFound: v.boolean(),
    // "on_demand" attempts (#4770 request-path verification) participate in
    // the 404 streak — provider evidence counts regardless of which path saw
    // it — but must NOT touch the cron's backoff fields: a customer retrying
    // through a Dodo blip (one attempt per 60s failure cooldown) would
    // otherwise push reconcileFailureCount to the 30-day backoff cap and
    // silence the nightly safety net for that row. Default: "cron".
    source: v.optional(v.union(v.literal("cron"), v.literal("on_demand"))),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.subscriptionId);
    if (!existing || existing.status !== "active") return;
    await ctx.db.patch(args.subscriptionId, {
      ...(args.source === "on_demand"
        ? {}
        : {
            lastReconcileAttemptAt: args.observedAt,
            reconcileFailureCount: (existing.reconcileFailureCount ?? 0) + 1,
          }),
      reconcileNotFoundCount: args.notFound
        ? (existing.reconcileNotFoundCount ?? 0) + 1
        : 0,
    });
  },
});

export const applyDodoSubscriptionReconciliation = internalMutation({
  args: {
    subscriptionId: v.id("subscriptions"),
    dodoSubscriptionId: v.string(),
    observedAt: v.number(),
    // See markDodoReconcileAttempt: "on_demand" keeps the 404-streak semantics
    // but never bumps the cron backoff fields. Default: "cron".
    source: v.optional(v.union(v.literal("cron"), v.literal("on_demand"))),
    remote: v.object({
      dodoSubscriptionId: v.string(),
      productId: v.string(),
      status: v.union(
        v.literal("active"),
        v.literal("on_hold"),
        v.literal("cancelled"),
        v.literal("expired"),
      ),
      currentPeriodStart: v.number(),
      currentPeriodEnd: v.number(),
      dodoCustomerId: v.optional(v.string()),
      cancelledAt: v.optional(v.number()),
      rawPayload: v.any(),
    }),
  },
  handler: async (ctx, args): Promise<ReconciliationMutationResult> => {
    const existing = await ctx.db.get(args.subscriptionId);
    if (!existing) {
      return { kind: "skipped", reason: "local_missing" };
    }
    if (existing.dodoSubscriptionId !== args.dodoSubscriptionId) {
      throw new Error(
        `[billing/reconcile] subscription id mismatch: expected ${existing.dodoSubscriptionId}, got ${args.dodoSubscriptionId}`,
      );
    }

    // A concurrent webhook may have already moved the row out of the
    // stale-active set (renewed / cancelled-with-future-period / expired). No
    // work and it left the reconciliation set, so no backoff bookkeeping.
    if (existing.status !== "active" || existing.currentPeriodEnd >= args.observedAt) {
      return { kind: "skipped", reason: "local_no_longer_stale" };
    }

    // Fold the backoff bookkeeping into the no-progress skip branches so a
    // still-stale row that we won't advance is recorded in the SAME transaction
    // that read it — no second `markDodoReconcileAttempt` round-trip. Never
    // touches `updatedAt` (that carries webhook ordering semantics).
    const recordAttempt = async (): Promise<void> => {
      await ctx.db.patch(existing._id, {
        ...(args.source === "on_demand"
          ? {}
          : {
              lastReconcileAttemptAt: args.observedAt,
              reconcileFailureCount: (existing.reconcileFailureCount ?? 0) + 1,
            }),
        // These skips prove the sub still EXISTS in Dodo, so any prior 404
        // streak is broken (both sources — provider evidence either way).
        reconcileNotFoundCount: 0,
      });
    };

    // Out-of-order guard, identical to every webhook handler. Between the
    // stale-scan read and this mutation a concurrent lifecycle webhook (e.g.
    // `subscription.plan_changed`, which patches planKey/productId but NOT
    // currentPeriodEnd) may have written a newer state. Our `observedAt` is the
    // cron's read time; if the row was updated at/after it, the cron holds a
    // stale snapshot and must not clobber the webhook's write. The row is still
    // stale-active (checked above), so back it off.
    if (!isNewerEvent(existing.updatedAt, args.observedAt)) {
      await recordAttempt();
      return { kind: "skipped", reason: "local_updated_concurrently" };
    }

    if (
      args.remote.status === existing.status &&
      args.remote.productId === existing.dodoProductId &&
      args.remote.currentPeriodEnd <= existing.currentPeriodEnd &&
      (args.remote.dodoCustomerId ?? existing.dodoCustomerId) === existing.dodoCustomerId
    ) {
      await recordAttempt();
      return { kind: "skipped", reason: "remote_not_newer" };
    }

    // Reuse the shared webhook resolver so reconciliation and organic webhook
    // ingestion resolve a Dodo product ID to a plan key IDENTICALLY —
    // productPlans table → LEGACY_PRODUCT_ALIASES → enterprise over-grant
    // fallback (with the same structured console.error escalation).
    let planKey = existing.planKey;
    if (args.remote.productId !== existing.dodoProductId) {
      planKey = await resolvePlanKey(ctx, args.remote.productId);
    }

    // Does this patch actually move the row OUT of the stale-active set? It does
    // unless the remote is still active with a period end that is itself still
    // in the past (Dodo hasn't renewed either). When it does NOT, treat this as
    // a no-progress attempt: record a backoff instead of clearing the
    // bookkeeping, so the still-stale row isn't re-fetched (and re-reconciled)
    // every cycle with a fresh clean slate.
    const stillStaleAfterPatch =
      args.remote.status === "active" && args.remote.currentPeriodEnd < args.observedAt;
    await ctx.db.patch(existing._id, {
      status: args.remote.status,
      dodoProductId: args.remote.productId,
      planKey,
      currentPeriodStart: args.remote.currentPeriodStart,
      currentPeriodEnd: args.remote.currentPeriodEnd,
      dodoCustomerId: args.remote.dodoCustomerId ?? existing.dodoCustomerId,
      rawPayload: args.remote.rawPayload,
      updatedAt: args.observedAt,
      // A successful lookup proves the sub EXISTS in Dodo → any 404 streak is
      // broken (reset to 0 while still stale, cleared once it leaves the set).
      ...(stillStaleAfterPatch
        ? {
            ...(args.source === "on_demand"
              ? {}
              : {
                  lastReconcileAttemptAt: args.observedAt,
                  reconcileFailureCount: (existing.reconcileFailureCount ?? 0) + 1,
                }),
            reconcileNotFoundCount: 0,
          }
        : {
            // Row left the stale-active set — clear bookkeeping so a later miss
            // starts from a clean slate.
            lastReconcileAttemptAt: undefined,
            reconcileFailureCount: undefined,
            reconcileNotFoundCount: undefined,
            renewalVerificationState: undefined,
            renewalVerificationAttemptAt: undefined,
          }),
      ...(args.remote.status === "cancelled"
        ? { cancelledAt: args.remote.cancelledAt ?? existing.cancelledAt ?? args.observedAt }
        : {}),
    });

    await recomputeEntitlementFromAllSubs(ctx, existing.userId, args.observedAt);
    return {
      kind: "reconciled",
      status: args.remote.status,
      planKey,
      currentPeriodEnd: args.remote.currentPeriodEnd,
    };
  },
});

/**
 * Downgrades a stale-active local row to `expired` after the reconciler
 * confirmed the subscription no longer exists in Dodo (a definitive, repeated
 * 404 — see `isDefinitiveDodoNotFound` + the confirmation threshold). This is
 * the terminal counterpart to the backoff path: instead of retrying a row that
 * will never resolve, it moves it OUT of the active set, which simultaneously
 * frees its scan slot, ends the entitlement over-grant, and lets the entitlement
 * recompute downgrade the user.
 *
 * Guards mirror `applyDodoSubscriptionReconciliation`: skip if the row already
 * left the stale-active set or a concurrent webhook wrote a newer state.
 */
export const expireMissingDodoSubscription = internalMutation({
  args: {
    subscriptionId: v.id("subscriptions"),
    dodoSubscriptionId: v.string(),
    observedAt: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ kind: "expired" } | { kind: "skipped"; reason: ReconciliationSkipReason }> => {
    const existing = await ctx.db.get(args.subscriptionId);
    if (!existing) {
      return { kind: "skipped", reason: "local_missing" };
    }
    if (existing.dodoSubscriptionId !== args.dodoSubscriptionId) {
      throw new Error(
        `[billing/reconcile] subscription id mismatch: expected ${existing.dodoSubscriptionId}, got ${args.dodoSubscriptionId}`,
      );
    }
    if (existing.status !== "active" || existing.currentPeriodEnd >= args.observedAt) {
      return { kind: "skipped", reason: "local_no_longer_stale" };
    }
    if (!isNewerEvent(existing.updatedAt, args.observedAt)) {
      return { kind: "skipped", reason: "local_updated_concurrently" };
    }

    await ctx.db.patch(existing._id, {
      status: "expired",
      updatedAt: args.observedAt,
      lastReconcileAttemptAt: undefined,
      reconcileFailureCount: undefined,
      reconcileNotFoundCount: undefined,
      renewalVerificationState: undefined,
      renewalVerificationAttemptAt: undefined,
    });
    await recomputeEntitlementFromAllSubs(ctx, existing.userId, args.observedAt);
    return { kind: "expired" };
  },
});

type StaleRowOutcome =
  | {
      kind: "reconciled";
      status: SubscriptionStatus;
      currentPeriodEnd: number;
    }
  | {
      kind: "skipped";
      reason: ReconciliationSkipReason | "remote_status_unusable";
    }
  | { kind: "failed"; error: string }
  // Confirmed terminal not-found (definitive 404 past the confirmation
  // threshold). The row is NOT downgraded here — the action loop decides,
  // gated by the mass-404 circuit breaker, whether to expire it or route it to
  // the backoff path.
  | { kind: "terminal_not_found"; error: string };

// Best-effort backoff bookkeeping for the paths that never reach
// `applyDodoSubscriptionReconciliation` (Dodo lookup failure, unsupported/pending
// status). Swallows its own error so a bookkeeping OCC conflict can never abort
// the batch or skip continuation scheduling.
export async function safeMarkReconcileAttempt(
  ctx: Pick<ActionCtx, "runMutation">,
  subscriptionId: Id<"subscriptions">,
  observedAt: number,
  notFound: boolean,
  source: "cron" | "on_demand" = "cron",
): Promise<void> {
  try {
    await ctx.runMutation(internal.payments.billing.markDodoReconcileAttempt, {
      subscriptionId,
      observedAt,
      notFound,
      source,
    });
  } catch (markErr) {
    // sentry-coverage-ok: structured console.error is forwarded by Convex
    // auto-Sentry. Deliberately swallowed (not re-thrown): a failed best-effort
    // backoff write must never abort the batch or skip continuation scheduling —
    // the row simply isn't backed off this once and is re-attempted next run.
    console.error(
      `[billing/reconcile] markDodoReconcileAttempt failed for ${subscriptionId}: ${markErr instanceof Error ? markErr.message : String(markErr)}`,
    );
  }
}

// Reconcile a single stale-active row against Dodo truth. Fetch → normalize →
// apply mutation → interpret, with the transient-vs-terminal error split. Never
// throws — one bad row must not block the rest of the batch; returns the outcome
// for the caller to fold into the summary.
async function reconcileOneStaleRow(
  ctx: Pick<ActionCtx, "runMutation">,
  sub: StaleActiveSubscriptionForRenewalReconciliation,
  opts: {
    now: number;
    useTestRemotes: boolean;
    remoteById: Map<string, DodoReconciliationRemoteSubscription>;
    errorInjection: Map<string, "not_found" | "server_error">;
    client: DodoPayments | null;
    // "on_demand" (#4770 request path) advances/resets the 404 streak like any
    // provider attempt but never bumps the cron backoff fields. Default "cron".
    source?: "cron" | "on_demand";
  },
): Promise<StaleRowOutcome> {
  const { now, useTestRemotes, remoteById, errorInjection, client, source = "cron" } = opts;
  try {
    let remote: DodoSubscription | DodoReconciliationRemoteSubscription | undefined;
    if (useTestRemotes) {
      const injected = errorInjection.get(sub.dodoSubscriptionId);
      if (injected === "not_found") {
        throw Object.assign(new Error("simulated Dodo not found"), { status: 404 });
      }
      if (injected === "server_error") {
        throw Object.assign(new Error("simulated Dodo server error"), { status: 500 });
      }
      remote = remoteById.get(sub.dodoSubscriptionId);
    } else {
      remote = await client!.subscriptions.retrieve(sub.dodoSubscriptionId);
    }
    if (!remote) {
      throw new Error("missing test remote subscription");
    }

    const normalized = normalizeRemoteSubscription(remote);
    if (normalized.kind === "skip") {
      // sentry-coverage-ok: escalated to error (Convex auto-Sentry captures
      // error, not warn) so a `pending`/unknown remote status that a
      // local-active row is stuck on gets triaged rather than silently skipped
      // daily.
      console.error(
        `[billing/reconcile] Skipping subscription ${normalized.dodoSubscriptionId}: ${normalized.reason} Dodo status "${normalized.status}"`,
      );
      // Row is still stale-active — back it off (not a 404, resets the streak).
      await safeMarkReconcileAttempt(ctx, sub._id, now, false, source);
      return { kind: "skipped", reason: "remote_status_unusable" };
    }

    const result = (await ctx.runMutation(
      internal.payments.billing.applyDodoSubscriptionReconciliation,
      {
        subscriptionId: sub._id,
        dodoSubscriptionId: sub.dodoSubscriptionId,
        observedAt: now,
        remote: normalized.value,
        source,
      },
    )) as ReconciliationMutationResult;
    // `apply` records its own backoff for the still-stale skip reasons.
    return result.kind === "reconciled"
      ? {
          kind: "reconciled",
          status: result.status,
          currentPeriodEnd: result.currentPeriodEnd,
        }
      : { kind: "skipped", reason: result.reason };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const notFound = isDefinitiveDodoNotFound(err);
    // Confirmed terminal not-found: a definitive 404 AND the row already has
    // >= the confirmation threshold of CONSECUTIVE prior 404s (so a single
    // flaky 404 — or a 404 preceded by an unrelated 5xx — can't downgrade a
    // paying customer). Hand it to the loop, which applies the mass-404 circuit
    // breaker before actually downgrading. Do NOT back it off here — the loop
    // either downgrades it or routes it to backoff.
    if (
      notFound &&
      (sub.reconcileNotFoundCount ?? 0) >= DODO_RENEWAL_TERMINAL_NOTFOUND_MIN_PRIOR_FAILURES
    ) {
      return { kind: "terminal_not_found", error: message };
    }
    // Transient (5xx / network / timeout) OR an unconfirmed 404 → back off and
    // retry; never downgrade on an ambiguous signal. Pass `notFound` so a 404
    // advances the consecutive-404 streak while any other failure resets it.
    // sentry-coverage-ok: structured console.error is forwarded by Convex
    // auto-Sentry. We intentionally do not re-throw here because one bad Dodo
    // lookup must not block reconciliation for other stale subscribers.
    console.error(
      `[billing/reconcile] Failed to reconcile dodoSubscriptionId=${sub.dodoSubscriptionId} userId=${sub.userId}: ${message}`,
    );
    await safeMarkReconcileAttempt(ctx, sub._id, now, notFound, source);
    return { kind: "failed", error: message };
  }
}

async function finalizeOnDemandRenewalVerification(
  ctx: Pick<ActionCtx, "runMutation">,
  claim: Extract<OnDemandRenewalClaim, { kind: "claimed" }>,
  status: "active" | "failed" | "lapsed",
): Promise<void> {
  await ctx.runMutation(
    internal.payments.billing.finalizeRecentlyStaleSubscriptionVerification,
    {
      subscriptionId: claim.subscription._id,
      claimedAt: claim.claimedAt,
      status,
    },
  );
}

const ON_DEMAND_RENEWAL_FAILURE_RETRY_SECONDS = Math.ceil(
  ON_DEMAND_RENEWAL_FAILURE_COOLDOWN_MS / 1000,
);

function onDemandRenewalFailureResult(): OnDemandRenewalResult {
  return {
    status: "renewal_verification_failed",
    retryAfterSeconds: ON_DEMAND_RENEWAL_FAILURE_RETRY_SECONDS,
  };
}

/**
 * Bounded request-path rescue for a recently expired local entitlement.
 * Reuses the cron's provider normalization + race-safe apply mutation, while a
 * durable claim prevents concurrent premium requests from fanning out to Dodo.
 */
export const verifyRecentlyStaleSubscriptionOnDemand = internalAction({
  args: {
    userId: v.string(),
    now: v.optional(v.number()),
    remoteSubscriptionsForTest: v.optional(
      v.array(dodoReconciliationRemoteSubscriptionValidator),
    ),
    errorInjectionForTest: v.optional(
      v.record(
        v.string(),
        v.union(v.literal("not_found"), v.literal("server_error")),
      ),
    ),
    convexFailureInjectionForTest: v.optional(
      v.union(
        v.literal("post_reconcile_query"),
        v.literal("finalize"),
      ),
    ),
  },
  handler: async (ctx, args): Promise<OnDemandRenewalResult> => {
    const usesTestInjection =
      args.remoteSubscriptionsForTest !== undefined ||
      args.errorInjectionForTest !== undefined ||
      args.convexFailureInjectionForTest !== undefined;
    if (usesTestInjection && process.env.NODE_ENV !== "test") {
      throw new Error(
        "[billing/on-demand-renewal] test injection args are only allowed under test",
      );
    }

    const now = args.now ?? Date.now();
    const claim = (await ctx.runMutation(
      internal.payments.billing.claimRecentlyStaleSubscriptionForVerification,
      { userId: args.userId, now },
    )) as OnDemandRenewalClaim;

    switch (claim.kind) {
      case "pending":
        return {
          status: "renewal_verification_pending",
          retryAfterSeconds: claim.retryAfterSeconds,
        };
      case "failed":
        return {
          status: "renewal_verification_failed",
          retryAfterSeconds: claim.retryAfterSeconds,
        };
      case "lapsed":
        return { status: "subscription_lapsed" };
      case "not_applicable":
        return { status: "not_applicable" };
      case "claimed":
        break;
    }

    const remoteById = new Map(
      (args.remoteSubscriptionsForTest ?? []).map((remote) => [
        remote.subscription_id,
        remote,
      ]),
    );
    const errorInjection = new Map<string, "not_found" | "server_error">(
      Object.entries(args.errorInjectionForTest ?? {}),
    );
    let injectFinalizeFailure = args.convexFailureInjectionForTest === "finalize";
    const safeFinalize = async (
      status: "active" | "failed" | "lapsed",
    ): Promise<boolean> => {
      try {
        if (injectFinalizeFailure) {
          injectFinalizeFailure = false;
          throw new Error("simulated post-claim finalize failure");
        }
        await finalizeOnDemandRenewalVerification(ctx, claim, status);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // sentry-coverage-ok: Convex auto-Sentry captures console.error. This
        // action must return a typed retry response instead of letting a
        // post-provider Convex failure become an opaque 500.
        console.error(
          `[billing/on-demand-renewal] Failed to finalize ${status} verification dodoSubscriptionId=${claim.subscription.dodoSubscriptionId} userId=${claim.subscription.userId}: ${message}`,
        );
        return false;
      }
    };
    const bestEffortFinalizeFailed = async (): Promise<void> => {
      if (!(await safeFinalize("failed"))) {
        // One bounded retry contains a transient Convex failure without
        // turning the request into an unbounded mutation loop.
        await safeFinalize("failed");
      }
    };

    let outcome: StaleRowOutcome;
    try {
      const client = usesTestInjection
        ? null
        : getDodoClient({ timeout: ON_DEMAND_RENEWAL_TIMEOUT_MS, maxRetries: 0 });
      outcome = await reconcileOneStaleRow(ctx, claim.subscription, {
        now,
        useTestRemotes: usesTestInjection,
        remoteById,
        errorInjection,
        client,
        source: "on_demand",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // sentry-coverage-ok: Convex auto-Sentry captures console.error. Do not
      // include provider response bodies or secrets in this customer-path log.
      console.error(
        `[billing/on-demand-renewal] Failed before Dodo verification dodoSubscriptionId=${claim.subscription.dodoSubscriptionId} userId=${claim.subscription.userId}: ${message}`,
      );
      await bestEffortFinalizeFailed();
      return onDemandRenewalFailureResult();
    }

    const outcomeConfirmsCoveringPeriod =
      outcome.kind === "reconciled" &&
      outcome.status !== "expired" &&
      outcome.currentPeriodEnd >= now;
    if (outcomeConfirmsCoveringPeriod) {
      // `applyDodoSubscriptionReconciliation` atomically wrote the covering
      // subscription and recomputed entitlement before returning. Finalize is
      // only lease cleanup here, so a cleanup failure must not hide confirmed
      // paid access from this request.
      await safeFinalize("active");
      return { status: "active" };
    }

    const outcomeIsUncertain =
      outcome.kind === "failed" ||
      outcome.kind === "terminal_not_found" ||
      (outcome.kind === "skipped" &&
        (outcome.reason === "local_missing" ||
          outcome.reason === "remote_status_unusable" ||
          outcome.reason === "local_updated_concurrently" ||
          outcome.reason === "remote_not_newer")) ||
      (outcome.kind === "reconciled" &&
        (outcome.status === "active" || outcome.status === "on_hold"));
    if (outcomeIsUncertain) {
      await bestEffortFinalizeFailed();
      return onDemandRenewalFailureResult();
    }

    let resolution: OnDemandRenewalResolution;
    try {
      if (args.convexFailureInjectionForTest === "post_reconcile_query") {
        throw new Error("simulated post-claim resolution query failure");
      }
      resolution = (await ctx.runQuery(
        internal.payments.billing.getOnDemandRenewalResolution,
        { userId: args.userId, now },
      )) as OnDemandRenewalResolution;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // sentry-coverage-ok: Convex auto-Sentry captures console.error. The
      // provider call already happened, so contain this post-claim Convex
      // failure and leave a short, durable retry cooldown when possible.
      console.error(
        `[billing/on-demand-renewal] Failed to resolve post-reconcile user state dodoSubscriptionId=${claim.subscription.dodoSubscriptionId} userId=${claim.subscription.userId}: ${message}`,
      );
      await bestEffortFinalizeFailed();
      return onDemandRenewalFailureResult();
    }

    // Every non-active resolution finalizes the claimed row as "lapsed"
    // (definitively non-covering) and differs only in what the caller is told.
    // Single-copy so finalize-failure handling cannot drift between cases.
    const finalizeLapsedAndReturn = async (
      onSuccess: OnDemandRenewalResult,
    ): Promise<OnDemandRenewalResult> => {
      const finalized = await safeFinalize("lapsed");
      if (!finalized) await bestEffortFinalizeFailed();
      return finalized ? onSuccess : onDemandRenewalFailureResult();
    };

    switch (resolution.kind) {
      case "active":
        // A concurrent webhook or another subscription proves coverage. As
        // above, finalization is cleanup and cannot revoke that confirmation.
        await safeFinalize("active");
        return { status: "active" };
      case "pending":
        return finalizeLapsedAndReturn({
          status: "renewal_verification_pending",
          retryAfterSeconds: resolution.retryAfterSeconds,
        });
      case "unresolved":
        return finalizeLapsedAndReturn({
          status: "renewal_verification_pending",
          retryAfterSeconds: ON_DEMAND_RENEWAL_PROGRESS_RETRY_SECONDS,
        });
      case "failed":
        return finalizeLapsedAndReturn({
          status: "renewal_verification_failed",
          retryAfterSeconds: resolution.retryAfterSeconds,
        });
      case "lapsed":
        return finalizeLapsedAndReturn({ status: "subscription_lapsed" });
    }
  },
});

export const reconcileMissedDodoRenewals = internalAction({
  args: {
    now: v.optional(v.number()),
    limit: v.optional(v.number()),
    // Remaining self-scheduled continuations this cron cycle. Internal — a
    // fresh cron tick omits it (defaults to the max) and each continuation
    // passes one fewer. Bounds total work + guarantees termination.
    continuationBudget: v.optional(v.number()),
    // Opaque Convex pagination cursor threaded through continuations to page
    // forward by document position — see the scheduling block. Omitted on a
    // fresh cron tick.
    cursor: v.optional(v.union(v.string(), v.null())),
    // Mass-404 circuit-breaker state threaded through continuations so the bound
    // is per cron CYCLE, not per invocation. Omitted on a fresh cron tick.
    notFoundDowngradesSoFar: v.optional(v.number()),
    massNotFoundHalted: v.optional(v.boolean()),
    // Per-query scan window size, clamped to the const ceiling. Defaults to the
    // ceiling; a smaller value is an ops knob (and the test seam that exercises
    // the window-paging / saturation logic without seeding 500 rows). Threaded
    // through continuations so a whole cycle uses a consistent window.
    scanLimit: v.optional(v.number()),
    remoteSubscriptionsForTest: v.optional(
      v.array(dodoReconciliationRemoteSubscriptionValidator),
    ),
    // Test-only: simulate a Dodo `subscriptions.retrieve` error per subscription
    // id ("not_found" -> definitive 404, "server_error" -> transient 5xx) so the
    // terminal-vs-transient split is exercised without a live client.
    errorInjectionForTest: v.optional(
      v.record(
        v.string(),
        v.union(v.literal("not_found"), v.literal("server_error")),
      ),
    ),
  },
  handler: async (ctx, args): Promise<ReconciliationSummary> => {
    const usesTestInjection =
      args.remoteSubscriptionsForTest !== undefined ||
      args.errorInjectionForTest !== undefined;
    if (usesTestInjection && process.env.NODE_ENV !== "test") {
      throw new Error(
        "[billing/reconcile] test injection args are only allowed under test",
      );
    }

    // Logical clock for staleness + backoff (threaded unchanged through
    // continuations so a cycle stays coherent). Wall-clock is tracked
    // separately below for the action-runtime budget.
    const now = args.now ?? Date.now();
    const startedAtWallClock = Date.now();
    const limit = Math.max(
      1,
      Math.min(
        args.limit ?? DODO_RENEWAL_RECONCILIATION_BATCH_SIZE,
        DODO_RENEWAL_RECONCILIATION_BATCH_SIZE,
      ),
    );
    const scanLimit = Math.max(
      1,
      Math.min(
        args.scanLimit ?? DODO_RENEWAL_RECONCILIATION_SCAN_LIMIT,
        DODO_RENEWAL_RECONCILIATION_SCAN_LIMIT,
      ),
    );
    const continuationBudget =
      args.continuationBudget ?? DODO_RENEWAL_RECONCILIATION_MAX_CONTINUATIONS;

    const scanResult = (await ctx.runQuery(
      internal.payments.billing.listStaleActiveSubscriptionsForRenewalReconciliation,
      {
        now,
        scanLimit,
        ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
      },
    )) as StaleActiveSubscriptionsPage;
    const page = scanResult.page;

    // Skip rows still inside their post-failure backoff window so a
    // permanently-failing (poison) row can't re-occupy a scan slot every run.
    const eligible = page.filter((sub) => isReconcileEligible(sub, now));

    const remoteById = new Map(
      (args.remoteSubscriptionsForTest ?? []).map((remote) => [
        remote.subscription_id,
        remote,
      ]),
    );
    const errorInjection = new Map<string, "not_found" | "server_error">(
      Object.entries(args.errorInjectionForTest ?? {}),
    );
    const client = usesTestInjection
      ? null
      : getDodoClient({
          timeout: DODO_RENEWAL_RECONCILIATION_TIMEOUT_MS,
          // No SDK-level retry: a rate-limited/incident retry honors a server
          // Retry-After VERBATIM and could sleep minutes, blowing the Convex
          // 10-min action cap. Our row-level backoff + continuation IS the retry
          // mechanism, so each lookup stays bounded by `timeout`.
          maxRetries: 0,
        });

    const summary: ReconciliationSummary = {
      inspected: 0,
      reconciled: 0,
      expiredMissing: 0,
      skipped: 0,
      failed: 0,
      limit,
      hasMore: false,
      timeBudgetExhausted: false,
      windowSaturated: false,
      continuationScheduled: false,
      failures: [],
    };

    // Mass-404 circuit breaker. The running downgrade count and the halt latch
    // are threaded through continuations so the bound is PER CRON CYCLE, not per
    // invocation: a genuine handful of deleted subs downgrades; a batch/cycle
    // that is mostly/entirely 404 (a probable misconfig) self-halts.
    //   - Per-cycle: at most DODO_RENEWAL_MASS_NOTFOUND_ABSOLUTE_CAP downgrades
    //     total across the whole continuation chain.
    //   - Per-invocation: if downgrades in a single invocation reach a majority
    //     of what it planned to attempt, latch the halt for the rest of the cycle
    //     (a mostly-404 batch is a strong misconfig signal even under the cap).
    const plannedAttempts = Math.min(limit, eligible.length);
    const perInvocationMajorityCap = Math.ceil(plannedAttempts / 2);
    let notFoundDowngrades = args.notFoundDowngradesSoFar ?? 0;
    let massNotFoundHalted = args.massNotFoundHalted ?? false;
    let downgradesThisInvocation = 0;

    let attempted = 0;
    for (const sub of eligible) {
      if (attempted >= limit) {
        summary.hasMore = true;
        break;
      }
      if (Date.now() - startedAtWallClock >= DODO_RENEWAL_RECONCILIATION_TIME_BUDGET_MS) {
        summary.timeBudgetExhausted = true;
        summary.hasMore = true;
        break;
      }
      attempted++;
      summary.inspected++;
      const outcome = await reconcileOneStaleRow(ctx, sub, {
        now,
        useTestRemotes: usesTestInjection,
        remoteById,
        errorInjection,
        client,
      });
      switch (outcome.kind) {
        case "reconciled":
          summary.reconciled++;
          break;
        case "skipped":
          summary.skipped++;
          break;
        case "failed":
          summary.failed++;
          summary.failures.push({
            dodoSubscriptionId: sub.dodoSubscriptionId,
            error: outcome.error,
          });
          break;
        case "terminal_not_found": {
          const breakerTripped =
            massNotFoundHalted ||
            notFoundDowngrades >= DODO_RENEWAL_MASS_NOTFOUND_ABSOLUTE_CAP ||
            downgradesThisInvocation >= perInvocationMajorityCap;
          if (breakerTripped) {
            // Circuit breaker tripped — too many confirmed 404s. Treat this (and
            // every subsequent 404 this cycle) as a transient failure: keep the
            // row active and on backoff instead of downgrading a possibly-live
            // customer during a suspected wrong-environment/API-key misconfig.
            if (!massNotFoundHalted) {
              massNotFoundHalted = true;
              // sentry-coverage-ok: Convex auto-Sentry captures console.error —
              // this is the page that must fire BEFORE a second daily run could
              // downgrade the base under a config error.
              console.error(
                `[billing/reconcile] mass Dodo 404s (${notFoundDowngrades} downgraded this cycle) — possible wrong-environment/API-key misconfig; further downgrades halted for the rest of this cycle.`,
              );
            }
            summary.failed++;
            summary.failures.push({
              dodoSubscriptionId: sub.dodoSubscriptionId,
              error: outcome.error,
            });
            // Still a 404 — keep the streak so it downgrades once the breaker
            // clears (config fixed), rather than resetting confirmation.
            await safeMarkReconcileAttempt(ctx, sub._id, now, true);
            break;
          }
          // Guard the downgrade mutation: an OCC rejection (concurrent webhook on
          // the same sub/entitlement) or a recompute error must NOT propagate out
          // of the loop — that would abort the batch AND skip the continuation
          // scheduling below. Route a failed downgrade to the backoff path.
          let expireResult:
            | { kind: "expired" }
            | { kind: "skipped"; reason: ReconciliationSkipReason };
          try {
            expireResult = (await ctx.runMutation(
              internal.payments.billing.expireMissingDodoSubscription,
              {
                subscriptionId: sub._id,
                dodoSubscriptionId: sub.dodoSubscriptionId,
                observedAt: now,
              },
            )) as { kind: "expired" } | { kind: "skipped"; reason: ReconciliationSkipReason };
          } catch (expireErr) {
            const expireMsg =
              expireErr instanceof Error ? expireErr.message : String(expireErr);
            // sentry-coverage-ok: Convex auto-Sentry captures console.error.
            console.error(
              `[billing/reconcile] expireMissingDodoSubscription failed for dodoSubscriptionId=${sub.dodoSubscriptionId} userId=${sub.userId}: ${expireMsg}`,
            );
            summary.failed++;
            summary.failures.push({
              dodoSubscriptionId: sub.dodoSubscriptionId,
              error: expireMsg,
            });
            await safeMarkReconcileAttempt(ctx, sub._id, now, true);
            break;
          }
          if (expireResult.kind === "expired") {
            notFoundDowngrades++;
            downgradesThisInvocation++;
            summary.expiredMissing++;
            // sentry-coverage-ok: Convex auto-Sentry captures console.error so
            // ops sees confirmed-gone subscriptions being downgraded.
            console.error(
              `[billing/reconcile] dodoSubscriptionId=${sub.dodoSubscriptionId} userId=${sub.userId} confirmed not-found in Dodo after ${(sub.reconcileFailureCount ?? 0) + 1} attempts; downgraded local row to expired.`,
            );
          } else {
            // A concurrent webhook already moved the row out of the stale set.
            summary.skipped++;
          }
          break;
        }
      }
    }

    // Did we finish this page's eligible rows (none left un-attempted due to the
    // batch/time budget)? If so, and more pages exist, page forward via the
    // opaque cursor. Otherwise keep the cursor so the continuation re-fetches
    // this page and finishes draining it — the rows we just attempted are backed
    // off now, so the eligible set strictly shrinks.
    const pageDrained = eligible.length <= attempted;
    const advanceToNextPage = pageDrained && !scanResult.isDone;
    // Whole non-empty page was ineligible (all inside their backoff window) and
    // more pages remain — surfaced so an operator can tell "cooldown-saturated"
    // from "nothing stale". Position-based paging advances past it regardless,
    // so it never strands the rows behind it.
    summary.windowSaturated = page.length > 0 && eligible.length === 0 && !scanResult.isDone;

    if (summary.windowSaturated) {
      // sentry-coverage-ok: Convex auto-Sentry captures console.error.
      console.error(
        `[billing/reconcile] scan page saturated: all ${page.length} scanned stale rows are within their reconcile backoff window; paging forward to reach rows behind them.`,
      );
    }

    const nextCursor = advanceToNextPage ? scanResult.continueCursor : args.cursor;
    const cursorAdvanced = advanceToNextPage;

    // More work remains if we couldn't attempt every eligible row on this page,
    // or more pages exist beyond it.
    summary.hasMore = eligible.length > attempted || !scanResult.isDone;

    if (summary.failed > 0) {
      console.error(
        `[billing/reconcile] ${summary.failed}/${summary.inspected} attempted stale active subscriptions failed reconciliation`,
      );
    }

    // Chain a continuation when work remains AND we are guaranteed to make
    // progress next invocation: either we attempted rows this pass (the current
    // page's eligible set shrank) or the cursor advanced to a new page.
    // Advancing on a saturated page is what stops a fully-backed-off page from
    // silently stranding the healthy rows behind it. `continuationBudget` is the
    // hard termination cap.
    if (
      summary.hasMore &&
      continuationBudget > 0 &&
      (attempted > 0 || cursorAdvanced)
    ) {
      await ctx.scheduler.runAfter(
        0,
        internal.payments.billing.reconcileMissedDodoRenewals,
        {
          now,
          limit,
          scanLimit,
          continuationBudget: continuationBudget - 1,
          cursor: nextCursor ?? null,
          // Carry the mass-404 breaker state so the cap is per cron cycle.
          notFoundDowngradesSoFar: notFoundDowngrades,
          massNotFoundHalted,
          ...(args.remoteSubscriptionsForTest
            ? { remoteSubscriptionsForTest: args.remoteSubscriptionsForTest }
            : {}),
          ...(args.errorInjectionForTest
            ? { errorInjectionForTest: args.errorInjectionForTest }
            : {}),
        },
      );
      summary.continuationScheduled = true;
    }

    // No run-lock guards a still-draining continuation chain against the next
    // daily cron tick (the two could overlap). Left intentionally: every write
    // path is idempotent under overlap — the per-row mutations re-check
    // staleness + `isNewerEvent(updatedAt, observedAt)` and Convex OCC serializes
    // conflicting writes, so a duplicate pass at worst re-marks a backoff (benign)
    // and never double-applies a reconcile.
    return summary;
  },
});

/**
 * One-shot backfill: populate the new `subscriptions.dodoCustomerId`
 * column for existing rows. Run once after the schema change ships;
 * idempotent (already-populated rows skipped on re-run).
 *
 * Two recovery sources, tried in order:
 *   1. `rawPayload.customer.customer_id` from the subscription row
 *      itself — covers most pre-PR rows (the customer field was on
 *      the original `subscription.active` payload).
 *   2. `customers.dodoCustomerId` matched by the sub's `userId` —
 *      recovers the pathological case where a pre-PR lifecycle event
 *      wiped `rawPayload.customer` before this PR shipped, but the
 *      customers row still has a usable mapping for the same userId.
 *      Refuses cross-user collision (matches by userId only) — this
 *      is a backfill, not a re-attribution.
 *
 * Run:
 *   npx convex run payments/billing:backfillSubscriptionDodoCustomerId
 *
 * Returns
 *   `{ inspected, populatedFromPayload, populatedFromCustomers,
 *      alreadyPopulated, unrecoverable }`
 * so the operator can see which recovery source covered each sub and
 * which rows still need manual triage (unrecoverable = neither source
 * had data).
 */
export const backfillSubscriptionDodoCustomerId = internalMutation({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("subscriptions").collect();
    const summary = {
      inspected: all.length,
      populatedFromPayload: 0,
      populatedFromCustomers: 0,
      alreadyPopulated: 0,
      unrecoverable: 0,
    };
    for (const sub of all) {
      if (typeof sub.dodoCustomerId === "string" && sub.dodoCustomerId.length > 0) {
        summary.alreadyPopulated++;
        continue;
      }
      // Source 1: rawPayload.
      const payload = sub.rawPayload as
        | { customer?: { customer_id?: unknown } }
        | null
        | undefined;
      const fromPayload = payload?.customer?.customer_id;
      if (typeof fromPayload === "string" && fromPayload.length > 0) {
        await ctx.db.patch(sub._id, { dodoCustomerId: fromPayload });
        summary.populatedFromPayload++;
        continue;
      }
      // Source 2: same-userId customers row (P1 reviewer's
      // "pre-schema row had its rawPayload wiped before the PR" case).
      const customer = await ctx.db
        .query("customers")
        .withIndex("by_userId", (q) => q.eq("userId", sub.userId))
        .first();
      const fromCustomer = customer?.dodoCustomerId;
      if (typeof fromCustomer === "string" && fromCustomer.length > 0) {
        await ctx.db.patch(sub._id, { dodoCustomerId: fromCustomer });
        summary.populatedFromCustomers++;
        continue;
      }
      summary.unrecoverable++;
    }
    return summary;
  },
});

/**
 * Read-only diagnostic: dump the customers row + every subscription's
 * stored payload data for a list of userIds.
 *
 * Used to triage the cross-user collision class surfaced by
 * `backfillMissingCustomers` — where one Dodo `customer_id` is claimed
 * by one Clerk userId in the `customers` table but appears in another
 * userId's subscription `rawPayload`. Most likely cause: Dodo dedupes
 * customer records by email, so the same email used under two Clerk
 * accounts yields the same `cus_xxx`.
 *
 * Run:
 *   npx convex run --prod payments/billing:inspectCustomerOwnership \
 *     '{"userIds":["user_3Cbg...","user_3Cbi...",...]}'
 *
 * Per-row output includes:
 *   - `customer.email` (canonical email from the customers row)
 *   - `customer.dodoCustomerId`
 *   - `subscriptions[].rawPayloadEmail` (email Dodo sent at webhook time)
 *   - `subscriptions[].rawPayloadCustomerId`
 *
 * If two userIds share the same `customer.email` (or the same
 * `rawPayloadEmail` across their subscriptions), that's the smoking
 * gun for "Dodo dedupes by email + same human made two Clerk
 * accounts". Resolve by emailing the human, asking which account to
 * keep, and merging via `claimSubscription` or a manual patch.
 *
 * Bounded to 50 userIds per call (each performs 2 indexed reads — the
 * Convex query budget is 1s wall-clock + 16k document reads per
 * transaction; 50×2=100 reads is well under both). Greptile P2 review:
 * `v.array` has no built-in maxLength option, so the bound is enforced
 * at the top of the handler with an explicit ConvexError.
 */
export const inspectCustomerOwnership = internalQuery({
  args: { userIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    if (args.userIds.length > 50) {
      throw new ConvexError({
        kind: "TOO_MANY_USERIDS",
        max: 50,
        provided: args.userIds.length,
      });
    }
    const rows = [];
    for (const userId of args.userIds) {
      const customer = await ctx.db
        .query("customers")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .first();
      const subs = await ctx.db
        .query("subscriptions")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .collect();
      rows.push({
        userId,
        customer: customer
          ? {
              dodoCustomerId: customer.dodoCustomerId ?? null,
              email: customer.email,
              normalizedEmail: customer.normalizedEmail ?? null,
              createdAt: new Date(customer.createdAt).toISOString(),
            }
          : null,
        subscriptions: subs.map((s) => {
          const p = s.rawPayload as
            | { customer?: { customer_id?: unknown; email?: unknown } }
            | null
            | undefined;
          return {
            dodoSubscriptionId: s.dodoSubscriptionId,
            planKey: s.planKey,
            status: s.status,
            currentPeriodEnd: new Date(s.currentPeriodEnd).toISOString(),
            rawPayloadCustomerId:
              typeof p?.customer?.customer_id === "string"
                ? p.customer.customer_id
                : null,
            rawPayloadEmail:
              typeof p?.customer?.email === "string" ? p.customer.email : null,
          };
        }),
      });
    }
    return rows;
  },
});

/**
 * Last-resort repair when an entitled user has no `customers` row.
 *
 * The Dodo `subscription.active` handler writes the `subscriptions` row
 * unconditionally but only writes `customers` when `data.customer?.customer_id`
 * is present in the webhook payload (`subscriptionHelpers.ts:525`). Webhook
 * deliveries that omitted the customer field leave the user entitled but with
 * no portal-resolvable record — clicking "Manage Billing" then throws
 * `NO_CUSTOMER`.
 *
 * The subscription row carries the full webhook payload in `rawPayload`, so
 * the dodoCustomerId is recoverable from there. Walk the user's
 * subscriptions newest-first (preferring `active`, then `on_hold` or
 * `cancelled`), find the first one whose `rawPayload.customer.customer_id`
 * is a string, and upsert a customers row from it. Logs at warning level so
 * a sustained repair rate is queryable in Convex logs — that's the signal
 * to harden the webhook handler.
 *
 * Returns the resulting `customers` document, or null if no payload yielded
 * a usable dodoCustomerId (or the dodoCustomerId already maps to a
 * different userId, which is a distinct cross-user integrity issue we
 * deliberately don't auto-overwrite).
 */
export const repairCustomerFromSubscriptionPayload = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const subs = await ctx.db
      .query("subscriptions")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .take(50);

    // Prefer active → on_hold → cancelled, then newest updatedAt within tier.
    const priority = (status: string): number =>
      status === "active" ? 0 :
      status === "on_hold" ? 1 :
      status === "cancelled" ? 2 :
      3;
    subs.sort((a, b) => {
      const pa = priority(a.status);
      const pb = priority(b.status);
      if (pa !== pb) return pa - pb;
      return b.updatedAt - a.updatedAt;
    });

    for (const sub of subs) {
      const payload = sub.rawPayload as
        | { customer?: { customer_id?: unknown; email?: unknown } }
        | null
        | undefined;
      const rawId = payload?.customer?.customer_id;
      const dodoCustomerId = typeof rawId === "string" && rawId.length > 0 ? rawId : null;
      if (!dodoCustomerId) continue;

      const rawEmail = payload?.customer?.email;
      const email = typeof rawEmail === "string" ? rawEmail : "";
      const normalizedEmail = email.trim().toLowerCase();
      const now = Date.now();

      // Cross-user collision check: if a customers row with this
      // dodoCustomerId already exists for a DIFFERENT userId, don't
      // auto-overwrite — that's a cross-user integrity issue (one Dodo
      // customer mapped to two Clerk users) that deserves manual triage.
      const collidingByDodo = await ctx.db
        .query("customers")
        .withIndex("by_dodoCustomerId", (q) => q.eq("dodoCustomerId", dodoCustomerId))
        .first();
      if (collidingByDodo && collidingByDodo.userId !== args.userId) {
        console.warn(
          `[billing/repair] customers.dodoCustomerId=${dodoCustomerId} already mapped to userId=${collidingByDodo.userId}; refusing to remap to userId=${args.userId}.`,
        );
        return null;
      }

      // by_userId precedence: a row may already exist for this user
      // WITHOUT a dodoCustomerId (the field is `v.optional(v.string())`
      // so a null/missing value is a valid pre-existing schema state).
      // In that case, PATCH the existing row instead of inserting a
      // second one — `getCustomerByUserId` uses `.first()` defensively,
      // so a duplicate row would be a silent orphan. Greptile P1 review.
      const existingByUser = await ctx.db
        .query("customers")
        .withIndex("by_userId", (q) => q.eq("userId", args.userId))
        .first();
      if (existingByUser) {
        console.warn(
          `[billing/repair] Patching dodoCustomerId=${dodoCustomerId} into existing customers row for userId=${args.userId} (dodoSubscriptionId=${sub.dodoSubscriptionId}). Webhook gap — investigate subscriptionHelpers.ts:520-549.`,
        );
        await ctx.db.patch(existingByUser._id, {
          dodoCustomerId,
          // Only refresh email/normalizedEmail when payload supplied one;
          // never blank out a previously-populated value.
          ...(email ? { email, normalizedEmail } : {}),
          updatedAt: now,
        });
        return await ctx.db.get(existingByUser._id);
      }

      console.warn(
        `[billing/repair] Inserting customers row for userId=${args.userId} from subscription rawPayload (dodoSubscriptionId=${sub.dodoSubscriptionId}). Webhook gap — investigate subscriptionHelpers.ts:520-549.`,
      );
      const insertedId = await ctx.db.insert("customers", {
        userId: args.userId,
        dodoCustomerId,
        email,
        normalizedEmail,
        createdAt: now,
        updatedAt: now,
      });
      return await ctx.db.get(insertedId);
    }

    // No subscription payload carried a usable customer_id. Caller throws
    // NO_CUSTOMER and the client shows a "contact support" toast.
    return null;
  },
});

/**
 * Operator-run backfill: proactively heal users affected by the
 * `subscription.active → customers` webhook gap before they hit
 * "Manage Billing" themselves.
 *
 * Walks every subscription, groups by `userId`, and for each user with at
 * least one subscription but no `customers` row, invokes
 * `repairCustomerFromSubscriptionPayload`. Returns a structured summary so
 * the operator can verify how many users were repaired vs. how many
 * couldn't be (e.g. rawPayload also lacked `customer_id`, which means
 * support needs to manually re-link the user via Dodo's dashboard).
 *
 * Run:
 *   npx convex run payments/billing:backfillMissingCustomers
 *
 * Idempotent — re-running after a successful pass is a no-op because every
 * affected user now has a customers row.
 *
 * WORLDMONITOR-R5 surfaced this gap for one user; the backfill is the
 * "find everyone else" sweep.
 */
export const backfillMissingCustomers = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Walk all subscriptions, dedupe to one userId per pass. .collect() is
    // bounded by Convex's per-mutation read limit (~16k rows) which is
    // fine for the current subscription volume; if this ever overflows
    // we'd switch to paginate() — left as a follow-up because today's
    // user base is well under the limit.
    const allSubs = await ctx.db.query("subscriptions").collect();
    const userIds = new Set<string>();
    for (const sub of allSubs) userIds.add(sub.userId);

    const summary = {
      usersInspected: userIds.size,
      alreadyHadCustomer: 0,
      repaired: 0,
      couldNotRepair: 0,
      // userIds that need manual support touch — rawPayload didn't carry
      // a usable customer_id and we refuse to silently fabricate one.
      unresolved: [] as string[],
    };

    for (const userId of userIds) {
      const existing = await ctx.db
        .query("customers")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .first();
      if (existing?.dodoCustomerId) {
        summary.alreadyHadCustomer++;
        continue;
      }
      // Inline the repair logic rather than calling
      // `repairCustomerFromSubscriptionPayload` so we stay inside a single
      // mutation transaction (Convex doesn't allow mutations to invoke
      // other mutations via runMutation — that's an action-only API).
      const subs = await ctx.db
        .query("subscriptions")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(50);
      const priority = (status: string): number =>
        status === "active" ? 0 :
        status === "on_hold" ? 1 :
        status === "cancelled" ? 2 :
        3;
      subs.sort((a, b) => {
        const pa = priority(a.status);
        const pb = priority(b.status);
        if (pa !== pb) return pa - pb;
        return b.updatedAt - a.updatedAt;
      });

      let repairedThisUser = false;
      for (const sub of subs) {
        const payload = sub.rawPayload as
          | { customer?: { customer_id?: unknown; email?: unknown } }
          | null
          | undefined;
        const rawId = payload?.customer?.customer_id;
        const dodoCustomerId = typeof rawId === "string" && rawId.length > 0 ? rawId : null;
        if (!dodoCustomerId) continue;
        const rawEmail = payload?.customer?.email;
        const email = typeof rawEmail === "string" ? rawEmail : "";
        const normalizedEmail = email.trim().toLowerCase();
        const now = Date.now();
        const collision = await ctx.db
          .query("customers")
          .withIndex("by_dodoCustomerId", (q) => q.eq("dodoCustomerId", dodoCustomerId))
          .first();
        if (collision) {
          if (collision.userId !== userId) {
            // Cross-user collision — refuse to remap. Logged for triage.
            console.warn(
              `[billing/backfill] cross-user collision: dodoCustomerId=${dodoCustomerId} already maps to userId=${collision.userId}; skipping userId=${userId}.`,
            );
            break;
          }
          // by_dodoCustomerId match for the SAME user already covers
          // the by_userId case for the dominant path. Count as repaired.
          repairedThisUser = true;
          break;
        }
        // by_userId precedence: when `existing` row lacks `dodoCustomerId`
        // (valid schema state since the field is `v.optional`), PATCH that
        // row rather than inserting a second customers doc for the same
        // user. `getCustomerByUserId` uses `.first()` defensively, so a
        // duplicate would be a silent orphan. Greptile P1 review.
        if (existing) {
          console.warn(
            `[billing/backfill] Patching dodoCustomerId=${dodoCustomerId} into existing customers row for userId=${userId} (dodoSubscriptionId=${sub.dodoSubscriptionId}).`,
          );
          await ctx.db.patch(existing._id, {
            dodoCustomerId,
            ...(email ? { email, normalizedEmail } : {}),
            updatedAt: now,
          });
        } else {
          await ctx.db.insert("customers", {
            userId,
            dodoCustomerId,
            email,
            normalizedEmail,
            createdAt: now,
            updatedAt: now,
          });
          console.warn(
            `[billing/backfill] Inserted customers row for userId=${userId} from subscription dodoSubscriptionId=${sub.dodoSubscriptionId}.`,
          );
        }
        repairedThisUser = true;
        break;
      }

      if (repairedThisUser) {
        summary.repaired++;
      } else {
        summary.couldNotRepair++;
        summary.unresolved.push(userId);
      }
    }

    return summary;
  },
});

/**
 * Internal query to retrieve the active subscription for a user.
 * Returns null if no subscription or if the subscription is cancelled/expired.
 */
export const getActiveSubscription = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    // Find an active subscription (not cancelled, expired, or on_hold).
    // on_hold subs have failed payment — don't allow plan changes on them.
    const allSubs = await ctx.db
      .query("subscriptions")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .take(50);

    const activeSub = allSubs.find((s) => s.status === "active");
    return activeSub ?? null;
  },
});

/**
 * Billing family for the duplicate-checkout guards. api_starter and
 * api_business are DISTINCT pricing-page tiers but the SAME product line:
 * an active Starter customer clicking "API Business" on /pro must hit the
 * duplicate-subscription dialog and be routed to the billing portal (where
 * the #4634 Dodo collection upgrade lives) — NOT be sold a second
 * concurrent API subscription ($99.99 + $249.99 double-billing; PR #4946
 * review). Pro ↔ API cross-line purchases remain deliberately allowed —
 * they are complementary products.
 */
export function checkoutBillingFamily(tierGroup: string): string {
  return tierGroup.startsWith("api_") ? "api" : tierGroup;
}

/**
 * Internal query used by checkout creation to prevent duplicate subscriptions.
 *
 * Blocks new checkout sessions when the user already has an active/on_hold
 * subscription in the same billing family (see checkoutBillingFamily —
 * api_starter and api_business count as one family), or a cancelled
 * subscription that still has time remaining in the current billing period.
 * This is an app-side guard only; Dodo's "Allow Multiple Subscriptions"
 * setting is still the provider-side backstop for races before webhook
 * ingestion updates Convex.
 */
export const getCheckoutBlockingSubscription = internalQuery({
  args: {
    userId: v.string(),
    productId: v.string(),
  },
  handler: async (ctx, args) => {
    const targetPlanKey = resolveProductToPlan(args.productId);
    if (!targetPlanKey) return null;

    const targetCatalogEntry = PRODUCT_CATALOG[targetPlanKey];
    if (!targetCatalogEntry) return null;

    const now = Date.now();
    const blockingSubs = (await ctx.db
      .query("subscriptions")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect())
      .filter((sub) => {
        const existingCatalogEntry = PRODUCT_CATALOG[sub.planKey];
        if (!existingCatalogEntry) return false;
        if (
          checkoutBillingFamily(existingCatalogEntry.tierGroup) !==
          checkoutBillingFamily(targetCatalogEntry.tierGroup)
        ) return false;
        if (sub.status === "active" || sub.status === "on_hold") return true;
        return sub.status === "cancelled" && sub.currentPeriodEnd > now;
      })
      .sort((a, b) => {
        const pa = getSubscriptionStatusPriority(a.status);
        const pb = getSubscriptionStatusPriority(b.status);
        if (pa !== pb) return pa - pb;
        if (a.currentPeriodEnd !== b.currentPeriodEnd) {
          return b.currentPeriodEnd - a.currentPeriodEnd;
        }
        return b.updatedAt - a.updatedAt;
      });

    const blocking = blockingSubs[0];
    if (!blocking) return null;

    return {
      planKey: blocking.planKey,
      displayName: PRODUCT_CATALOG[blocking.planKey]?.displayName ?? blocking.planKey,
      status: blocking.status,
      currentPeriodEnd: blocking.currentPeriodEnd,
      dodoSubscriptionId: blocking.dodoSubscriptionId,
    };
  },
});

/**
 * How recent a pending payment must be to block a new checkout (#4438).
 *
 * A pending 3DS/SCA payment older than this window no longer blocks — an
 * abandoned attempt should not lock the user out of retrying for hours. The
 * override dialog makes an over-long window tolerable (always escapable), so
 * err slightly long if tuning. Single source of truth: change it here only.
 */
export const PENDING_PAYMENT_BLOCK_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours
export const STUCK_PAYMENT_RECONCILIATION_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
export const STUCK_PAYMENT_RECONCILIATION_BATCH_SIZE = 25;
// A stale pending payment older than this no longer gets a "continue checkout"
// email — the Dodo hosted-checkout link expires, so a confident email with a
// dead link is worse than none. Older candidates route to the ops path instead.
export const STUCK_PAYMENT_CUSTOMER_EMAIL_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_STUCK_PAYMENT_RECONCILIATION_BATCH_SIZE = 100;
const MAX_STUCK_PAYMENT_RECONCILIATION_SCAN_ROWS = 500;
const RESEND_EMAILS_URL = "https://api.resend.com/emails";
const STUCK_PAYMENT_EMAIL_FROM = "World Monitor <noreply@worldmonitor.app>";
const STUCK_PAYMENT_SUPPORT_EMAIL = "support@worldmonitor.app";
// Bound the Resend POST so a hung socket can't stall the batch (a known repo
// failure class — a network read with no timeout drains the event loop).
const STUCK_PAYMENT_RESEND_TIMEOUT_MS = 10 * 1000;
// Same bound for the Dodo poll — the highest-cardinality call (one per
// candidate, up to the batch size sequentially). The SDK default is 60s x 2
// retries (~180s), so one degraded response could otherwise burn the whole
// action during exactly the Dodo outage this cron exists to survive.
const STUCK_PAYMENT_DODO_RETRIEVE_TIMEOUT_MS = 10 * 1000;
// Sentinel recorded on the marker when Dodo returns no status at all — keeps
// the `observedStatus` field a non-empty string (v.string()) while preserving
// "we polled but Dodo told us nothing" for triage.
const UNKNOWN_DODO_PAYMENT_STATUS = "unknown";

function isPendingPaymentStatus(status: string): boolean {
  return status === "processing" || status === "requires_customer_action";
}

function isTerminalPaymentStatus(status: string): status is "succeeded" | "failed" | "cancelled" {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function boundedPositiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function boundedPositiveMs(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(1, Math.floor(value));
}

type DodoPaymentLookup = {
  status?: unknown;
  payment_id?: unknown;
  subscription_id?: unknown;
  total_amount?: unknown;
  amount?: unknown;
  currency?: unknown;
  payment_link?: unknown;
  customer?: {
    email?: unknown;
    name?: unknown;
  } | null;
};

type StuckPaymentCandidate = {
  userId: string;
  dodoPaymentId: string;
  dodoSubscriptionId?: string;
  planKey?: string;
  amount: number;
  currency: string;
  pendingStatus: "processing" | "requires_customer_action";
  pendingOccurredAt: number;
};

type ReconcileStuckPendingPaymentsSummary = {
  candidates: number;
  terminalReconciled: number;
  customerNotified: number;
  opsNotified: number;
  alreadySkipped: number;
  unknownStatus: number;
  pollFailed: number;
  emailFailed: number;
  recordFailed: number;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function extractDodoPaymentStatus(payment: unknown): string | null {
  if (!payment || typeof payment !== "object") return null;
  const rawStatus = (payment as DodoPaymentLookup).status;
  return typeof rawStatus === "string" && rawStatus.length > 0 ? rawStatus : null;
}

async function retrieveDodoPayment(dodoPaymentId: string): Promise<unknown> {
  const client = getDodoClient();
  return await client.payments.retrieve(dodoPaymentId, {
    timeout: STUCK_PAYMENT_DODO_RETRIEVE_TIMEOUT_MS,
    maxRetries: 1,
  });
}

async function sendStuckPaymentEmail(
  payment: DodoPaymentLookup,
  planKey: string | undefined,
): Promise<"customer_notified" | "ops_notified"> {
  const email = readString(payment.customer?.email);
  const checkoutUrl = readString(payment.payment_link);
  const apiKey = process.env.RESEND_API_KEY;

  if (!email || !checkoutUrl) return "ops_notified";
  if (!apiKey) {
    console.warn("[billing/reconciliation] RESEND_API_KEY not set; skipping stuck-payment customer email.");
    return "ops_notified";
  }

  const planName = planKey ? PRODUCT_CATALOG[planKey]?.displayName ?? "World Monitor" : "World Monitor";
  const safePlanName = escapeHtml(planName);
  const safeCheckoutUrl = escapeHtml(checkoutUrl);
  const safeSupportEmail = escapeHtml(STUCK_PAYMENT_SUPPORT_EMAIL);
  const html = `
    <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111; line-height: 1.5;">
      <h1 style="font-size: 20px;">Your World Monitor checkout still needs action</h1>
      <p>Your ${safePlanName} payment is still waiting for bank or card verification.</p>
      <p>You can safely continue checkout here:</p>
      <p><a href="${safeCheckoutUrl}" style="display: inline-block; background: #111; color: #fff; padding: 10px 14px; text-decoration: none;">Continue checkout</a></p>
      <p>If you already completed payment, you can ignore this email or contact <a href="mailto:${safeSupportEmail}">${safeSupportEmail}</a>.</p>
    </div>`;

  const res = await fetch(RESEND_EMAILS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: STUCK_PAYMENT_EMAIL_FROM,
      to: [email],
      subject: "Complete your World Monitor checkout",
      html,
      reply_to: STUCK_PAYMENT_SUPPORT_EMAIL,
    }),
    signal: AbortSignal.timeout(STUCK_PAYMENT_RESEND_TIMEOUT_MS),
  });

  if (!res.ok) {
    // Log the status only — the response body can echo the recipient email.
    console.warn(`[billing/reconciliation] Resend stuck-payment email failed with HTTP ${res.status}.`);
    return "ops_notified";
  }

  return "customer_notified";
}

/**
 * Internal query used by checkout creation to prevent DUPLICATE PENDING
 * PAYMENTS (#4438) — the gap the subscription guard above cannot see.
 *
 * A pending 3DS/SCA payment (`paymentEvents.status` ∈ {processing,
 * requires_customer_action}) never created a subscription row, so
 * `getCheckoutBlockingSubscription` returns null and the customer can stack
 * duplicate payments by retrying. This guard blocks a new checkout when the
 * user has a recent pending payment in the SAME tier group as the product
 * being purchased — identical tier-group scoping to the subscription guard
 * (a pending Pro payment must NOT block an API checkout).
 *
 * Fails open: a pending row whose tier group is unresolvable (no `planKey`, or
 * a planKey absent from the catalog) never blocks. A false block (locking a
 * paying user out) is worse than a missed dedup (mitigated by the dialog on the
 * next attempt and the eventual reconciliation cron).
 */
export const getBlockingPendingPayment = internalQuery({
  args: {
    userId: v.string(),
    productId: v.string(),
  },
  handler: async (ctx, args) => {
    const targetPlanKey = resolveProductToPlan(args.productId);
    if (!targetPlanKey) return null;

    const targetCatalogEntry = PRODUCT_CATALOG[targetPlanKey];
    if (!targetCatalogEntry) return null;

    const windowStart = Date.now() - PENDING_PAYMENT_BLOCK_WINDOW_MS;

    // Time-bounded read: only rows within the staleness window. `paymentEvents`
    // is append-only and carries full `rawPayload`, so collecting a user's whole
    // history would grow unbounded and could throw (rejecting the checkout =
    // fail-CLOSED). A terminal row always post-dates its own pending row, so any
    // resolution of a recent pending payment is also within the window — this
    // slice is sufficient to detect it.
    const recent = await ctx.db
      .query("paymentEvents")
      .withIndex("by_userId_occurredAt", (q) =>
        q.eq("userId", args.userId).gt("occurredAt", windowStart),
      )
      .collect();

    // `paymentEvents` never patches/reconciles — a 3DS payment that went
    // processing -> succeeded/failed leaves BOTH rows. A payment is only still
    // "in progress" if its dodoPaymentId has NO terminal (non-pending) charge
    // row. Without this, a failed/succeeded payment's lingering
    // `requires_customer_action` row would falsely block the retry path for the
    // whole window — degrading the exact flow this guard is meant to smooth.
    const isPending = (status: string) =>
      status === "processing" || status === "requires_customer_action";
    const resolvedPaymentIds = new Set<string>();
    for (const ev of recent) {
      if (ev.type === "charge" && !isPending(ev.status)) {
        resolvedPaymentIds.add(ev.dodoPaymentId);
      }
    }

    const blocking = recent
      .filter((ev) => {
        if (ev.type !== "charge") return false;
        if (!isPending(ev.status)) return false;
        if (resolvedPaymentIds.has(ev.dodoPaymentId)) return false;
        // Fail open when the tier group is unresolvable.
        if (!ev.planKey) return false;
        const entry = PRODUCT_CATALOG[ev.planKey];
        if (!entry) return false;
        // Same family scoping as the subscription guard: a pending Starter
        // payment blocks a Business checkout (and vice versa), while a
        // pending Pro payment never blocks an API purchase.
        return (
          checkoutBillingFamily(entry.tierGroup) ===
          checkoutBillingFamily(targetCatalogEntry.tierGroup)
        );
      })
      .sort((a, b) => b.occurredAt - a.occurredAt)[0];

    if (!blocking || !blocking.planKey) return null;

    return {
      planKey: blocking.planKey,
      displayName: PRODUCT_CATALOG[blocking.planKey]?.displayName ?? blocking.planKey,
      occurredAt: blocking.occurredAt,
    };
  },
});

export const listStuckPendingPaymentCandidates = internalQuery({
  args: {
    thresholdMs: v.optional(v.number()),
    lookbackMs: v.optional(v.number()),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const thresholdMs = boundedPositiveMs(args.thresholdMs, STUCK_PAYMENT_RECONCILIATION_THRESHOLD_MS);
    const lookbackMs = boundedPositiveMs(args.lookbackMs, STUCK_PAYMENT_RECONCILIATION_LOOKBACK_MS);
    const batchSize = boundedPositiveInteger(
      args.batchSize,
      STUCK_PAYMENT_RECONCILIATION_BATCH_SIZE,
      MAX_STUCK_PAYMENT_RECONCILIATION_BATCH_SIZE,
    );

    const now = Date.now();
    const staleBefore = now - thresholdMs;
    const lookbackStart = now - lookbackMs;
    // Scan NEWEST-first: past the scan cap, the freshly-stuck rows (the ones a
    // customer might still act on) stay visible, while the oldest ops-only rows
    // are the ones deferred to a later run. Ascending order did the opposite —
    // fresh stuck payments could silently fall off the end of the window.
    const paymentEvents = await ctx.db
      .query("paymentEvents")
      .withIndex("by_occurredAt", (q) =>
        q.gt("occurredAt", lookbackStart).lt("occurredAt", staleBefore),
      )
      .order("desc")
      .take(MAX_STUCK_PAYMENT_RECONCILIATION_SCAN_ROWS);

    if (paymentEvents.length >= MAX_STUCK_PAYMENT_RECONCILIATION_SCAN_ROWS) {
      // Cap hit: only the newest 500 rows in the window were scanned. Because
      // every run rescans newest-first, rows older than that frontier are NOT
      // merely deferred to the next run — they stay invisible until the newer
      // backlog clears. Surface it so ops widen the cap / shorten the cadence
      // (a cursor/watermark would be the durable fix if this recurs).
      console.error(
        `[billing/reconciliation] scan cap hit: ${MAX_STUCK_PAYMENT_RECONCILIATION_SCAN_ROWS} rows in the ` +
        `${Math.round(lookbackMs / (24 * 60 * 60 * 1000))}d window; rows older than the newest ` +
        `${MAX_STUCK_PAYMENT_RECONCILIATION_SCAN_ROWS} stay unscanned until the backlog clears.`,
      );
    }

    const candidates: StuckPaymentCandidate[] = [];
    const seenPaymentIds = new Set<string>();
    for (const ev of paymentEvents) {
      if (candidates.length >= batchSize) break;
      if (ev.type !== "charge") continue;
      if (!isPendingPaymentStatus(ev.status)) continue;
      if (seenPaymentIds.has(ev.dodoPaymentId)) continue;
      seenPaymentIds.add(ev.dodoPaymentId);

      const marker = await ctx.db
        .query("paymentReconciliationAttempts")
        .withIndex("by_dodoPaymentId", (q) => q.eq("dodoPaymentId", ev.dodoPaymentId))
        .first();
      if (marker) continue;

      const history = await ctx.db
        .query("paymentEvents")
        .withIndex("by_dodoPaymentId", (q) => q.eq("dodoPaymentId", ev.dodoPaymentId))
        .collect();
      if (history.some((row) => row.type === "charge" && isTerminalPaymentStatus(row.status))) {
        continue;
      }

      candidates.push({
        userId: ev.userId,
        dodoPaymentId: ev.dodoPaymentId,
        dodoSubscriptionId: ev.dodoSubscriptionId,
        planKey: ev.planKey,
        amount: ev.amount,
        currency: ev.currency,
        pendingStatus: ev.status as "processing" | "requires_customer_action",
        pendingOccurredAt: ev.occurredAt,
      });
    }

    return candidates;
  },
});

/**
 * Claims a reconciliation marker for one stuck pending payment, recording the
 * status Dodo reported when we polled it.
 *
 * This is the idempotency barrier for the whole flow: the action writes the
 * marker HERE, before sending any customer email, so a transient failure after
 * this point can never re-email the customer on the next daily run (the
 * candidate query skips any payment that already has a marker).
 *
 * Outcomes:
 *   - `already_marked` / `already_terminal` — a prior run or a webhook won;
 *     nothing written.
 *   - `terminal_reconciled` — Dodo now reports a terminal status (a dropped
 *     webhook); backfill the missing paymentEvents row + a terminal marker.
 *   - `pending_claimed` — any non-terminal status (recognised 3DS-pending,
 *     an unrecognised IntentStatus like `requires_payment_method`, or the
 *     `unknown` sentinel when Dodo returned no status). Writes a PROVISIONAL
 *     `ops_notified` marker; the action later calls
 *     `finalizeStuckPaymentReconciliation` to upgrade it to `customer_notified`
 *     on a successful email, or to page ops. Mirrors
 *     `derivePaymentEventStatus`'s collapse of non-terminal IntentStatus — a
 *     stuck payment is NEVER dropped without a marker (its absence is what
 *     causes daily re-polling for 14 days + batch-slot starvation).
 */
export const claimStuckPaymentReconciliation = internalMutation({
  args: {
    userId: v.string(),
    dodoPaymentId: v.string(),
    dodoSubscriptionId: v.optional(v.string()),
    planKey: v.optional(v.string()),
    amount: v.number(),
    currency: v.string(),
    pendingOccurredAt: v.number(),
    observedStatus: v.string(),
    rawPayload: v.any(),
  },
  handler: async (ctx, args) => {
    const existingMarker = await ctx.db
      .query("paymentReconciliationAttempts")
      .withIndex("by_dodoPaymentId", (q) => q.eq("dodoPaymentId", args.dodoPaymentId))
      .first();
    if (existingMarker) return { action: "already_marked" as const };

    const history = await ctx.db
      .query("paymentEvents")
      .withIndex("by_dodoPaymentId", (q) => q.eq("dodoPaymentId", args.dodoPaymentId))
      .collect();
    if (history.some((row) => row.type === "charge" && isTerminalPaymentStatus(row.status))) {
      return { action: "already_terminal" as const };
    }

    const now = Date.now();
    if (isTerminalPaymentStatus(args.observedStatus)) {
      await ctx.db.insert("paymentEvents", {
        userId: args.userId,
        dodoPaymentId: args.dodoPaymentId,
        type: "charge",
        amount: args.amount,
        currency: args.currency,
        status: args.observedStatus,
        dodoSubscriptionId: args.dodoSubscriptionId,
        planKey: args.planKey,
        rawPayload: args.rawPayload,
        occurredAt: now,
      });
      await ctx.db.insert("paymentReconciliationAttempts", {
        dodoPaymentId: args.dodoPaymentId,
        userId: args.userId,
        planKey: args.planKey,
        action: "terminal_reconciled",
        observedStatus: args.observedStatus,
        pendingOccurredAt: args.pendingOccurredAt,
        reconciledAt: now,
      });

      // Dropped-webhook guard: a payment webhook that never arrived may have
      // travelled with a dropped `subscription.active` webhook — the customer
      // is charged but never entitled, and no other reconciler catches a
      // never-activated sub (#4794's renewal reconciler only scans active
      // rows). Silently closing the case here would bury it. Page ops when a
      // succeeded charge has a subscription id but no subscription row at all.
      if (args.observedStatus === "succeeded" && args.dodoSubscriptionId) {
        const sub = await ctx.db
          .query("subscriptions")
          .withIndex("by_dodoSubscriptionId", (q) =>
            q.eq("dodoSubscriptionId", args.dodoSubscriptionId!),
          )
          .first();
        if (!sub) {
          console.error(
            `[billing/reconciliation] reconciled a SUCCEEDED payment with no subscription row: ` +
            `paymentId=${args.dodoPaymentId} userId=${args.userId} subscriptionId=${args.dodoSubscriptionId}. ` +
            `Charged customer may lack entitlement (dropped subscription.active webhook) — ops follow-up required.`,
          );
        }
      }
      return { action: "terminal_reconciled" as const };
    }

    // Non-terminal (recognised pending OR unrecognised / `unknown`): claim a
    // PROVISIONAL ops_notified marker. No console.error here — the true
    // outcome (customer emailed vs ops paged) isn't known until the action
    // finalizes, and paging ops for a customer we then successfully email
    // would be a false alarm.
    await ctx.db.insert("paymentReconciliationAttempts", {
      dodoPaymentId: args.dodoPaymentId,
      userId: args.userId,
      planKey: args.planKey,
      action: "ops_notified",
      observedStatus: args.observedStatus,
      pendingOccurredAt: args.pendingOccurredAt,
      reconciledAt: now,
    });
    return { action: "pending_claimed" as const };
  },
});

/**
 * Finalizes a claimed (provisional `ops_notified`) marker once the action
 * knows the email outcome.
 *
 * - `notified: true`  → the customer email was sent; upgrade the marker to
 *   `customer_notified`. No ops page.
 * - `notified: false` → ops follow-up (unrecognised status, stale checkout
 *   link, missing email/link, RESEND_API_KEY unset, or a Resend non-2xx). The
 *   marker stays `ops_notified` and we `console.error` — Convex auto-Sentry
 *   forwards console.error (the refund-alert precedent in
 *   subscriptionHelpers.ts), so ops is ACTUALLY paged instead of the
 *   never-surfaced console.warn this replaced.
 */
export const finalizeStuckPaymentReconciliation = internalMutation({
  args: {
    dodoPaymentId: v.string(),
    notified: v.boolean(),
  },
  handler: async (ctx, args) => {
    const marker = await ctx.db
      .query("paymentReconciliationAttempts")
      .withIndex("by_dodoPaymentId", (q) => q.eq("dodoPaymentId", args.dodoPaymentId))
      .first();
    if (!marker) {
      // The claim always inserts a marker, so a missing one means a concurrent
      // delete or a caller bug — surface it rather than silently no-op.
      console.warn(
        `[billing/reconciliation] finalize found no marker for paymentId=${args.dodoPaymentId}.`,
      );
      return { action: "marker_missing" as const };
    }
    // Idempotent: a re-run that already upgraded this marker must not downgrade.
    if (marker.action === "customer_notified") {
      return { action: "customer_notified" as const };
    }

    if (args.notified) {
      await ctx.db.patch(marker._id, { action: "customer_notified", reconciledAt: Date.now() });
      return { action: "customer_notified" as const };
    }

    console.error(
      `[billing/reconciliation] stale Dodo payment still pending after threshold: ` +
      `paymentId=${marker.dodoPaymentId} userId=${marker.userId} status=${marker.observedStatus} ` +
      `pendingOccurredAt=${marker.pendingOccurredAt}. Ops follow-up required.`,
    );
    return { action: "ops_notified" as const };
  },
});

export const reportPaymentReconciliationFailure = internalMutation({
  args: {
    phase: v.union(v.literal("poll"), v.literal("email"), v.literal("record")),
    dodoPaymentId: v.string(),
    errorMessage: v.string(),
  },
  handler: async (_ctx, args) => {
    throw new Error(
      `[billing/reconciliation] ${args.phase} phase failed paymentId=${args.dodoPaymentId}: ${args.errorMessage}`,
    );
  },
});

export const reconcileStuckPendingPayments = internalAction({
  args: {
    thresholdMs: v.optional(v.number()),
    lookbackMs: v.optional(v.number()),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ReconcileStuckPendingPaymentsSummary> => {
    const candidates = await ctx.runQuery(
      (internal as any).payments.billing.listStuckPendingPaymentCandidates,
      args,
    ) as StuckPaymentCandidate[];

    const summary: ReconcileStuckPendingPaymentsSummary = {
      candidates: candidates.length,
      terminalReconciled: 0,
      customerNotified: 0,
      opsNotified: 0,
      alreadySkipped: 0,
      unknownStatus: 0,
      pollFailed: 0,
      emailFailed: 0,
      recordFailed: 0,
    };

    // Best-effort Sentry hand-off, labelled by phase (poll vs email vs record)
    // so a mislabel can't hide the real failure. The scheduled mutation throws,
    // which Convex auto-Sentry captures; wrapping runAfter in its own try/catch
    // keeps a scheduler hiccup from aborting the day's batch (webhookHandlers.ts
    // precedent).
    const reportFailure = async (
      phase: "poll" | "email" | "record",
      dodoPaymentId: string,
      message: string,
    ): Promise<void> => {
      try {
        await ctx.scheduler.runAfter(
          0,
          (internal as any).payments.billing.reportPaymentReconciliationFailure,
          { phase, dodoPaymentId, errorMessage: message },
        );
      } catch (scheduleErr) {
        // sentry-coverage-ok: the scheduled report is a best-effort Sentry
        // hand-off; the durable state is the reconciliation marker. A scheduler
        // outage here must not abort the batch.
        console.warn(
          `[billing/reconciliation] failed to schedule ${phase} failure report for ${dodoPaymentId}: ` +
          `${scheduleErr instanceof Error ? scheduleErr.message : String(scheduleErr)}`,
        );
      }
    };

    // Finalize a claimed marker as ops (notified: false). Swallows its own
    // failure to a phase="record" Sentry report — the provisional ops_notified
    // marker from the claim already stands, so the outcome is durable.
    const finalizeOps = async (dodoPaymentId: string): Promise<void> => {
      try {
        await ctx.runMutation(
          (internal as any).payments.billing.finalizeStuckPaymentReconciliation,
          { dodoPaymentId, notified: false },
        );
      } catch (err) {
        // sentry-coverage-ok: reportFailure schedules a throwing mutation.
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[billing/reconciliation] finalize (ops) failed for ${dodoPaymentId}: ${message}`);
        await reportFailure("record", dodoPaymentId, message);
      }
    };

    const now = Date.now();

    for (const candidate of candidates) {
      // Phase — poll Dodo for the current payment status.
      let payment: unknown;
      try {
        payment = await retrieveDodoPayment(candidate.dodoPaymentId);
      } catch (err) {
        // sentry-coverage-ok: reportFailure schedules a throwing mutation.
        summary.pollFailed++;
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[billing/reconciliation] poll failed for ${candidate.dodoPaymentId}: ${message}`);
        await reportFailure("poll", candidate.dodoPaymentId, message);
        continue;
      }

      const observedStatus = extractDodoPaymentStatus(payment); // string | null
      const dodoPayment = payment as DodoPaymentLookup;
      const recordedStatus = observedStatus ?? UNKNOWN_DODO_PAYMENT_STATUS;

      // Phase — CLAIM the marker BEFORE any email (idempotency barrier).
      let claim: { action: string };
      try {
        claim = await ctx.runMutation(
          (internal as any).payments.billing.claimStuckPaymentReconciliation,
          {
            userId: candidate.userId,
            dodoPaymentId: candidate.dodoPaymentId,
            dodoSubscriptionId: readString(dodoPayment.subscription_id) ?? candidate.dodoSubscriptionId,
            planKey: candidate.planKey,
            amount: readNumber(dodoPayment.total_amount) ?? readNumber(dodoPayment.amount) ?? candidate.amount,
            currency: readString(dodoPayment.currency) ?? candidate.currency,
            pendingOccurredAt: candidate.pendingOccurredAt,
            observedStatus: recordedStatus,
            rawPayload: payment,
          },
        );
      } catch (err) {
        // sentry-coverage-ok: reportFailure schedules a throwing mutation.
        summary.recordFailed++;
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[billing/reconciliation] claim failed for ${candidate.dodoPaymentId}: ${message}`);
        await reportFailure("record", candidate.dodoPaymentId, message);
        continue;
      }

      if (claim.action === "terminal_reconciled") {
        summary.terminalReconciled++;
        continue;
      }
      if (claim.action !== "pending_claimed") {
        // already_marked / already_terminal — a prior run or a webhook won.
        summary.alreadySkipped++;
        continue;
      }

      // Marker is claimed as provisional ops_notified. Decide whether to email.
      const recognizedPending = observedStatus != null && isPendingPaymentStatus(observedStatus);
      const linkFresh = now - candidate.pendingOccurredAt < STUCK_PAYMENT_CUSTOMER_EMAIL_MAX_AGE_MS;

      if (!recognizedPending) {
        // Unrecognised IntentStatus (incl. null / requires_payment_method — the
        // typical abandoned-3DS end-state). Ops path, marker already written.
        summary.unknownStatus++;
        await finalizeOps(candidate.dodoPaymentId);
        continue;
      }

      if (!linkFresh) {
        // Stale checkout link (Dodo links expire): a confident email with a
        // dead link is worse than none. Ops path instead.
        summary.opsNotified++;
        await finalizeOps(candidate.dodoPaymentId);
        continue;
      }

      // Phase — send the customer "continue checkout" email.
      let emailResult: "customer_notified" | "ops_notified";
      try {
        emailResult = await sendStuckPaymentEmail(dodoPayment, candidate.planKey);
      } catch (err) {
        // sentry-coverage-ok: reportFailure schedules a throwing mutation. The
        // claimed ops_notified marker stands, so the next run won't re-email.
        summary.emailFailed++;
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[billing/reconciliation] email failed for ${candidate.dodoPaymentId}: ${message}`);
        await reportFailure("email", candidate.dodoPaymentId, message);
        continue;
      }

      // Phase — finalize the marker to reflect the email outcome.
      if (emailResult === "customer_notified") {
        try {
          await ctx.runMutation(
            (internal as any).payments.billing.finalizeStuckPaymentReconciliation,
            { dodoPaymentId: candidate.dodoPaymentId, notified: true },
          );
          summary.customerNotified++;
        } catch (err) {
          // sentry-coverage-ok: reportFailure schedules a throwing mutation. The
          // marker stays ops_notified (safe default) — the ops path owns it.
          summary.opsNotified++;
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[billing/reconciliation] finalize failed for ${candidate.dodoPaymentId}: ${message}`);
          await reportFailure("record", candidate.dodoPaymentId, message);
        }
      } else {
        // sendStuckPaymentEmail returned ops_notified (missing email/link,
        // RESEND_API_KEY unset, or Resend non-2xx).
        summary.opsNotified++;
        await finalizeOps(candidate.dodoPaymentId);
      }
    }

    if (summary.candidates > 0 || summary.pollFailed > 0) {
      console.warn(`[billing/reconciliation] summary ${JSON.stringify(summary)}`);
    }
    return summary;
  },
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Creates a Dodo Customer Portal session and returns the portal URL.
 *
 * Public action callable from the browser. Auth-gated via requireUserId(ctx).
 */
export const getCustomerPortalUrl = action({
  args: {},
  handler: async (ctx, _args) => {
    const userId = await requireUserId(ctx);
    return createCustomerPortalUrlForUser(ctx, userId);
  },
});

/**
 * Internal action callable from the edge gateway to create a user-scoped
 * Dodo Customer Portal session after the Clerk JWT has been verified there.
 */
export const internalGetCustomerPortalUrl = internalAction({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    if (!args.userId) {
      throw new ConvexError({ kind: "USER_ID_REQUIRED" });
    }
    return createCustomerPortalUrlForUser(ctx, args.userId);
  },
});

// ---------------------------------------------------------------------------
// Subscription claim (anon ID → authenticated user migration)
// ---------------------------------------------------------------------------

/**
 * Claims subscription, entitlement, and customer records from an anonymous
 * browser ID to the currently authenticated user.
 *
 * LIMITATION: Until Clerk auth is wired into the ConvexClient, anonymous
 * purchases are keyed to a `crypto.randomUUID()` stored in localStorage
 * (`wm-anon-id`). If the user clears storage, switches browsers, or later
 * creates a real account, there is no automatic way to link the purchase.
 *
 * This mutation provides the migration path: once authenticated, the client
 * calls claimSubscription(anonId, claimToken) to reassign all payment records
 * from the anonymous ID to the real user ID. The claim token is minted
 * server-side during checkout creation; a leaked bare UUID is not sufficient
 * ownership proof.
 *
 * @see https://github.com/koala73/worldmonitor/issues/2078
 */
export const claimSubscription = mutation({
  args: { anonId: v.string(), claimToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const realUserId = await requireUserId(ctx);

    // Validate anonId is a UUID v4 (format produced by crypto.randomUUID() in user-identity.ts).
    // Rejects injected Clerk IDs ("user_xxx") which are structurally distinct from UUID v4,
    // preventing cross-user subscription theft via localStorage injection.
    if (!ANON_ID_V4_REGEX.test(args.anonId) || args.anonId === realUserId) {
      return { claimed: { subscriptions: 0, entitlements: 0, customers: 0, payments: 0 } };
    }

    if (args.claimToken !== undefined && !(await verifyAnonClaimToken(args.anonId, args.claimToken))) {
      throw new ConvexError({ kind: "ANON_CLAIM_PROOF_REQUIRED" });
    }

    // Parallel reads for all anonId data — bounded to prevent runaway memory
    const [subs, anonEntitlement, customers, payments] = await Promise.all([
      ctx.db.query("subscriptions").withIndex("by_userId", (q) => q.eq("userId", args.anonId)).take(50),
      ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", args.anonId)).first(),
      ctx.db.query("customers").withIndex("by_userId", (q) => q.eq("userId", args.anonId)).take(10),
      ctx.db.query("paymentEvents").withIndex("by_userId", (q) => q.eq("userId", args.anonId)).take(1000),
    ]);

    const hasClaimableRows =
      subs.length > 0 ||
      anonEntitlement !== null ||
      customers.length > 0 ||
      payments.length > 0;
    if (!hasClaimableRows) {
      return { claimed: { subscriptions: 0, entitlements: 0, customers: 0, payments: 0 } };
    }

    if (args.claimToken === undefined) {
      throw new ConvexError({ kind: "ANON_CLAIM_PROOF_REQUIRED" });
    }

    // Reassign subscriptions
    for (const sub of subs) {
      await ctx.db.patch(sub._id, { userId: realUserId });
    }

    // Move entitlement rows first, then let the shared recompute path derive
    // the final paid/free state from the post-claim subscriptions. If the
    // anonymous row carried a future complimentary floor, transfer it only
    // when it does not undercut stronger current real-user coverage.
    const recomputeTimestamp = Date.now();
    if (anonEntitlement) {
      const existingEntitlement = await ctx.db
        .query("entitlements")
        .withIndex("by_userId", (q) => q.eq("userId", realUserId))
        .first();
      if (existingEntitlement) {
        const anonCompUntil = anonEntitlement.compUntil ?? 0;
        const existingCompUntil = existingEntitlement.compUntil ?? 0;
        if (anonCompUntil > existingCompUntil && anonCompUntil > recomputeTimestamp) {
          const realSubscriptions = await ctx.db
            .query("subscriptions")
            .withIndex("by_userId", (q) => q.eq("userId", realUserId))
            .collect();
          let bestCoveringSubscription: (typeof realSubscriptions)[number] | null = null;
          for (const candidate of realSubscriptions) {
            const covers =
              candidate.status === "active" ||
              candidate.status === "on_hold" ||
              (candidate.status === "cancelled" && candidate.currentPeriodEnd > recomputeTimestamp);
            if (!covers) continue;
            if (
              bestCoveringSubscription === null ||
              compareEntitlementPlans(
                { planKey: candidate.planKey, validUntil: candidate.currentPeriodEnd },
                {
                  planKey: bestCoveringSubscription.planKey,
                  validUntil: bestCoveringSubscription.currentPeriodEnd,
                },
              ) > 0
            ) {
              bestCoveringSubscription = candidate;
            }
          }
          const strongestCurrentCoverage = bestCoveringSubscription
            ? {
                planKey: bestCoveringSubscription.planKey,
                validUntil: bestCoveringSubscription.currentPeriodEnd,
              }
            : existingEntitlement.validUntil > recomputeTimestamp
              ? { planKey: existingEntitlement.planKey, validUntil: existingEntitlement.validUntil }
              : null;
          const anonCompOutranksCurrentCoverage =
            strongestCurrentCoverage === null ||
            compareEntitlementPlans(
              { planKey: anonEntitlement.planKey, validUntil: anonEntitlement.validUntil },
              strongestCurrentCoverage,
            ) >= 0;
          if (anonCompOutranksCurrentCoverage) {
            await ctx.db.patch(existingEntitlement._id, {
              planKey: anonEntitlement.planKey,
              features: anonEntitlement.features,
              validUntil: Math.max(existingEntitlement.validUntil, anonEntitlement.validUntil),
              compUntil: anonCompUntil,
              updatedAt: recomputeTimestamp,
            });
          }
        }
        await ctx.db.delete(anonEntitlement._id);
      } else {
        await ctx.db.patch(anonEntitlement._id, {
          userId: realUserId,
          updatedAt: recomputeTimestamp,
        });
      }
    }

    // Reassign customer records
    for (const customer of customers) {
      await ctx.db.patch(customer._id, { userId: realUserId });
    }

    // Reassign payment events — bounded to prevent runaway memory on pathological sessions
    // (already fetched above in the parallel Promise.all)
    for (const payment of payments) {
      await ctx.db.patch(payment._id, { userId: realUserId });
    }

    await recomputeEntitlementFromAllSubs(ctx, realUserId, recomputeTimestamp);
    const recomputedEntitlement = await ctx.db
      .query("entitlements")
      .withIndex("by_userId", (q) => q.eq("userId", realUserId))
      .first();

    // ACCEPTED BOUND: cache sync runs after mutation commits. Stale cache
    // survives up to ENTITLEMENT_CACHE_TTL_SECONDS (900s) if scheduler fails.
    // Clear stale anon cache and sync the final recomputed real-user state.
    if (process.env.UPSTASH_REDIS_REST_URL) {
      await ctx.scheduler.runAfter(
        0,
        internal.payments.cacheActions.deleteEntitlementCache,
        { userId: args.anonId },
      );
      if (recomputedEntitlement) {
        await ctx.scheduler.runAfter(
          0,
          internal.payments.cacheActions.syncEntitlementCache,
          {
            userId: realUserId,
            planKey: recomputedEntitlement.planKey,
            features: recomputedEntitlement.features,
            validUntil: recomputedEntitlement.validUntil,
          },
        );
      }
    }

    return {
      claimed: {
        subscriptions: subs.length,
        entitlements: anonEntitlement ? 1 : 0,
        customers: customers.length,
        payments: payments.length,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Complimentary entitlements (support/goodwill tooling)
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Grants a complimentary entitlement to a user.
 *
 * Extends both validUntil and compUntil to max(existing, now + days). Never
 * shrinks — calling twice with small durations won't accidentally shorten an
 * existing longer comp. compUntil is an independent floor that
 * handleSubscriptionExpired honours, so Dodo cancellations/expirations don't
 * wipe the comp before it runs out.
 *
 * Typical usage (CLI):
 *   npx convex run 'payments/billing:grantComplimentaryEntitlement' \
 *     '{"userId":"user_XXX","planKey":"pro_monthly","days":90}'
 */
export const grantComplimentaryEntitlement = internalMutation({
  args: {
    userId: v.string(),
    planKey: v.string(),
    days: v.number(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.days <= 0 || !Number.isFinite(args.days)) {
      throw new Error(`grantComplimentaryEntitlement: days must be a positive finite number, got ${args.days}`);
    }
    if (!PRODUCT_CATALOG[args.planKey]) {
      throw new Error(
        `grantComplimentaryEntitlement: unknown planKey "${args.planKey}". Must be in PRODUCT_CATALOG.`,
      );
    }
    const now = Date.now();
    const until = now + args.days * DAY_MS;
    const existing = await ctx.db
      .query("entitlements")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();
    const features = getFeaturesForPlan(args.planKey);
    const validUntil = Math.max(existing?.validUntil ?? 0, until);
    const compUntil = Math.max(existing?.compUntil ?? 0, until);

    if (existing) {
      await ctx.db.patch(existing._id, {
        planKey: args.planKey,
        features,
        validUntil,
        compUntil,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("entitlements", {
        userId: args.userId,
        planKey: args.planKey,
        features,
        validUntil,
        compUntil,
        updatedAt: now,
      });
    }

    console.log(
      `[billing] grantComplimentaryEntitlement userId=${args.userId} planKey=${args.planKey} days=${args.days} validUntil=${new Date(validUntil).toISOString()}${args.reason ? ` reason="${args.reason}"` : ""}`,
    );

    // Sync Redis cache so edge gateway sees the comp without waiting for TTL.
    if (process.env.UPSTASH_REDIS_REST_URL) {
      await ctx.scheduler.runAfter(
        0,
        internal.payments.cacheActions.syncEntitlementCache,
        { userId: args.userId, planKey: args.planKey, features, validUntil },
      );
    }

    return {
      userId: args.userId,
      planKey: args.planKey,
      validUntil,
      compUntil,
    };
  },
});

/**
 * Deletes a subscription row from Convex by Dodo subscription_id.
 *
 * Ops tool. Use when a Dodo subscription was cancelled/refunded admin-side
 * but you don't want its eventual `subscription.expired` webhook to clobber
 * the user's entitlement (e.g. user upgraded by buying a separate higher-tier
 * sub on the same userId — see the multi-active-sub guard in
 * subscriptionHelpers.ts; this mutation is the explicit-cleanup counterpart
 * for cases where you want zero-risk by removing the row entirely).
 *
 * Recomputes the entitlement from the user's remaining active subs after
 * deletion. If none remain, downgrades to free.
 *
 * The audit trail (paymentEvents, webhookEvents) is preserved.
 *
 * Typical usage (CLI):
 *   npx convex run 'payments/billing:deleteSubscriptionByDodoId' \
 *     '{"dodoSubscriptionId":"sub_XXX","reason":"refunded by admin, user has higher-tier active sub"}'
 */
export const deleteSubscriptionByDodoId = internalMutation({
  args: {
    dodoSubscriptionId: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const sub = await ctx.db
      .query("subscriptions")
      .withIndex("by_dodoSubscriptionId", (q) =>
        q.eq("dodoSubscriptionId", args.dodoSubscriptionId),
      )
      .unique();
    if (!sub) {
      throw new Error(
        `[billing] deleteSubscriptionByDodoId: no subscription found with dodoSubscriptionId="${args.dodoSubscriptionId}"`,
      );
    }

    const userId = sub.userId;
    await ctx.db.delete(sub._id);
    console.log(
      `[billing] deleteSubscriptionByDodoId userId=${userId} dodoSubscriptionId=${args.dodoSubscriptionId} planKey=${sub.planKey} reason="${args.reason}"`,
    );

    // Re-derive the entitlement from the user's REMAINING subscriptions
    // through the same shared helper that subscription event handlers use.
    // This guarantees identical precedence (tier > PLAN_PRECEDENCE >
    // currentPeriodEnd) and identical comp-floor handling, so admin cleanup
    // can never produce an entitlement state that an organic webhook flow
    // wouldn't have produced.
    const now = Date.now();
    await recomputeEntitlementFromAllSubs(ctx, userId, now);

    const entitlementAfter = await ctx.db
      .query("entitlements")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .first();

    return {
      deleted: { _id: sub._id, dodoSubscriptionId: args.dodoSubscriptionId, planKey: sub.planKey },
      entitlementAfter: entitlementAfter
        ? {
            planKey: entitlementAfter.planKey,
            validUntil: entitlementAfter.validUntil,
            ...(entitlementAfter.compUntil !== undefined ? { compUntil: entitlementAfter.compUntil } : {}),
          }
        : null,
    };
  },
});
