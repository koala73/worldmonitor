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
import { action, mutation, query, internalAction, internalMutation, internalQuery, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { DodoPayments } from "dodopayments";
import { resolveUserId, requireUserId } from "../lib/auth";
import { getFeaturesForPlan } from "../lib/entitlements";
import { PRODUCT_CATALOG, resolveProductToPlan } from "../config/productCatalog";
import { recomputeEntitlementFromAllSubs } from "./subscriptionHelpers";

// UUID v4 regex matching values produced by crypto.randomUUID() in user-identity.ts.
// Hoisted to module scope to avoid re-allocation on every claimSubscription call.
const ANON_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
function getDodoClient(): DodoPayments {
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
  });
}

async function createCustomerPortalUrlForUser(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  userId: string,
): Promise<{ portal_url: string }> {
  let customer = await ctx.runQuery(
    internal.payments.billing.getCustomerByUserId,
    { userId },
  );

  if (!customer || !customer.dodoCustomerId) {
    // Self-heal a known webhook gap: `subscription.active` writes the
    // `subscriptions` row unconditionally but only writes `customers` when
    // `data.customer?.customer_id` is present in the payload
    // (`subscriptionHelpers.ts:525`). Users whose webhook delivery
    // lacked the customer field end up entitled (active sub) but with no
    // customers row — clicking "Manage Billing" throws NO_CUSTOMER. The
    // subscription's `rawPayload` carries the same customer info though,
    // so try to recover from there before giving up. WORLDMONITOR-R5
    // (user_3DcpiviTIweanCi9BtF5PRpqwv6 — active Pro Annual, no customers row).
    customer = await ctx.runMutation(
      internal.payments.billing.repairCustomerFromSubscriptionPayload,
      { userId },
    );
  }

  if (!customer || !customer.dodoCustomerId) {
    // Genuine no-customer state — recovery from subscription payload
    // didn't yield a dodoCustomerId either. Throw structured so the
    // client can surface a useful "contact support" toast (object-typed
    // `data` so `err.data.kind` survives the wire — see
    // `api/_convex-error.js` for the broader pattern).
    throw new ConvexError({ kind: "NO_CUSTOMER" });
  }

  const client = getDodoClient();
  const session = await client.customers.customerPortal.create(
    customer.dodoCustomerId,
    { send_email: false },
  );

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

    const priorityOrder = ["active", "on_hold", "cancelled", "expired"];
    allSubs.sort((a, b) => {
      const pa = priorityOrder.indexOf(a.status);
      const pb = priorityOrder.indexOf(b.status);
      if (pa !== pb) return pa - pb; // active first
      return b.updatedAt - a.updatedAt; // then most recently updated
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
    };
  },
});

/**
 * Internal query to retrieve a customer record by userId.
 * Used by getCustomerPortalUrl to find the dodoCustomerId.
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
 * Internal query used by checkout creation to prevent duplicate subscriptions.
 *
 * Blocks new checkout sessions when the user already has an active/on_hold
 * subscription in the same tier group, or a cancelled subscription that
 * still has time remaining in the current billing period. This is an app-side
 * guard only; Dodo's "Allow Multiple Subscriptions" setting is still the
 * provider-side backstop for races before webhook ingestion updates Convex.
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
        if (existingCatalogEntry.tierGroup !== targetCatalogEntry.tierGroup) return false;
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
 * calls claimSubscription(anonId) to reassign all payment records from the
 * anonymous ID to the real user ID.
 *
 * @see https://github.com/koala73/worldmonitor/issues/2078
 */
export const claimSubscription = mutation({
  args: { anonId: v.string() },
  handler: async (ctx, args) => {
    const realUserId = await requireUserId(ctx);

    // Validate anonId is a UUID v4 (format produced by crypto.randomUUID() in user-identity.ts).
    // Rejects injected Clerk IDs ("user_xxx") which are structurally distinct from UUID v4,
    // preventing cross-user subscription theft via localStorage injection.
    if (!ANON_ID_REGEX.test(args.anonId) || args.anonId === realUserId) {
      return { claimed: { subscriptions: 0, entitlements: 0, customers: 0, payments: 0 } };
    }

    // Parallel reads for all anonId data — bounded to prevent runaway memory
    const [subs, anonEntitlement, customers, payments] = await Promise.all([
      ctx.db.query("subscriptions").withIndex("by_userId", (q) => q.eq("userId", args.anonId)).take(50),
      ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", args.anonId)).first(),
      ctx.db.query("customers").withIndex("by_userId", (q) => q.eq("userId", args.anonId)).take(10),
      ctx.db.query("paymentEvents").withIndex("by_userId", (q) => q.eq("userId", args.anonId)).take(1000),
    ]);

    // Reassign subscriptions
    for (const sub of subs) {
      await ctx.db.patch(sub._id, { userId: realUserId });
    }

    // Reassign entitlements — compare by tier first, then validUntil
    // Use .first() instead of .unique() to avoid throwing on duplicate rows
    let winningPlanKey: string | null = null;
    let winningFeatures: ReturnType<typeof getFeaturesForPlan> | null = null;
    let winningValidUntil: number | null = null;
    if (anonEntitlement) {
      const existingEntitlement = await ctx.db
        .query("entitlements")
        .withIndex("by_userId", (q) => q.eq("userId", realUserId))
        .first();
      if (existingEntitlement) {
        // Compare by tier first, break ties with validUntil
        const anonTier = anonEntitlement.features?.tier ?? 0;
        const existingTier = existingEntitlement.features?.tier ?? 0;
        const anonWins =
          anonTier > existingTier ||
          (anonTier === existingTier && anonEntitlement.validUntil > existingEntitlement.validUntil);
        if (anonWins) {
          winningPlanKey = anonEntitlement.planKey;
          winningFeatures = anonEntitlement.features;
          winningValidUntil = anonEntitlement.validUntil;
          await ctx.db.patch(existingEntitlement._id, {
            planKey: anonEntitlement.planKey,
            features: anonEntitlement.features,
            validUntil: anonEntitlement.validUntil,
            updatedAt: Date.now(),
          });
        } else {
          winningPlanKey = existingEntitlement.planKey;
          winningFeatures = existingEntitlement.features;
          winningValidUntil = existingEntitlement.validUntil;
        }
        await ctx.db.delete(anonEntitlement._id);
      } else {
        winningPlanKey = anonEntitlement.planKey;
        winningFeatures = anonEntitlement.features;
        winningValidUntil = anonEntitlement.validUntil;
        await ctx.db.patch(anonEntitlement._id, { userId: realUserId });
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

    // ACCEPTED BOUND: cache sync runs after mutation commits. Stale cache
    // survives up to ENTITLEMENT_CACHE_TTL_SECONDS (900s) if scheduler fails.
    // Sync Redis cache: clear stale anon entry + write real user's entitlement
    if (process.env.UPSTASH_REDIS_REST_URL) {
      // Delete the anon ID's stale Redis cache entry
      await ctx.scheduler.runAfter(
        0,
        internal.payments.cacheActions.deleteEntitlementCache,
        { userId: args.anonId },
      );
      // Sync the real user's entitlement to Redis
      if (winningPlanKey && winningFeatures && winningValidUntil) {
        await ctx.scheduler.runAfter(
          0,
          internal.payments.cacheActions.syncEntitlementCache,
          {
            userId: realUserId,
            planKey: winningPlanKey,
            features: winningFeatures,
            validUntil: winningValidUntil,
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
