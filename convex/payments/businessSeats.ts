/**
 * API Business domain-gated Pro-seat invites (#4634/#4635).
 *
 * An active `api_business` subscriber on a corporate email domain may invite up
 * to 4 teammates at any corporate email domain. Each accepted invitee resolves
 * to a full Pro entitlement (minus billing/account management) via the grant row in
 * `businessProGrants`. Grants are auto-revoked when the Business subscription
 * stops covering.
 */

import { ConvexError, v } from "convex/values";
import {
  internalAction,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { USER_AGENT } from "../broadcast/_resendContacts";
import { requireUserId, resolveUserIdentity } from "../lib/auth";
import {
  extractDomain,
  isCorporateDomain,
  sameDomain,
} from "../lib/emailDomain";
import {
  signBusinessInviteToken,
  verifyBusinessInviteToken,
} from "../lib/identitySigning";
import { isCoveringAt } from "./subscriptionHelpers";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const MAX_SEATS = 4;
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const RESEND_FETCH_TIMEOUT_MS = 10_000;

/**
 * Touch-or-insert the per-Business-subscription OCC lock row shared by
 * inviteSeats and removeSeat. EVERY mutation that mutates `businessProGrants`
 * for a Business sub must read AND write this row, forcing Convex's
 * per-document OCC to serialize concurrent calls. Without this, two parallel
 * invites could both pass the cap check and insert a 5th grant.
 */
async function touchBusinessSeatLock(
  ctx: MutationCtx,
  businessSubscriptionId: string,
  now: number,
): Promise<void> {
  const lock = await ctx.db
    .query("businessSeatLocks")
    .withIndex("by_businessSubscriptionId", (q) =>
      q.eq("businessSubscriptionId", businessSubscriptionId),
    )
    .unique();
  if (lock) {
    await ctx.db.patch(lock._id, { lastTouchedAt: now });
  } else {
    await ctx.db.insert("businessSeatLocks", {
      businessSubscriptionId,
      lastTouchedAt: now,
    });
  }
}

/**
 * Returns true when the caller owns an active/covering `api_business`
 * subscription.
 */
async function getCoveringBusinessSubscription(
  ctx: MutationCtx | QueryCtx,
  userId: string,
  at: number,
) {
  const subs = await ctx.db
    .query("subscriptions")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();
  return subs.find(
    (s) => s.planKey === "api_business" && isCoveringAt(s, at),
  ) ?? null;
}

/**
 * Counts active-or-pending grants for a Business subscription. Pending
 * (un-accepted, un-expired) invites count against the cap to prevent
 * over-issuing; expired/revoked ones free a slot.
 */
async function countActiveOrPendingGrants(
  ctx: MutationCtx | QueryCtx,
  businessSubscriptionId: string,
  at: number,
) {
  const grants = await ctx.db
    .query("businessProGrants")
    .withIndex("by_businessSubscriptionId", (q) =>
      q.eq("businessSubscriptionId", businessSubscriptionId),
    )
    .collect();
  return grants.filter((g) => {
    if (g.status === "accepted") return true;
    if (g.status === "pending" && g.expiresAt > at) return true;
    return false;
  }).length;
}

/**
 * Owner invites up to 4 teammates at any corporate email domain. Pending
 * invites count against the cap; each gets a single-use HMAC token emailed via Resend.
 */
export const inviteSeats = mutation({
  args: { emails: v.array(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const identity = await resolveUserIdentity(ctx);
    const ownerEmail = identity?.email?.trim();
    if (!ownerEmail) {
      throw new ConvexError({ kind: "OWNER_EMAIL_UNAVAILABLE" });
    }

    const now = Date.now();
    const businessSub = await getCoveringBusinessSubscription(ctx, userId, now);
    if (!businessSub) {
      throw new ConvexError({ kind: "OWNER_NOT_BUSINESS" });
    }

    const ownerDomain = extractDomain(ownerEmail);
    if (!ownerDomain || !isCorporateDomain(ownerEmail)) {
      throw new ConvexError({ kind: "OWNER_DOMAIN_NOT_CORPORATE" });
    }

    // Serialize concurrent inviteSeats / removeSeat calls for this Business
    // subscription so the cap check below cannot be bypassed by a race.
    await touchBusinessSeatLock(ctx, businessSub.dodoSubscriptionId, now);

    const normalizedOwnerEmail = ownerEmail.toLowerCase();
    // Dedupe: the existingByEmail check below only guards against emails
    // that already had a grant BEFORE this call — a duplicate within the
    // SAME args.emails array would otherwise slip past it (neither
    // occurrence is in existingGrants yet) and create two grant rows for
    // one invitee.
    const emails = Array.from(
      new Set(args.emails.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0)),
    );
    if (emails.length === 0) {
      throw new ConvexError({ kind: "NO_EMAILS_PROVIDED" });
    }
    if (emails.length > MAX_SEATS) {
      throw new ConvexError({ kind: "TOO_MANY_EMAILS" });
    }

    // Check existing grants for duplicates (active or pending).
    const existingGrants = await ctx.db
      .query("businessProGrants")
      .withIndex("by_businessSubscriptionId", (q) =>
        q.eq("businessSubscriptionId", businessSub.dodoSubscriptionId),
      )
      .collect();
    const existingByEmail = new Map(
      existingGrants.map((g) => [g.inviteeEmail, g]),
    );

    // Separate new invites from duplicates before the cap check so a duplicate
    // re-invite is idempotent even when the cap is full.
    const newEmails: string[] = [];
    const results: Array<{
      email: string;
      grantId: string;
      status: "created" | "already_pending" | "already_accepted";
    }> = [];

    for (const email of emails) {
      if (email === normalizedOwnerEmail) {
        throw new ConvexError({ kind: "CANNOT_INVITE_SELF" });
      }
      if (!isCorporateDomain(email)) {
        throw new ConvexError({ kind: "INVITEE_DOMAIN_NOT_CORPORATE" });
      }

      const existing = existingByEmail.get(email);
      if (existing) {
        if (existing.status === "accepted") {
          results.push({ email, grantId: existing._id, status: "already_accepted" });
          continue;
        }
        if (existing.status === "pending" && existing.expiresAt > now) {
          results.push({ email, grantId: existing._id, status: "already_pending" });
          continue;
        }
      }
      newEmails.push(email);
    }

    const currentCount = await countActiveOrPendingGrants(
      ctx,
      businessSub.dodoSubscriptionId,
      now,
    );
    if (currentCount + newEmails.length > MAX_SEATS) {
      throw new ConvexError({ kind: "SEAT_CAP_REACHED" });
    }

    for (const email of newEmails) {
      const grantId = await ctx.db.insert("businessProGrants", {
        businessSubscriptionId: businessSub.dodoSubscriptionId,
        ownerUserId: userId,
        inviteeEmail: email,
        domain: ownerDomain,
        status: "pending",
        createdAt: now,
        expiresAt: now + INVITE_TTL_MS,
      });

      const token = await signBusinessInviteToken(grantId);
      await ctx.scheduler.runAfter(
        0,
        internal.payments.businessSeats.sendBusinessInviteEmail,
        { inviteeEmail: email, ownerEmail, grantId, token },
      );
      results.push({ email, grantId, status: "created" });
    }

    return { invited: results };
  },
});

/**
 * Shared Resend send + error-handling for both business-seat email actions.
 * `skipLogContext` names what's being skipped when RESEND_API_KEY is unset;
 * `failureLabel` names the operation in the thrown error on a non-2xx.
 */
async function sendResendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  skipLogContext: string;
  failureLabel: string;
  successLog: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error(`[businessSeats] RESEND_API_KEY not set — skipping ${opts.skipLogContext}`);
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      from: "World Monitor <noreply@worldmonitor.app>",
      to: [opts.to],
      subject: opts.subject,
      html: opts.html,
    }),
    signal: AbortSignal.timeout(RESEND_FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[businessSeats] Resend ${res.status}: ${body}`);
    throw new Error(`Resend ${opts.failureLabel} failed: ${res.status}`);
  }
  console.log(opts.successLog);
}

/**
 * Notifies a revoked invitee that their team access ended. Scheduled from the
 * revoke-on-lapse path in subscriptionHelpers.
 */
export const sendTeamAccessEndedEmail = internalAction({
  args: { inviteeEmail: v.string() },
  handler: async (_ctx, args) => {
    const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; background: #0a0a0a; color: #e0e0e0;">
  <div style="background: #ef4444; height: 4px;"></div>
  <div style="padding: 40px 32px;">
    <p style="font-size: 22px; font-weight: 700; color: #fff; margin: 0 0 12px;">Team access ended</p>
    <p style="font-size: 14px; color: #999; line-height: 1.5; margin: 0 0 24px;">
      Your WorldMonitor Pro seat on a team Business plan has ended because the plan is no longer active.
      Your account has returned to the free tier.
    </p>
    <div style="text-align: center;">
      <a href="https://worldmonitor.app/pro" style="display: inline-block; background: #ef4444; color: #fff; padding: 14px 36px; text-decoration: none; font-weight: 800; font-size: 13px; text-transform: uppercase; letter-spacing: 1.5px; border-radius: 2px;">View Plans</a>
    </div>
    <p style="font-size: 11px; color: #666; text-align: center; margin: 24px 0 0;">
      Questions? Reply to this email or contact support@worldmonitor.app.
    </p>
  </div>
</div>`;

    await sendResendEmail({
      to: args.inviteeEmail,
      subject: "Your WorldMonitor team access has ended",
      html,
      skipLogContext: "team-access-ended email",
      failureLabel: "team-access-ended email",
      successLog: `[businessSeats] Team-access-ended email sent to ${args.inviteeEmail.split("@")[0]}@...`,
    });
  },
});

/**
 * Sends the invite email via Resend. Scheduled from inviteSeats so delivery
 * does not block the mutation.
 */
export const sendBusinessInviteEmail = internalAction({
  args: {
    inviteeEmail: v.string(),
    ownerEmail: v.string(),
    grantId: v.string(),
    token: v.string(),
  },
  handler: async (_ctx, args) => {
    const acceptUrl = `https://worldmonitor.app/settings?accept-business-invite=${encodeURIComponent(args.grantId)}&token=${encodeURIComponent(args.token)}`;
    const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; background: #0a0a0a; color: #e0e0e0;">
  <div style="background: #4ade80; height: 4px;"></div>
  <div style="padding: 40px 32px;">
    <p style="font-size: 22px; font-weight: 700; color: #fff; margin: 0 0 12px;">You're invited to WorldMonitor Pro</p>
    <p style="font-size: 14px; color: #999; line-height: 1.5; margin: 0 0 24px;">
      ${escapeHtml(args.ownerEmail)} has invited you to a Pro seat on their WorldMonitor API Business plan.
      Accept the invite to unlock all Pro features — no billing setup required.
    </p>
    <div style="text-align: center;">
      <a href="${acceptUrl}" style="display: inline-block; background: #4ade80; color: #0a0a0a; padding: 14px 36px; text-decoration: none; font-weight: 800; font-size: 13px; text-transform: uppercase; letter-spacing: 1.5px; border-radius: 2px;">Accept Invite</a>
    </div>
    <p style="font-size: 11px; color: #666; text-align: center; margin: 24px 0 0;">
      This invite expires in 14 days. If you didn't expect this email, you can ignore it.
    </p>
  </div>
</div>`;

    await sendResendEmail({
      to: args.inviteeEmail,
      subject: "You've been invited to WorldMonitor Pro",
      html,
      skipLogContext: "invite email",
      failureLabel: "invite email",
      successLog: `[businessSeats] Invite email sent to ${args.inviteeEmail.split("@")[0]}@... (grant ${args.grantId.slice(0, 8)}...)`,
    });
  },
});

/**
 * Lists the owner's seats for the settings UI. Only the owner sees their own
 * grants.
 */
export const listSeats = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const identity = await resolveUserIdentity(ctx);
    const ownerEmail = identity?.email?.trim() ?? "";
    // Server-computed corporate-domain check, using the same authoritative
    // isCorporateDomain() the invite/accept mutations enforce — the settings
    // UI uses this instead of maintaining its own copy of the free-domain
    // list, which drifted stale and shorter than the real one.
    const ownerDomain = ownerEmail ? extractDomain(ownerEmail) : null;
    const ownerIsCorporateDomain = ownerEmail ? isCorporateDomain(ownerEmail) : false;

    const now = Date.now();
    const businessSub = await getCoveringBusinessSubscription(ctx, userId, now);
    if (!businessSub) {
      return { seats: [], businessSubscriptionId: null, ownerDomain, ownerIsCorporateDomain };
    }

    const grants = await ctx.db
      .query("businessProGrants")
      .withIndex("by_businessSubscriptionId", (q) =>
        q.eq("businessSubscriptionId", businessSub.dodoSubscriptionId),
      )
      .collect();

    return {
      businessSubscriptionId: businessSub.dodoSubscriptionId,
      ownerDomain,
      ownerIsCorporateDomain,
      seats: grants.map((g) => ({
        grantId: g._id,
        inviteeEmail: g.inviteeEmail,
        // Compute the effective status at read time: a "pending" grant past
        // its expiresAt is expired even though the stored row hasn't been
        // swept yet (nothing proactively flips it) — without this, the UI
        // would show a lapsed invite as still pending indefinitely, and
        // the reader's status wouldn't agree with countActiveOrPendingGrants'
        // own expiry check.
        status: g.status === "pending" && g.expiresAt <= now ? "expired" : g.status,
        createdAt: g.createdAt,
        acceptedAt: g.acceptedAt ?? null,
        expiresAt: g.expiresAt,
      })),
    };
  },
});

/**
 * Owner-only removal of a single seat. Revokes the grant and recomputes the
 * invitee's entitlement.
 */
export const removeSeat = mutation({
  args: { grantId: v.id("businessProGrants") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const grant = await ctx.db.get(args.grantId);
    if (!grant) {
      throw new ConvexError({ kind: "GRANT_NOT_FOUND" });
    }
    if (grant.ownerUserId !== userId) {
      throw new ConvexError({ kind: "NOT_OWNER" });
    }
    if (grant.status !== "pending" && grant.status !== "accepted") {
      return { ok: true as const, status: "already_inactive" as const };
    }

    const now = Date.now();
    // Serialize with inviteSeats via the per-Business-subscription lock row.
    await touchBusinessSeatLock(ctx, grant.businessSubscriptionId, now);

    await ctx.db.patch(args.grantId, { status: "revoked" });

    if (grant.inviteeUserId) {
      await ctx.runMutation(
        internal.payments.subscriptionHelpers.recomputeEntitlementForUser,
        { userId: grant.inviteeUserId, eventTimestamp: now },
      );
    }
    return { ok: true as const, status: "revoked" as const };
  },
});

/**
 * Invitee redeems an HMAC token to accept a Business Pro seat invite. Verifies
 * the token, matches the signed-in Clerk email against the invited address,
 * checks the underlying Business subscription is still covering, flips the
 * grant to `accepted`, stamps `inviteeUserId`, and recomputes the invitee's
 * entitlement. Single-use: accepted/revoked/expired tokens are rejected.
 */
export const acceptBusinessInvite = mutation({
  args: { grantId: v.id("businessProGrants"), token: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const identity = await resolveUserIdentity(ctx);
    const inviteeEmail = identity?.email?.trim().toLowerCase();
    if (!inviteeEmail) {
      throw new ConvexError({ kind: "INVITEE_EMAIL_UNAVAILABLE" });
    }

    const grant = await ctx.db.get(args.grantId);
    if (!grant) {
      throw new ConvexError({ kind: "GRANT_NOT_FOUND" });
    }
    if (grant.status !== "pending") {
      throw new ConvexError({ kind: "INVITE_ALREADY_USED" });
    }
    const now = Date.now();
    if (grant.expiresAt <= now) {
      throw new ConvexError({ kind: "INVITE_EXPIRED" });
    }
    if (!(await verifyBusinessInviteToken(args.grantId, args.token))) {
      throw new ConvexError({ kind: "INVALID_INVITE_TOKEN" });
    }
    if (grant.inviteeEmail !== inviteeEmail) {
      throw new ConvexError({ kind: "INVITE_EMAIL_MISMATCH" });
    }
    if (!sameDomain(grant.inviteeEmail, inviteeEmail)) {
      throw new ConvexError({ kind: "INVITE_EMAIL_MISMATCH" });
    }
    if (!isCorporateDomain(inviteeEmail)) {
      throw new ConvexError({ kind: "INVITEE_DOMAIN_NOT_CORPORATE" });
    }

    const businessSub = await ctx.db
      .query("subscriptions")
      .withIndex("by_dodoSubscriptionId", (q) =>
        q.eq("dodoSubscriptionId", grant.businessSubscriptionId),
      )
      .unique();
    if (!businessSub || businessSub.planKey !== "api_business" || !isCoveringAt(businessSub, now)) {
      throw new ConvexError({ kind: "BUSINESS_NOT_ACTIVE" });
    }

    await ctx.db.patch(args.grantId, {
      status: "accepted",
      inviteeUserId: userId,
      acceptedAt: now,
    });

    await ctx.runMutation(
      internal.payments.subscriptionHelpers.recomputeEntitlementForUser,
      { userId, eventTimestamp: now },
    );

    return { ok: true as const };
  },
});
