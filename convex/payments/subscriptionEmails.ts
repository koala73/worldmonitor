/**
 * Subscription lifecycle emails via Resend.
 *
 * Scheduled from webhook mutations (handleSubscriptionActive) so email
 * delivery does not block webhook processing.
 */

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import { createCustomerPortalUrlForUser } from "./billing";

const RESEND_URL = "https://api.resend.com/emails";
const FROM = "World Monitor <noreply@worldmonitor.app>";
const ADMIN_EMAIL = "elie@worldmonitor.app";

const PLAN_DISPLAY: Record<string, string> = {
  free: "Free",
  pro_monthly: "Pro (Monthly)",
  pro_annual: "Pro (Annual)",
  api_starter: "API Starter (Monthly)",
  api_starter_annual: "API Starter (Annual)",
  api_business: "API Business",
  enterprise: "Enterprise",
};

// Allowlist for the Pro welcome shell. Anything outside this set (free, api_*,
// future tiers) falls back to the neutral "Welcome to {planName}!" shell +
// 4-card generic grid — safer than a deny-list that would silently opt-in
// every new plan key added to PLAN_DISPLAY without a matching update here.
// See `featureCardsHtml` and `userWelcomeHtml` for the parallel gates.
const PRO_PLANS = new Set(["pro_monthly", "pro_annual"]);

async function sendEmail(
  apiKey: string,
  to: string,
  subject: string,
  html: string,
  replyTo?: string,
): Promise<void> {
  // FROM is a noreply address, so the welcome email's "Reply to this email"
  // support copy only routes correctly when we explicitly set reply_to on the
  // Resend payload. Admin notifications pass no replyTo so replies don't
  // self-loop back to ADMIN_EMAIL.
  const payload: Record<string, unknown> = { from: FROM, to: [to], subject, html };
  if (replyTo) payload.reply_to = replyTo;
  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    const msg = `[subscriptionEmails] Resend ${res.status}: ${body}`;
    console.error(msg);
    throw new Error(msg);
  }
}

function featureCardsHtml(planKey: string): string {
  // Pro allowlist must match the shell gate in userWelcomeHtml — otherwise a
  // `free` or unknown-tier user gets the neutral headline + "Open Dashboard"
  // CTA but still sees the 6-card Pro marketing grid below. API + unknown
  // tiers fall through to the 4-card generic grid (safe: no Pro-only claims).
  if (!PRO_PLANS.has(planKey)) {
    return `
      <tr>
        <td style="width: 50%; padding: 12px; vertical-align: top;">
          <div style="background: #111; border: 1px solid #1a1a1a; padding: 16px; height: 100%;">
            <div style="font-size: 20px; margin-bottom: 8px;">&#128273;</div>
            <div style="font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 4px;">Full API Access</div>
            <div style="font-size: 12px; color: #888; line-height: 1.4;">30+ services, one API key</div>
          </div>
        </td>
        <td style="width: 50%; padding: 12px; vertical-align: top;">
          <div style="background: #111; border: 1px solid #1a1a1a; padding: 16px; height: 100%;">
            <div style="font-size: 20px; margin-bottom: 8px;">&#9889;</div>
            <div style="font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 4px;">Near-Real-Time Data</div>
            <div style="font-size: 12px; color: #888; line-height: 1.4;">Priority pipeline with sub-60s refresh</div>
          </div>
        </td>
      </tr>
      <tr>
        <td style="width: 50%; padding: 12px; vertical-align: top;">
          <div style="background: #111; border: 1px solid #1a1a1a; padding: 16px; height: 100%;">
            <div style="font-size: 20px; margin-bottom: 8px;">&#129504;</div>
            <div style="font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 4px;">AI Analyst</div>
            <div style="font-size: 12px; color: #888; line-height: 1.4;">Morning briefs, flash alerts, pattern detection</div>
          </div>
        </td>
        <td style="width: 50%; padding: 12px; vertical-align: top;">
          <div style="background: #111; border: 1px solid #1a1a1a; padding: 16px; height: 100%;">
            <div style="font-size: 20px; margin-bottom: 8px;">&#128232;</div>
            <div style="font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 4px;">Multi-Channel Alerts</div>
            <div style="font-size: 12px; color: #888; line-height: 1.4;">Slack, Telegram, WhatsApp, Email, Discord</div>
          </div>
        </td>
      </tr>`;
  }
  // Pro plans: signature-first grid — leads with WM Analyst, Custom Widgets, MCP
  // (the three differentiators the old email buried), followed by Brief +
  // Delivery + 50+ Panels. Source of truth: docs/plans/pro-welcome-email-playground.html.
  return `
      <tr>
        <td style="width: 50%; padding: 12px; vertical-align: top;">
          <div style="background: #111; border: 1px solid #1a1a1a; padding: 16px; height: 100%;">
            <div style="font-size: 20px; margin-bottom: 8px;">&#129302;</div>
            <div style="font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 4px;">WM Analyst</div>
            <div style="font-size: 12px; color: #888; line-height: 1.4;">Chat with your monitor. Ask anything, get cited answers.</div>
          </div>
        </td>
        <td style="width: 50%; padding: 12px; vertical-align: top;">
          <div style="background: #111; border: 1px solid #1a1a1a; padding: 16px; height: 100%;">
            <div style="font-size: 20px; margin-bottom: 8px;">&#129513;</div>
            <div style="font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 4px;">Create Custom Widgets</div>
            <div style="font-size: 12px; color: #888; line-height: 1.4;">Describe a widget in plain English &mdash; AI builds it live.</div>
          </div>
        </td>
      </tr>
      <tr>
        <td style="width: 50%; padding: 12px; vertical-align: top;">
          <div style="background: #111; border: 1px solid #1a1a1a; padding: 16px; height: 100%;">
            <div style="font-size: 20px; margin-bottom: 8px;">&#128268;</div>
            <div style="font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 4px;">MCP Integration</div>
            <div style="font-size: 12px; color: #888; line-height: 1.4;">Connect Claude Desktop, Cursor, or any MCP client to your monitor.</div>
          </div>
        </td>
        <td style="width: 50%; padding: 12px; vertical-align: top;">
          <div style="background: #111; border: 1px solid #1a1a1a; padding: 16px; height: 100%;">
            <div style="font-size: 20px; margin-bottom: 8px;">&#9728;&#65039;</div>
            <div style="font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 4px;">Daily AI Brief</div>
            <div style="font-size: 12px; color: #888; line-height: 1.4;">Your morning intel, topic-grouped, before your coffee.</div>
          </div>
        </td>
      </tr>
      <tr>
        <td style="width: 50%; padding: 12px; vertical-align: top;">
          <div style="background: #111; border: 1px solid #1a1a1a; padding: 16px; height: 100%;">
            <div style="font-size: 20px; margin-bottom: 8px;">&#128236;</div>
            <div style="font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 4px;">Multi-Channel Delivery</div>
            <div style="font-size: 12px; color: #888; line-height: 1.4;">Slack, Telegram, WhatsApp, Email, Discord.</div>
          </div>
        </td>
        <td style="width: 50%; padding: 12px; vertical-align: top;">
          <div style="background: #111; border: 1px solid #1a1a1a; padding: 16px; height: 100%;">
            <div style="font-size: 20px; margin-bottom: 8px;">&#128208;</div>
            <div style="font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 4px;">50+ Pro Panels</div>
            <div style="font-size: 12px; color: #888; line-height: 1.4;">50+ panels across markets, geopolitics, supply chain, climate.</div>
          </div>
        </td>
      </tr>`;
}

function userWelcomeHtml(planName: string, planKey: string): string {
  const isPro = PRO_PLANS.has(planKey);
  // Pro path: headline leads with the value prop, CTA points at the brief
  // (the single highest-retention action for a new Pro). API path preserved
  // byte-for-byte from the previous template pending a separate refresh.
  // Referral block deliberately omitted — the /referrals page + credit-granting
  // logic are still Phase 9 (Todo #223). Reinstate in a follow-up once live.
  const headline = isPro
    ? `Welcome to ${planName} — your intel, delivered.`
    : `Welcome to ${planName}!`;
  const ctaLabel = isPro ? "Open My Brief" : "Open Dashboard";
  const ctaHref = isPro ? "https://worldmonitor.app/brief" : "https://worldmonitor.app";
  const supportLine = isPro
    ? `<p style="font-size: 11px; color: #666; text-align: center; margin: 0 0 20px;">Questions? Reply to this email or ping <a href="mailto:${ADMIN_EMAIL}" style="color: #4ade80;">${ADMIN_EMAIL}</a>.</p>`
    : "";
  return `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; background: #0a0a0a; color: #e0e0e0;">
  <div style="background: #4ade80; height: 4px;"></div>
  <div style="padding: 40px 32px 0;">
    <table cellpadding="0" cellspacing="0" border="0" style="margin: 0 auto 32px;">
      <tr>
        <td style="width: 40px; height: 40px; vertical-align: middle;">
          <img src="https://www.worldmonitor.app/favico/android-chrome-192x192.png" width="40" height="40" alt="WorldMonitor" style="border-radius: 50%; display: block;" />
        </td>
        <td style="padding-left: 12px;">
          <div style="font-size: 16px; font-weight: 800; color: #fff; letter-spacing: -0.5px;">WORLD MONITOR</div>
        </td>
      </tr>
    </table>

    <div style="background: #111; border: 1px solid #1a1a1a; border-left: 3px solid #4ade80; padding: 20px 24px; margin-bottom: 28px;">
      <p style="font-size: 18px; font-weight: 600; color: #fff; margin: 0 0 8px;">${headline}</p>
      <p style="font-size: 14px; color: #999; margin: 0; line-height: 1.5;">Your subscription is now active. Here's what's unlocked:</p>
    </div>

    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom: 28px;">
      ${featureCardsHtml(planKey)}
    </table>

    <div style="text-align: center; margin-bottom: 28px;">
      <a href="${ctaHref}" style="display: inline-block; background: #4ade80; color: #0a0a0a; padding: 14px 36px; text-decoration: none; font-weight: 800; font-size: 13px; text-transform: uppercase; letter-spacing: 1.5px; border-radius: 2px;">${ctaLabel}</a>
    </div>
    ${supportLine}
  </div>

  <div style="border-top: 1px solid #1a1a1a; padding: 24px 32px; text-align: center;">
    <div style="margin-bottom: 16px;">
      <a href="https://x.com/eliehabib" style="color: #666; text-decoration: none; font-size: 12px; margin: 0 12px;">X / Twitter</a>
      <a href="https://github.com/koala73/worldmonitor" style="color: #666; text-decoration: none; font-size: 12px; margin: 0 12px;">GitHub</a>
    </div>
    <p style="font-size: 11px; color: #444; margin: 0; line-height: 1.6;">
      World Monitor \u2014 Real-time intelligence for a connected world.<br />
      <a href="https://worldmonitor.app" style="color: #4ade80; text-decoration: none;">worldmonitor.app</a>
    </p>
  </div>
</div>`;
}

/**
 * Format a minor-unit amount (cents) into "$X.XX USD" / "€X.XX EUR" etc.
 * Falls back to "<amount> <currency>" if the currency lacks a known symbol.
 */
const CURRENCY_SYMBOL: Record<string, string> = {
  USD: "$", EUR: "€", GBP: "£", CAD: "$", AUD: "$", JPY: "¥", INR: "₹",
};
function formatMoney(amountMinor: number, currency: string): string {
  const cur = currency.toUpperCase();
  const symbol = CURRENCY_SYMBOL[cur] ?? "";
  // JPY (and a few others) have no minor unit — Dodo still passes integers
  // in the smallest unit, but JPY's "smallest unit" is the yen itself.
  const divisor = cur === "JPY" ? 1 : 100;
  const major = (amountMinor / divisor).toFixed(divisor === 1 ? 0 : 2);
  return symbol ? `${symbol}${major} ${cur}` : `${major} ${cur}`;
}

/**
 * Build the Amount/Discount rows for the admin notification.
 * Compares the actual recurring charge against the catalog list price to
 * surface the discount delta — that's the signal "did this user pay full
 * price or use a code", which the raw subscription_id never communicated.
 */
function buildPriceRowsHtml(args: {
  planKey: string;
  recurringPreTaxAmount?: number;
  currency?: string;
  taxInclusive?: boolean;
  discountId?: string;
}): string {
  const rows: string[] = [];
  const currency = args.currency ?? "USD";
  const paid = args.recurringPreTaxAmount;
  const listCents = PRODUCT_CATALOG[args.planKey]?.priceCents;

  if (typeof paid === "number") {
    const taxNote = args.taxInclusive ? " (tax incl.)" : " (pre-tax)";
    rows.push(
      `<tr><td style="color: #888; padding-right: 16px;">Amount Paid:</td><td style="color: #fff;">${formatMoney(paid, currency)}${taxNote}</td></tr>`,
    );
    // List Price / Saved comparison is USD-only. PRODUCT_CATALOG.priceCents is
    // hard-coded in USD, so subtracting it from a non-USD `paid` (Dodo's
    // adaptive-currency mode bills EUR/GBP/etc.) would produce a meaningless
    // delta with the wrong currency label. Skip the comparison rows in that
    // case rather than show misleading numbers — Amount Paid + Discount are
    // still rendered.
    if (
      currency.toUpperCase() === "USD" &&
      typeof listCents === "number" &&
      listCents > 0 &&
      listCents !== paid
    ) {
      const savedCents = listCents - paid;
      const pct = Math.round((savedCents / listCents) * 100);
      rows.push(
        `<tr><td style="color: #888; padding-right: 16px;">List Price:</td><td style="color: #fff;">${formatMoney(listCents, currency)}</td></tr>`,
      );
      if (savedCents > 0) {
        rows.push(
          `<tr><td style="color: #888; padding-right: 16px;">Saved:</td><td style="color: #4ade80;">${formatMoney(savedCents, currency)} (${pct}% off)</td></tr>`,
        );
      }
    }
  }
  if (args.discountId) {
    rows.push(
      `<tr><td style="color: #888; padding-right: 16px;">Discount:</td><td style="color: #fff; font-size: 12px;">${args.discountId}</td></tr>`,
    );
  }
  return rows.join("");
}

/**
 * Send welcome email to user + admin notification on new subscription.
 * Scheduled from handleSubscriptionActive via ctx.scheduler.
 */
export const sendSubscriptionEmails = internalAction({
  args: {
    userEmail: v.string(),
    planKey: v.string(),
    userId: v.string(),
    // Optional: previously rendered as a "Subscription:" row in the admin
    // email, now dropped (opaque sub_… IDs were never the question being
    // answered when the email landed). Kept as v.optional so any in-flight
    // scheduled action enqueued before this deploy still validates on retry.
    subscriptionId: v.optional(v.string()),
    recurringPreTaxAmount: v.optional(v.number()),
    currency: v.optional(v.string()),
    taxInclusive: v.optional(v.boolean()),
    discountId: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.error("[subscriptionEmails] RESEND_API_KEY not set");
      return;
    }

    const planName = PLAN_DISPLAY[args.planKey] ?? args.planKey;

    // 1. Welcome email to user. reply_to routes "Reply to this email" (in the
    // Pro support line) to ADMIN_EMAIL — FROM is noreply@ and Gmail honours
    // Reply-To over From when both are present.
    await sendEmail(
      apiKey,
      args.userEmail,
      `Welcome to World Monitor ${planName}`,
      userWelcomeHtml(planName, args.planKey),
      ADMIN_EMAIL,
    );
    console.log(`[subscriptionEmails] Welcome email sent to ${args.userEmail}`);

    // 2. Admin notification — leads with what the user actually paid (and how
    // it compares to list price) instead of the opaque subscription_id, which
    // is rarely the question being asked when this email lands.
    const priceRows = buildPriceRowsHtml({
      planKey: args.planKey,
      recurringPreTaxAmount: args.recurringPreTaxAmount,
      currency: args.currency,
      taxInclusive: args.taxInclusive,
      discountId: args.discountId,
    });
    await sendEmail(
      apiKey,
      ADMIN_EMAIL,
      `[WM] New User Subscribed to ${planName}`,
      `<div style="font-family: monospace; padding: 20px; background: #0a0a0a; color: #e0e0e0;">
        <p style="color: #4ade80; font-size: 16px; font-weight: bold;">New Subscription</p>
        <table style="font-size: 14px; line-height: 1.8;">
          <tr><td style="color: #888; padding-right: 16px;">Plan:</td><td style="color: #fff;">${planName}</td></tr>
          <tr><td style="color: #888; padding-right: 16px;">Email:</td><td style="color: #fff;">${args.userEmail}</td></tr>
          ${priceRows}
          <tr><td style="color: #888; padding-right: 16px;">User ID:</td><td style="color: #fff; font-size: 12px;">${args.userId}</td></tr>
        </table>
      </div>`,
    );
    console.log(`[subscriptionEmails] Admin notification sent for ${args.userEmail}`);
  },
});

// ===========================================================================
// Dunning + winback lifecycle (#4932)
//
// on_hold (payment failed):  day-0 email scheduled by the webhook handler,
// day-3 and day-7 reminders scheduled by the daily cron scan. Every send is
// re-validated against live state (still on_hold, same episode, recipient
// not suppressed, step not already sent) so recovery/replay races are safe.
//
// cancelled: one winback email ~30 days after ACCESS ends (currentPeriodEnd
// — not cancelledAt: an annual who cancels months early must still get it
// once access actually lapses), and only if the user has no other covering
// subscription. Window-capped at 60 days so the first deploy doesn't
// mass-mail historic churn.
// ===========================================================================

const DAY_MS = 86_400_000;
export const DUNNING_DAY3_AGE_MS = 3 * DAY_MS;
export const DUNNING_DAY7_AGE_MS = 7 * DAY_MS;
// Winback window bounds, measured from currentPeriodEnd (access end).
export const WINBACK_MIN_AGE_MS = 30 * DAY_MS;
export const WINBACK_MAX_AGE_MS = 60 * DAY_MS;

const DASHBOARD_URL = "https://www.worldmonitor.app/dashboard";
const PRICING_URL = "https://www.worldmonitor.app/pro#pricing";

// Resend caps at 10 requests/second. TWO complementary layers keep dunning
// under it:
//
//   1. runDunningScan staggers each send's START by SEND_SPACING_MS (below).
//      This spreads the upstream Dodo portal-mint load and the initial Resend
//      load, and keeps reserveResendSlot contention low.
//   2. The actual Resend POST happens AFTER a variable-latency Dodo portal-mint
//      (createCustomerPortalUrlForUser), so staggering START times does NOT by
//      itself bound the POST rate — portal-latency jitter can bunch several
//      POSTs into the same instant and recreate the burst. So immediately
//      before the POST, every send reserves a monotonic slot from a shared
//      token bucket (reserveResendSlot) and waits for it. Slots are handed out
//      >= SEND_SPACING_MS apart, so actual POSTs stay >= SEND_SPACING_MS apart
//      regardless of portal latency.
//
// Original bug (WORLDMONITOR-VH): sends were scheduled at runAfter(0) and burst
// concurrently; the 11th+ threw an uncaught 429 out of sendEmail, and since the
// throw precedes the ledger write those rows re-burst next tick and compounded.
// The cadence is daily and non-urgent, so spreading a batch over a few seconds
// (250ms => <=4/s) is inconsequential.
export const SEND_SPACING_MS = 250;

// Shared-cursor key in the generic `counters` table: the epoch-ms timestamp of
// the next free Resend send slot for the dunning/winback fleet.
const RESEND_SLOT_COUNTER = "dunning_resend_next_slot";

const dunningStepValidator = v.union(
  v.literal("dunning_day0"),
  v.literal("dunning_day3"),
  v.literal("dunning_day7"),
  v.literal("winback_day30"),
);
type DunningStep = "dunning_day0" | "dunning_day3" | "dunning_day7" | "winback_day30";

/** Everything the send action needs to decide + address one email. */
export const getDunningContext = internalQuery({
  args: { dodoSubscriptionId: v.string() },
  handler: async (ctx, args) => {
    const sub = await ctx.db
      .query("subscriptions")
      .withIndex("by_dodoSubscriptionId", (q) =>
        q.eq("dodoSubscriptionId", args.dodoSubscriptionId),
      )
      .unique();
    if (!sub) return null;

    // Recipient resolution mirrors the portal's trust order: the sub's own
    // rawPayload email first (per-Clerk-userId by construction), then the
    // customers row for the SAME userId (see billing.ts on why customers
    // rows can race across Clerk accounts — same-userId lookup only).
    const rawEmail = (sub.rawPayload as { customer?: { email?: string } } | null)
      ?.customer?.email;
    let email = typeof rawEmail === "string" && rawEmail.includes("@") ? rawEmail : "";
    if (!email) {
      const customer = await ctx.db
        .query("customers")
        .withIndex("by_userId", (q) => q.eq("userId", sub.userId))
        .first();
      email = customer?.email ?? "";
    }

    // Winback guard: skip users who are still covered by any OTHER sub.
    // "Live" mirrors the entitlement recompute's coverage definition:
    // active, on_hold, or cancelled-but-paid-through — a user with an
    // ended monthly sub plus a cancelled annual that runs another 8 months
    // is still entitled and must NOT get "your access has ended" (PR #4935
    // review round 2, finding 2).
    const now = Date.now();
    const siblingSubs = await ctx.db
      .query("subscriptions")
      .withIndex("by_userId", (q) => q.eq("userId", sub.userId))
      .collect();
    const hasLiveSub = siblingSubs.some(
      (s) =>
        s.dodoSubscriptionId !== sub.dodoSubscriptionId &&
        (s.status === "active" ||
          s.status === "on_hold" ||
          (s.status === "cancelled" && s.currentPeriodEnd > now)),
    );

    // Entitlement coverage beyond subscriptions (PR #4935 review round 4):
    // the recompute preserves a standing comp floor (entitlements.compUntil)
    // and its validUntil is the max over ALL coverage sources — a comped
    // user with an ended subscription is still entitled and must not get
    // "your access has ended".
    const entitlement = await ctx.db
      .query("entitlements")
      .withIndex("by_userId", (q) => q.eq("userId", sub.userId))
      .first();
    const entitlementCoveredUntil = Math.max(
      entitlement?.validUntil ?? 0,
      entitlement?.compUntil ?? 0,
    );

    return {
      userId: sub.userId,
      planKey: sub.planKey,
      status: sub.status,
      episodeAnchor: sub.onHoldAt ?? sub.updatedAt,
      cancelledAt: sub.cancelledAt ?? null,
      currentPeriodEnd: sub.currentPeriodEnd,
      email: email.trim(),
      hasLiveSub,
      entitlementCoveredUntil,
    };
  },
});

export const wasDunningStepSent = internalQuery({
  args: {
    dodoSubscriptionId: v.string(),
    step: dunningStepValidator,
    episodeAt: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("dunningEmails")
      .withIndex("by_sub_step_episode", (q) =>
        q
          .eq("dodoSubscriptionId", args.dodoSubscriptionId)
          .eq("step", args.step)
          .eq("episodeAt", args.episodeAt),
      )
      .first();
    return row !== null;
  },
});

export const recordDunningStepSent = internalMutation({
  args: {
    dodoSubscriptionId: v.string(),
    step: dunningStepValidator,
    episodeAt: v.number(),
    email: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("dunningEmails", {
      dodoSubscriptionId: args.dodoSubscriptionId,
      step: args.step,
      episodeAt: args.episodeAt,
      email: args.email,
      sentAt: Date.now(),
    });
  },
});

function dunningEmailShell(headline: string, bodyHtml: string, ctaLabel: string, ctaHref: string, footerNote: string): string {
  return `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; background: #0a0a0a; color: #e0e0e0;">
  <div style="background: #f59e0b; height: 4px;"></div>
  <div style="padding: 40px 32px 0;">
    <table cellpadding="0" cellspacing="0" border="0" style="margin: 0 auto 32px;">
      <tr>
        <td style="width: 40px; height: 40px; vertical-align: middle;">
          <img src="https://www.worldmonitor.app/favico/android-chrome-192x192.png" width="40" height="40" alt="WorldMonitor" style="border-radius: 50%; display: block;" />
        </td>
        <td style="padding-left: 12px;">
          <div style="font-size: 16px; font-weight: 800; color: #fff; letter-spacing: -0.5px;">WORLD MONITOR</div>
        </td>
      </tr>
    </table>
    <div style="background: #111; border: 1px solid #1a1a1a; border-left: 3px solid #f59e0b; padding: 20px 24px; margin-bottom: 28px;">
      <p style="font-size: 18px; font-weight: 600; color: #fff; margin: 0 0 8px;">${headline}</p>
      ${bodyHtml}
    </div>
    <div style="text-align: center; margin-bottom: 28px;">
      <a href="${ctaHref}" style="display: inline-block; background: #f59e0b; color: #0a0a0a; padding: 14px 36px; text-decoration: none; font-weight: 800; font-size: 13px; text-transform: uppercase; letter-spacing: 1.5px; border-radius: 2px;">${ctaLabel}</a>
    </div>
    <p style="font-size: 11px; color: #666; text-align: center; margin: 0 0 20px;">Questions? Reply to this email or ping <a href="mailto:${ADMIN_EMAIL}" style="color: #f59e0b;">${ADMIN_EMAIL}</a>.</p>
  </div>
  <div style="border-top: 1px solid #1a1a1a; padding: 24px 32px; text-align: center;">
    <p style="font-size: 11px; color: #444; margin: 0; line-height: 1.6;">
      ${footerNote}<br />
      <a href="https://worldmonitor.app" style="color: #f59e0b; text-decoration: none;">worldmonitor.app</a>
    </p>
  </div>
</div>`;
}

/**
 * Subject + body per step. Exported for tests (subject strings are the
 * cheapest stable assertion surface for "which step went out").
 */
export function buildDunningEmail(
  step: DunningStep,
  planName: string,
  ctaUrl: string,
): { subject: string; html: string } {
  switch (step) {
    case "dunning_day0":
      return {
        subject: `Your World Monitor payment failed — access continues while you fix it`,
        html: dunningEmailShell(
          "Your latest payment didn't go through.",
          `<p style="font-size: 14px; color: #999; margin: 0; line-height: 1.5;">Your ${planName} subscription is paused because the last charge failed — usually an expired card or a bank decline. Your access continues for now: update your payment method and the subscription resumes automatically. No new checkout needed.</p>`,
          "Update payment method",
          ctaUrl,
          "You're receiving this because a payment on your World Monitor subscription failed.",
        ),
      };
    case "dunning_day3":
      return {
        subject: `Reminder: update your payment method to keep ${planName}`,
        html: dunningEmailShell(
          "Still paused — 2 minutes to fix.",
          `<p style="font-size: 14px; color: #999; margin: 0; line-height: 1.5;">Your ${planName} payment is still failing. Once your paid period ends, briefs, alerts and your Pro panels stop. Updating your card takes about two minutes and restores everything instantly.</p>`,
          "Update payment method",
          ctaUrl,
          "You're receiving this because a payment on your World Monitor subscription failed.",
        ),
      };
    case "dunning_day7":
      return {
        subject: `Final notice: your World Monitor ${planName} subscription is paused`,
        html: dunningEmailShell(
          "Last reminder from us.",
          `<p style="font-size: 14px; color: #999; margin: 0; line-height: 1.5;">This is the last email about this — your ${planName} subscription has been paused for a week over a failed payment. Update your payment method to keep your briefs, alerts and dashboards; otherwise access ends with your paid period.</p>`,
          "Update payment method",
          ctaUrl,
          "This is the final payment reminder for this billing episode — we won't email about it again.",
        ),
      };
    case "winback_day30":
      return {
        subject: `Your World Monitor ${planName} access has ended — rejoin in one click`,
        html: dunningEmailShell(
          "The map kept running. You're missed.",
          `<p style="font-size: 14px; color: #999; margin: 0; line-height: 1.5;">Your ${planName} subscription ended about a month ago. The briefs, WM Analyst and your alert rules are exactly where you left them — rejoining takes one click and your setup is restored.</p>`,
          "Rejoin World Monitor",
          ctaUrl,
          "This is a one-time note — we won't send more emails about this subscription.",
        ),
      };
  }
}

/**
 * Deliver one dunning/winback step. Defensive by design: every precondition
 * is re-checked at send time because this action runs detached (scheduler /
 * cron) and the subscription may have recovered, been cancelled, or been
 * re-held (new episode) since it was scheduled.
 */
/**
 * Token-bucket pacer for Resend POSTs across the whole dunning/winback fleet.
 *
 * Returns the epoch-ms instant at which the caller may perform its Resend POST.
 * sendDunningEmail calls this immediately before the send and waits until the
 * returned slot, so concurrent sends POST >= SEND_SPACING_MS apart no matter how
 * their upstream Dodo portal-mint latency varies. Single-row OCC makes
 * concurrent reservations serialize, so no two callers get overlapping slots.
 * The cursor floors at `now`, so after any idle gap the next send fires
 * immediately instead of sleeping toward a stale future slot.
 */
export const reserveResendSlot = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const row = await ctx.db
      .query("counters")
      .withIndex("by_name", (q) => q.eq("name", RESEND_SLOT_COUNTER))
      .unique();
    const now = Date.now();
    const slotAt = Math.max(now, row?.value ?? 0);
    const nextSlotAt = slotAt + SEND_SPACING_MS;
    if (row) await ctx.db.patch(row._id, { value: nextSlotAt });
    else await ctx.db.insert("counters", { name: RESEND_SLOT_COUNTER, value: nextSlotAt });
    return slotAt;
  },
});

/**
 * The wait (ms) a send owes before its reserved Resend slot. Deliberately
 * UNCAPPED: a large legitimate backlog reserves proportionally distant slots, so
 * clamping the wait would let the tail — every reservation past cap/SEND_SPACING_MS
 * — wake together and re-burst, the exact collapse a fixed ceiling caused
 * (WORLDMONITOR-VH re-review P2). Safe to leave uncapped because
 * `counters[RESEND_SLOT_COUNTER]` is single-writer (reserveResendSlot only) and
 * only ever advances by SEND_SPACING_MS, so it can never be corruptly far in the
 * future — there is no runaway state to defend against. Exported for testing.
 */
export function resendPacingWaitMs(slotAt: number, now: number): number {
  return Math.max(0, slotAt - now);
}

export const sendDunningEmail = internalAction({
  args: {
    dodoSubscriptionId: v.string(),
    step: dunningStepValidator,
    episodeAt: v.number(),
  },
  handler: async (ctx, args) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.error("[dunning] RESEND_API_KEY not set — skipping");
      return { sent: false, reason: "no_api_key" as const };
    }

    const sub = await ctx.runQuery(
      internal.payments.subscriptionEmails.getDunningContext,
      { dodoSubscriptionId: args.dodoSubscriptionId },
    );
    if (!sub) return { sent: false, reason: "unknown_subscription" as const };

    if (args.step === "winback_day30") {
      // Winback only for genuinely-gone users: still cancelled, paid period
      // actually over, and no other covering subscription on the account.
      if (sub.status !== "cancelled") return { sent: false, reason: "not_cancelled" as const };
      // Same stale-episode discipline as dunning (PR #4935 review round 2,
      // finding 1): a pending winback scheduled for cancellation T1 must not
      // fire after the row moved to a different cancellation episode T2 —
      // the T2 window gets its own ledger entry and its own single send.
      if (sub.cancelledAt !== args.episodeAt) return { sent: false, reason: "stale_episode" as const };
      if (sub.currentPeriodEnd > Date.now()) return { sent: false, reason: "still_entitled" as const };
      // Comp floor / recomputed entitlement window (round-4 F5): a comped
      // user is covered even with every subscription ended.
      if (sub.entitlementCoveredUntil > Date.now()) return { sent: false, reason: "still_entitled" as const };
      if (sub.hasLiveSub) return { sent: false, reason: "resubscribed" as const };
    } else {
      // Dunning only while THIS episode is still open — a recovery or a
      // newer episode (different anchor) invalidates the scheduled send.
      if (sub.status !== "on_hold") return { sent: false, reason: "recovered" as const };
      if (sub.episodeAnchor !== args.episodeAt) return { sent: false, reason: "stale_episode" as const };
    }

    if (!sub.email) {
      console.warn(`[dunning] no resolvable email for ${args.dodoSubscriptionId} — skipping ${args.step}`);
      return { sent: false, reason: "no_email" as const };
    }

    const suppressed = await ctx.runQuery(internal.emailSuppressions.isEmailSuppressed, {
      email: sub.email,
    });
    if (suppressed) return { sent: false, reason: "suppressed" as const };

    const alreadySent = await ctx.runQuery(
      internal.payments.subscriptionEmails.wasDunningStepSent,
      args,
    );
    if (alreadySent) return { sent: false, reason: "already_sent" as const };

    // CTA: a freshly minted Dodo portal session for dunning (card update is
    // the whole point); pricing page for winback. Portal minting can fail
    // (no customer id, Dodo error) — fall back to the dashboard, where the
    // payment-failure banner routes to the same portal after sign-in.
    let ctaUrl = args.step === "winback_day30" ? PRICING_URL : DASHBOARD_URL;
    if (args.step !== "winback_day30") {
      try {
        ctaUrl = (await createCustomerPortalUrlForUser(ctx, sub.userId)).portal_url;
      } catch (err) {
        // Designed degradation, not a failure (Sentry-coverage gate: no
        // warn without capture; convex has no silent-capture helper and
        // throwing here would kill the send). NO_CUSTOMER rows and Dodo
        // hiccups land on the dashboard CTA, where the payment-failure
        // banner reaches the same portal after sign-in. Greppable in
        // Convex logs via the [dunning] prefix if it starts recurring.
        console.log(
          `[dunning] portal mint failed for ${args.dodoSubscriptionId} (${err instanceof Error ? err.message : String(err)}) — falling back to dashboard CTA`,
        );
      }
    }

    const planName = PLAN_DISPLAY[sub.planKey] ?? sub.planKey;
    const { subject, html } = buildDunningEmail(args.step, planName, ctaUrl);
    // Pace the actual POST (not just the scheduled start): the portal mint above
    // has variable latency, so reserve the Resend slot HERE — after the mint —
    // and wait for it. This bounds the true POST rate to <= 1/SEND_SPACING_MS
    // even when portal jitter bunches start-staggered sends together, which
    // start-time staggering alone can't guarantee (review follow-up to
    // WORLDMONITOR-VH). The wait is intentionally uncapped (see resendPacingWaitMs)
    // so a large backlog stays serialized instead of collapsing into a burst.
    const slotAt = await ctx.runMutation(
      internal.payments.subscriptionEmails.reserveResendSlot,
      {},
    );
    const waitMs = resendPacingWaitMs(slotAt, Date.now());
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    await sendEmail(apiKey, sub.email, subject, html, ADMIN_EMAIL);
    // Ledger write AFTER the send: a Resend failure throws above, leaving no
    // row, so the next cron tick retries. The narrow crash window between
    // send and record risks one duplicate email — the right side to err on.
    // Corollary: dedup is BEST-EFFORT, not exactly-once — two concurrent
    // invocations for the same (sub, step, episode) (e.g. an operator-run
    // scan overlapping the cron) can both pass wasDunningStepSent before
    // either records. Acceptable at a daily cadence; record-then-send would
    // trade it for silently never sending on a crash, which is worse.
    await ctx.runMutation(internal.payments.subscriptionEmails.recordDunningStepSent, {
      ...args,
      email: sub.email,
    });
    console.log(`[dunning] sent ${args.step} for ${args.dodoSubscriptionId}`);
    return { sent: true as const };
  },
});

/**
 * Daily cron: schedule every due, unsent dunning/winback step.
 *
 * At most ONE step per subscription per tick (the latest due one), so a
 * subscription that entered on_hold before this feature deployed gets a
 * single catch-up email, never a day-3 + day-7 double-send. Pre-existing
 * rows without `onHoldAt` anchor on `updatedAt` (their last on_hold event).
 */
export const runDunningScan = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due: Array<{ dodoSubscriptionId: string; step: DunningStep; episodeAt: number }> = [];

    const onHold = await ctx.db
      .query("subscriptions")
      .withIndex("by_status", (q) => q.eq("status", "on_hold"))
      .collect();
    for (const sub of onHold) {
      const episodeAt = sub.onHoldAt ?? sub.updatedAt;
      const age = now - episodeAt;
      const step: DunningStep | null =
        age >= DUNNING_DAY7_AGE_MS ? "dunning_day7"
        : age >= DUNNING_DAY3_AGE_MS ? "dunning_day3"
        : null;
      if (step) due.push({ dodoSubscriptionId: sub.dodoSubscriptionId, step, episodeAt });
    }

    // Range-read ONLY the winback window via the compound index — cancelled
    // is an accumulating terminal status, and a bare collect() over it would
    // eventually blow Convex's per-transaction read cap and kill the whole
    // scan (PR #4935 review finding 2). The window is measured from
    // currentPeriodEnd (ACCESS end), not cancelledAt, so annual subscribers
    // who cancel months before expiry become eligible once their access
    // actually lapses instead of never (review round 2, finding 3).
    const cancelled = await ctx.db
      .query("subscriptions")
      .withIndex("by_status_currentPeriodEnd", (q) =>
        q
          .eq("status", "cancelled")
          .gte("currentPeriodEnd", now - WINBACK_MAX_AGE_MS)
          .lte("currentPeriodEnd", now - WINBACK_MIN_AGE_MS),
      )
      .collect();
    for (const sub of cancelled) {
      // cancelledAt is the episode identity (matches the send action's
      // stale-episode guard). Rows without it are legacy pre-cancelledAt
      // data with no stable episode key — skip rather than anchor on the
      // drift-prone updatedAt.
      if (sub.cancelledAt === undefined) continue;
      due.push({ dodoSubscriptionId: sub.dodoSubscriptionId, step: "winback_day30", episodeAt: sub.cancelledAt });
    }

    let scheduled = 0;
    for (const item of due) {
      // Ledger pre-check keeps the steady-state tick write-free; the send
      // action re-checks anyway, so a race here only costs a no-op action.
      const existing = await ctx.db
        .query("dunningEmails")
        .withIndex("by_sub_step_episode", (q) =>
          q
            .eq("dodoSubscriptionId", item.dodoSubscriptionId)
            .eq("step", item.step)
            .eq("episodeAt", item.episodeAt),
        )
        .first();
      if (existing) continue;
      // Stagger to stay under Resend's 10 req/s limit (see SEND_SPACING_MS):
      // `scheduled` is the running index, so sends fire at 0ms, 250ms, 500ms, ...
      await ctx.scheduler.runAfter(
        scheduled * SEND_SPACING_MS,
        internal.payments.subscriptionEmails.sendDunningEmail,
        item,
      );
      scheduled += 1;
    }

    console.log(
      `[dunning] scan: ${onHold.length} on_hold, ${cancelled.length} cancelled, ${scheduled} sends scheduled`,
    );
    return { onHold: onHold.length, cancelled: cancelled.length, scheduled };
  },
});
