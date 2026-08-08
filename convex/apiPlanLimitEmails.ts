import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { PRODUCT_CATALOG } from "./config/productCatalog";
import { MAX_EMAIL_ATTEMPTS } from "./apiPlanLimitNotices";

const RESEND_URL = "https://api.resend.com/emails";
const FROM = "World Monitor <noreply@worldmonitor.app>";
const SUPPORT_EMAIL = "support@worldmonitor.app";
const MAX_FAILURE_MESSAGES = 3;

type NoticeEmailRow = {
  _id: unknown;
  userId: string;
  planKey: string;
  dimension: string;
  state: "warning" | "over_limit" | "sustained_burst";
  windowKey: string;
  usage: number;
  limit: number | null;
  usageRatio: number | null;
  upgradeTargetPlanKey?: string;
  ctaKind: "checkout" | "billing_portal" | "contact_support" | "none";
  blockedReason?: string;
  emailAttempts?: number;
};

type Recipient = {
  email: string | null;
  suppressed: boolean;
};

function normalizeEmail(email: string | undefined | null): string | null {
  const trimmed = email?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function dimensionLabel(dimension: string): string {
  switch (dimension) {
    case "api_daily_requests":
      return "daily API requests";
    case "api_minute_burst":
      return "per-minute API burst traffic";
    case "mcp_daily_calls":
      return "daily MCP calls";
    case "mcp_minute_burst":
      return "per-minute MCP burst traffic";
    default:
      return dimension;
  }
}

function stateLabel(state: NoticeEmailRow["state"]): string {
  if (state === "warning") return "approaching";
  if (state === "sustained_burst") return "bursting above";
  return "over";
}

function formatLimit(limit: number | null): string {
  return limit == null ? "unlimited" : new Intl.NumberFormat("en-US").format(limit);
}

function usageLine(notice: NoticeEmailRow): string {
  const usage = new Intl.NumberFormat("en-US").format(notice.usage);
  const limit = formatLimit(notice.limit);
  const ratio = notice.usageRatio == null
    ? ""
    : ` (${Math.round(notice.usageRatio * 100)}% of plan)`;
  return `${usage} used / ${limit} included${ratio}`;
}

function upgradeLine(notice: NoticeEmailRow): string {
  const target = notice.upgradeTargetPlanKey
    ? PRODUCT_CATALOG[notice.upgradeTargetPlanKey]?.displayName ?? notice.upgradeTargetPlanKey
    : null;
  if (notice.ctaKind === "contact_support") {
    return target
      ? `Reply to this email and we can help move you to ${target}, or you can reduce traffic to stay on your current plan.`
      : "Reply to this email and we can help with higher-volume access, or you can reduce traffic to stay on your current plan.";
  }
  if (target) {
    return `You can upgrade to ${target}, or reduce traffic to stay on your current plan.`;
  }
  return "You can reduce traffic to stay on your current plan, or reply if you need help with higher-volume access.";
}

function noticeSubject(notice: NoticeEmailRow): string {
  const label = dimensionLabel(notice.dimension);
  if (notice.state === "warning") return `World Monitor usage notice: ${label} nearing plan limit`;
  if (notice.state === "sustained_burst") return `World Monitor usage notice: ${label} is above plan limit`;
  return `World Monitor usage notice: ${label} exceeded plan limit`;
}

function noticeHtml(notice: NoticeEmailRow): string {
  const plan = PRODUCT_CATALOG[notice.planKey]?.displayName ?? notice.planKey;
  const label = dimensionLabel(notice.dimension);
  const posture = stateLabel(notice.state);
  const support = upgradeLine(notice);
  return `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; background: #0a0a0a; color: #e0e0e0;">
  <div style="background: #facc15; height: 4px;"></div>
  <div style="padding: 32px;">
    <h1 style="font-size: 20px; color: #fff; margin: 0 0 12px;">Your World Monitor usage is ${posture} a plan limit</h1>
    <p style="font-size: 14px; color: #bbb; line-height: 1.6; margin: 0 0 20px;">This is a heads-up before stricter paid-plan enforcement. Nothing has been changed or charged automatically.</p>
    <div style="background: #111; border: 1px solid #242424; padding: 16px; margin-bottom: 20px;">
      <p style="margin: 0 0 8px; color: #fff;"><strong>Plan:</strong> ${escapeHtml(plan)}</p>
      <p style="margin: 0 0 8px; color: #fff;"><strong>Limit:</strong> ${escapeHtml(label)}</p>
      <p style="margin: 0 0 8px; color: #fff;"><strong>Window:</strong> ${escapeHtml(notice.windowKey)}</p>
      <p style="margin: 0; color: #fff;"><strong>Usage:</strong> ${escapeHtml(usageLine(notice))}</p>
    </div>
    <p style="font-size: 14px; color: #bbb; line-height: 1.6; margin: 0 0 20px;">${escapeHtml(support)}</p>
    <p style="font-size: 12px; color: #777; line-height: 1.5; margin: 0;">Questions? Reply here or email <a href="mailto:${SUPPORT_EMAIL}" style="color: #facc15;">${escapeHtml(SUPPORT_EMAIL)}</a>.</p>
  </div>
</div>`;
}

async function sendEmail(apiKey: string, to: string, subject: string, html: string): Promise<void> {
  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: FROM,
      to: [to],
      subject,
      html,
      reply_to: SUPPORT_EMAIL,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[apiPlanLimitEmails] Resend ${res.status}: ${body}`);
  }
}

export const getNoticeRecipient = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<Recipient> => {
    const customer = await ctx.db
      .query("customers")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();
    const user = customer ? null : await ctx.db
      .query("users")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();

    const email = normalizeEmail(customer?.email ?? user?.email);
    if (!email) return { email: null, suppressed: false };
    const suppression = await ctx.db
      .query("emailSuppressions")
      .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", email))
      .first();
    return { email, suppressed: !!suppression };
  },
});

export const sendDuePlanLimitEmails = internalAction({
  args: {
    now: v.optional(v.number()),
    limit: v.optional(v.number()),
    // Delivery kill-switch. When omitted, live sending requires the
    // PLAN_LIMIT_NOTIFY_LIVE=1 env var; tests pass `live: true` explicitly.
    live: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    // Default to DRY-RUN. The hourly cron passes no args, so a fresh deploy must
    // not blast live mail one minute later — sending is gated behind an explicit
    // PLAN_LIMIT_NOTIFY_LIVE=1 flag an operator flips only after the notice
    // pipeline is verified. In dry-run we touch no notice: due rows stay
    // `pending` and deliver on the first live run.
    const live = args.live ?? process.env.PLAN_LIMIT_NOTIFY_LIVE === "1";
    const due = await ctx.runQuery(
      (internal as any).apiPlanLimitNotices.listEmailDue,
      { now, limit: args.limit ?? 50 },
    ) as NoticeEmailRow[];

    if (!live) {
      console.log(
        `[apiPlanLimitEmails] dry-run (PLAN_LIMIT_NOTIFY_LIVE!=1): ${due.length} notice(s) due, none sent`,
      );
      return { considered: due.length, sent: 0, skipped: 0, failed: 0, dryRun: true };
    }

    const apiKey = process.env.RESEND_API_KEY;
    // Missing config is not a per-notice failure. Bail before touching any
    // notice so due notices stay `pending` (not poisoned to `failed`, which
    // would burn attempts / force a backoff) and deliver on the next run once
    // RESEND_API_KEY is set.
    if (!apiKey) {
      throw new Error("[apiPlanLimitEmails] RESEND_API_KEY not configured; skipped email delivery");
    }

    const summary = { considered: due.length, sent: 0, skipped: 0, failed: 0 };
    const failureMessages: string[] = [];
    for (const notice of due) {
      const recipient = await ctx.runQuery(
        (internal as any).apiPlanLimitEmails.getNoticeRecipient,
        { userId: notice.userId },
      ) as Recipient;

      if (!recipient.email) {
        await ctx.runMutation(
          (internal as any).apiPlanLimitNotices.markEmailStatus,
          { noticeId: notice._id, emailStatus: "skipped", emailedAt: now },
        );
        summary.skipped += 1;
        continue;
      }
      if (recipient.suppressed) {
        await ctx.runMutation(
          (internal as any).apiPlanLimitNotices.markEmailStatus,
          { noticeId: notice._id, emailStatus: "suppressed", emailedAt: now },
        );
        summary.skipped += 1;
        continue;
      }
      try {
        await sendEmail(apiKey, recipient.email, noticeSubject(notice), noticeHtml(notice));
        await ctx.runMutation(
          (internal as any).apiPlanLimitNotices.markEmailStatus,
          { noticeId: notice._id, emailStatus: "sent", emailedAt: now },
        );
        summary.sent += 1;
      } catch (err) {
        // Count the attempt so a permanently undeliverable recipient stops
        // being retried after MAX_EMAIL_ATTEMPTS (listEmailDue drops it),
        // instead of failing on every hourly scan forever.
        const attempts = (notice.emailAttempts ?? 0) + 1;
        await ctx.runMutation(
          (internal as any).apiPlanLimitNotices.markEmailStatus,
          { noticeId: notice._id, emailStatus: "failed", emailAttempts: attempts },
        );
        summary.failed += 1;
        // Only surface (and let the batch throw) while we're still retrying.
        // Once we've given up, stay quiet so the delivery cron stops erroring.
        if (attempts < MAX_EMAIL_ATTEMPTS) {
          failureMessages.push(err instanceof Error ? err.message : String(err));
        }
      }
    }
    if (failureMessages.length > 0) {
      throw new Error(
        `[apiPlanLimitEmails] ${summary.failed} email delivery failure(s): ` +
          failureMessages.slice(0, MAX_FAILURE_MESSAGES).join(" | "),
      );
    }
    return summary;
  },
});
