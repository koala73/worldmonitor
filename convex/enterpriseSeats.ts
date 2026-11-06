/**
 * Self-serve seat management for Enterprise contract accounts.
 *
 * The account admin invites people by email from Settings, sees every seat,
 * and removes members or pending invites. An invitee accepts through the
 * emailed link (/dashboard?accept-enterprise-invite=<memberId>&token=<t>),
 * signed in with the invited address. Acceptance turns the pending
 * `enterpriseMembers` row active, which makes the invitee an Enterprise
 * member with the account's pooled allowance and AI routing.
 *
 * Mirrors the Business seat flow (convex/payments/businessSeats.ts): HMAC
 * token bound to the row, 14-day expiry, corporate email domains only, an
 * expired invite frees its seat. The seat cap is the account's `seatCap`.
 * Operator commands in convex/enterpriseAccounts.ts keep working alongside.
 */

import { ConvexError, v } from "convex/values";
import {
  internalAction,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { assertAccountWritable } from "./accountDeletion/guard";
import { USER_AGENT } from "./broadcast/_resendContacts";
import { requireUserId, resolveUserIdentity } from "./lib/auth";
import { isCorporateDomain } from "./lib/emailDomain";
import {
  signEnterpriseInviteToken,
  verifyEnterpriseInviteToken,
} from "./lib/identitySigning";
import { ResendSendError, sendResendEmail } from "./lib/resendEmail";
import {
  accountMembers,
  applyMemberChange,
  holdsSeat,
  touchAccountLock,
} from "./enterpriseAccounts";

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_EMAILS_PER_CALL = 10;
const RESEND_FETCH_TIMEOUT_MS = 10_000;
/**
 * Rolling cap on invites so an admin cannot send unbounded invite mail by
 * inviting and withdrawing in a loop. Withdrawn rows keep their `invitedAt`
 * and count. The cap never drops below the seat cap, so an admin can still
 * fill every seat in one day.
 */
const INVITE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MIN_INVITES_PER_WINDOW = 20;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type ReadCtx = Pick<QueryCtx, "db">;

/** The caller's active membership row and its account, or null. */
async function activeMembership(ctx: ReadCtx, userId: string) {
  const rows = await ctx.db
    .query("enterpriseMembers")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();
  // The add and accept paths refuse a second active account, so at most one.
  const member = rows.find((m) => m.status === "active");
  if (!member) return null;
  const account = await ctx.db.get(member.accountId);
  if (!account) return null;
  return { member, account };
}

async function requireAdmin(ctx: MutationCtx, userId: string) {
  const membership = await activeMembership(ctx, userId);
  if (!membership || membership.member.role !== "admin") {
    throw new ConvexError({ kind: "NOT_ACCOUNT_ADMIN" });
  }
  return membership;
}

async function customerEmail(ctx: ReadCtx, userId: string): Promise<string | null> {
  const customer = await ctx.db
    .query("customers")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .first();
  return customer?.email?.trim().toLowerCase() || null;
}

/** The address a row stands for: the invited email, or the member's account email. */
async function memberEmail(ctx: ReadCtx, member: Doc<"enterpriseMembers">): Promise<string | null> {
  if (member.email) return member.email;
  return member.userId ? customerEmail(ctx, member.userId) : null;
}

/**
 * The caller's Enterprise seat view for Settings. `null` when the caller is
 * not an active member. Members see the account name and seat count; only the
 * admin gets the roster.
 */
export const listMySeats = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const membership = await activeMembership(ctx, userId);
    if (!membership) return null;
    const { member: self, account } = membership;
    const now = Date.now();
    const rows = await ctx.db
      .query("enterpriseMembers")
      .withIndex("by_accountId", (q) => q.eq("accountId", account._id))
      .collect();
    const seatsUsed = rows.filter((m) => holdsSeat(m, now)).length;
    const isAdmin = self.role === "admin";

    const seats = isAdmin
      ? await Promise.all(
        rows
          .filter((m) => m.status !== "removed")
          .map(async (m) => ({
            memberId: m._id,
            email: await memberEmail(ctx, m),
            status: m.status === "active"
              ? "active" as const
              : holdsSeat(m, now) ? "pending" as const : "expired" as const,
            role: m.role,
            isSelf: m._id === self._id,
            invitedAt: m.invitedAt ?? null,
            joinedAt: m.joinedAt ?? null,
            inviteExpiresAt: m.inviteExpiresAt ?? null,
            emailFailed: m.status === "pending" && m.inviteEmailFailedAt !== undefined,
          })),
      )
      : [];

    return {
      accountName: account.name,
      isAdmin,
      seatCap: account.seatCap,
      seatsUsed,
      contractEnd: account.contractEnd,
      contractEnded: now >= account.contractEnd,
      seats,
    };
  },
});

/**
 * Admin invites people by email. Each new address gets a pending seat and an
 * emailed single-use link valid for 14 days. Re-inviting a pending or active
 * address is a no-op that reports its state; re-inviting an expired invite
 * issues a fresh one.
 */
export const inviteMembers = mutation({
  args: { emails: v.array(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await assertAccountWritable(ctx, userId);
    const { account } = await requireAdmin(ctx, userId);
    const identity = await resolveUserIdentity(ctx);
    const adminEmail = identity?.email?.trim().toLowerCase();
    if (!adminEmail) throw new ConvexError({ kind: "ADMIN_EMAIL_UNAVAILABLE" });

    const now = Date.now();
    if (now >= account.contractEnd) throw new ConvexError({ kind: "CONTRACT_ENDED" });

    const emails = Array.from(new Set(
      args.emails.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0),
    ));
    if (emails.length === 0) throw new ConvexError({ kind: "NO_EMAILS_PROVIDED" });
    if (emails.length > MAX_EMAILS_PER_CALL) throw new ConvexError({ kind: "TOO_MANY_EMAILS" });

    await touchAccountLock(ctx, account._id, now);
    const rows = await accountMembers(ctx, account._id);
    const holding = rows.filter((m) => holdsSeat(m, now));
    const heldEmails = new Map<string, Doc<"enterpriseMembers">>();
    for (const m of holding) {
      const email = await memberEmail(ctx, m);
      if (email) heldEmails.set(email, m);
    }

    const results: Array<{
      email: string;
      memberId: string;
      status: "created" | "already_pending" | "already_active";
    }> = [];
    const newEmails: string[] = [];
    for (const email of emails) {
      if (email === adminEmail) throw new ConvexError({ kind: "CANNOT_INVITE_SELF" });
      if (!email.includes("@") || !isCorporateDomain(email)) {
        throw new ConvexError({ kind: "INVITEE_DOMAIN_NOT_CORPORATE" });
      }
      const existing = heldEmails.get(email);
      if (existing) {
        results.push({
          email,
          memberId: existing._id,
          status: existing.status === "active" ? "already_active" : "already_pending",
        });
        continue;
      }
      newEmails.push(email);
    }

    if (holding.length + newEmails.length > account.seatCap) {
      throw new ConvexError({ kind: "SEAT_CAP_REACHED" });
    }
    // Counted under the account lock taken above, so concurrent calls cannot
    // both slip under the cap. Only emailed invites (they carry an expiry)
    // count; operator-added rows send no mail.
    const recentInvites = rows.filter(
      (m) => m.inviteExpiresAt !== undefined
        && m.invitedAt !== undefined
        && m.invitedAt > now - INVITE_WINDOW_MS,
    ).length;
    if (recentInvites + newEmails.length > Math.max(MIN_INVITES_PER_WINDOW, account.seatCap)) {
      throw new ConvexError({ kind: "INVITE_RATE_LIMITED" });
    }

    const expiresAt = now + INVITE_TTL_MS;
    for (const email of newEmails) {
      const memberId = await ctx.db.insert("enterpriseMembers", {
        accountId: account._id,
        email,
        status: "pending",
        role: "member",
        invitedAt: now,
        inviteExpiresAt: expiresAt,
        updatedAt: now,
      });
      const token = await signEnterpriseInviteToken(memberId, expiresAt);
      await ctx.scheduler.runAfter(0, internal.enterpriseSeats.sendEnterpriseInviteEmail, {
        inviteeEmail: email,
        adminEmail,
        accountName: account.name,
        memberId,
        token,
      });
      results.push({ email, memberId, status: "created" });
    }
    return { invited: results };
  },
});

/**
 * Admin removes a member or withdraws an invite. A removed member loses the
 * account's Enterprise access and AI routing at once. The admin cannot remove
 * their own seat; ask support to move the admin role first.
 */
export const removeMember = mutation({
  args: { memberId: v.id("enterpriseMembers") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const { member: self, account } = await requireAdmin(ctx, userId);
    const target = await ctx.db.get(args.memberId);
    if (!target || target.accountId !== account._id) {
      throw new ConvexError({ kind: "MEMBER_NOT_FOUND" });
    }
    if (target._id === self._id) throw new ConvexError({ kind: "CANNOT_REMOVE_SELF" });
    if (target.status === "removed") {
      return { ok: true as const, status: "already_removed" as const };
    }
    const now = Date.now();
    await touchAccountLock(ctx, account._id, now);
    await ctx.db.patch(target._id, { status: "removed", role: "member", removedAt: now, updatedAt: now });
    if (target.status === "active" && target.userId) {
      await applyMemberChange(ctx, target.userId, now);
    }
    return { ok: true as const, status: "removed" as const };
  },
});

/**
 * The invitee redeems the emailed token. The signed-in account's email must
 * match the invited address, the invite must still be pending and unexpired,
 * the contract must not have ended, and the account must not be an active
 * member of another Enterprise account.
 */
export const acceptInvite = mutation({
  args: { memberId: v.id("enterpriseMembers"), token: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await assertAccountWritable(ctx, userId);
    const identity = await resolveUserIdentity(ctx);
    const inviteeEmail = identity?.email?.trim().toLowerCase();
    if (!inviteeEmail) throw new ConvexError({ kind: "INVITEE_EMAIL_UNAVAILABLE" });

    const row = await ctx.db.get(args.memberId);
    if (!row || !row.email) throw new ConvexError({ kind: "INVITE_NOT_FOUND" });
    if (row.status !== "pending") throw new ConvexError({ kind: "INVITE_ALREADY_USED" });
    const now = Date.now();
    if (!holdsSeat(row, now)) throw new ConvexError({ kind: "INVITE_EXPIRED" });
    if (!(await verifyEnterpriseInviteToken(args.memberId, args.token))) {
      throw new ConvexError({ kind: "INVALID_INVITE_TOKEN" });
    }
    if (row.email !== inviteeEmail) throw new ConvexError({ kind: "INVITE_EMAIL_MISMATCH" });

    const account = await ctx.db.get(row.accountId);
    if (!account || now >= account.contractEnd) throw new ConvexError({ kind: "CONTRACT_ENDED" });

    await touchAccountLock(ctx, account._id, now);
    const own = await ctx.db
      .query("enterpriseMembers")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    const active = own.find((m) => m.status === "active");
    if (active && active.accountId !== account._id) {
      throw new ConvexError({ kind: "ALREADY_MEMBER_OF_ANOTHER_ACCOUNT" });
    }
    if (active) {
      // Already a member of this account: retire the invite so it frees its seat.
      await ctx.db.patch(row._id, { status: "removed", removedAt: now, updatedAt: now });
      return { ok: true as const, status: "already_active" as const };
    }

    await ctx.db.patch(row._id, {
      status: "active",
      userId,
      joinedAt: now,
      updatedAt: now,
    });
    await applyMemberChange(ctx, userId, now);
    return { ok: true as const, status: "joined" as const };
  },
});

/** Sends the invite email. Scheduled from inviteMembers so delivery never blocks the mutation. */
export const sendEnterpriseInviteEmail = internalAction({
  args: {
    inviteeEmail: v.string(),
    adminEmail: v.string(),
    accountName: v.string(),
    memberId: v.string(),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.error("[enterpriseSeats] RESEND_API_KEY not set — skipping invite email");
      await ctx.runMutation(internal.enterpriseSeats.markInviteEmailFailed, { memberId: args.memberId });
      return;
    }
    const acceptUrl = `https://www.worldmonitor.app/dashboard?accept-enterprise-invite=${encodeURIComponent(args.memberId)}&token=${encodeURIComponent(args.token)}`;
    const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; background: #0a0a0a; color: #e0e0e0;">
  <div style="background: #4ade80; height: 4px;"></div>
  <div style="padding: 40px 32px;">
    <p style="font-size: 22px; font-weight: 700; color: #fff; margin: 0 0 12px;">You're invited to World Monitor Enterprise</p>
    <p style="font-size: 14px; color: #999; line-height: 1.5; margin: 0 0 24px;">
      ${escapeHtml(args.adminEmail)} has invited you to the ${escapeHtml(args.accountName)} World Monitor Enterprise account.
      Accept the invite while signed in as ${escapeHtml(args.inviteeEmail)}. If you don't have an account yet, you can create one from the same link.
    </p>
    <div style="text-align: center;">
      <a href="${acceptUrl}" style="display: inline-block; background: #4ade80; color: #0a0a0a; padding: 14px 36px; text-decoration: none; font-weight: 800; font-size: 13px; text-transform: uppercase; letter-spacing: 1.5px; border-radius: 2px;">Accept Invite</a>
    </div>
    <p style="font-size: 11px; color: #666; text-align: center; margin: 24px 0 0;">
      This invite expires in 14 days. If you didn't expect this email, you can ignore it.
    </p>
  </div>
</div>`;
    let result;
    try {
      result = await sendResendEmail(ctx, {
        apiKey,
        from: "World Monitor <noreply@worldmonitor.app>",
        to: args.inviteeEmail,
        subject: `You've been invited to ${args.accountName} on World Monitor Enterprise`,
        html,
        purpose: "transactional",
        userAgent: USER_AGENT,
        timeoutMs: RESEND_FETCH_TIMEOUT_MS,
      });
    } catch (err) {
      await ctx.runMutation(internal.enterpriseSeats.markInviteEmailFailed, { memberId: args.memberId });
      if (err instanceof ResendSendError) {
        console.error(`[enterpriseSeats] Resend ${err.status}: ${err.body}`);
        throw new Error(`Resend enterprise invite email failed: ${err.status}`);
      }
      throw err;
    }
    if (!result.sent) {
      console.log("[enterpriseSeats] Skipped invite email: recipient is suppressed");
      await ctx.runMutation(internal.enterpriseSeats.markInviteEmailFailed, { memberId: args.memberId });
      return;
    }
    console.log(`[enterpriseSeats] Invite email sent (member ${args.memberId.slice(0, 8)}...)`);
  },
});

/** Records that a pending invite's email was not sent, for the admin's roster. */
export const markInviteEmailFailed = internalMutation({
  args: { memberId: v.string() },
  handler: async (ctx, args) => {
    const memberId = ctx.db.normalizeId("enterpriseMembers", args.memberId);
    const member = memberId ? await ctx.db.get(memberId) : null;
    if (!memberId || !member || member.status !== "pending") return;
    const now = Date.now();
    await ctx.db.patch(memberId, { inviteEmailFailedAt: now, updatedAt: now });
  },
});
