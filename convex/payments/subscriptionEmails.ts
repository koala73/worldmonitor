/**
 * Subscription lifecycle emails via Resend.
 *
 * Scheduled from webhook mutations (handleSubscriptionActive) so email
 * delivery does not block webhook processing.
 */

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { PRODUCT_CATALOG } from "../config/productCatalog";

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
