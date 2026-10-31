/**
 * Subscription lifecycle emails via Resend.
 *
 * Scheduled from webhook mutations (handleSubscriptionActive) so email
 * delivery does not block webhook processing.
 */

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import { buildCancellationConfirmEmail } from "./cancellationEmailCopy";
import { signDunningPortalToken } from "../lib/identitySigning";
import { buildUnsubscribeUrl, listUnsubscribeHeaders } from "../lib/emailUnsubscribe";
import { ResendSendError, sendResendEmail, type EmailPurpose } from "../lib/resendEmail";
import {
  billingDeletionForEvent,
  billingDeletionForUser,
  isCancellationScheduled,
  isCoveringAt,
  resolveBillingRecipient,
} from "./subscriptionHelpers";

export { formatAccessEndDate } from "./cancellationEmailCopy";

const FROM = "World Monitor <noreply@worldmonitor.app>";
// Marketing sender (audit check 4): winback is a marketing email, so it goes
// from news@ like the launch broadcast, with a one-click unsubscribe.
const MARKETING_FROM = "World Monitor <news@worldmonitor.app>";
const ADMIN_EMAIL = "elie@worldmonitor.app";

const PLAN_DISPLAY: Record<string, string> = {
  free: "Free",
  pro_monthly: "Pro (Monthly)",
  pro_annual: "Pro (Annual)",
  pro_business_monthly: "Pro Business (Monthly)",
  pro_business_annual: "Pro Business (Annual)",
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
const PRO_PLANS = new Set([
  "pro_monthly",
  "pro_annual",
  "pro_business_monthly",
  "pro_business_annual",
]);

/**
 * All lifecycle mail goes through the shared Resend helper, which checks the
 * local suppression table before every POST (welcome, reactivation and the
 * sign-in pointer used to skip it). FROM is a noreply address, so
 * customer-facing sends pass ADMIN_EMAIL as reply_to: the "Reply to this
 * email" support copy only routes correctly with an explicit reply_to. Admin
 * notifications pass `replyTo: null` so replies don't self-loop back to
 * ADMIN_EMAIL. Returns false when the recipient is suppressed.
 */
async function sendEmail(
  ctx: Pick<ActionCtx, "runQuery">,
  apiKey: string,
  to: string,
  subject: string,
  html: string,
  options: { replyTo: string | null; purpose?: EmailPurpose; from?: string; headers?: Record<string, string> },
): Promise<boolean> {
  try {
    const result = await sendResendEmail(ctx, {
      apiKey,
      from: options.from ?? FROM,
      to,
      subject,
      html,
      replyTo: options.replyTo,
      purpose: options.purpose ?? "transactional",
      headers: options.headers,
    });
    return result.sent;
  } catch (err) {
    const msg = err instanceof ResendSendError
      ? `[subscriptionEmails] Resend ${err.status}: ${err.body}`
      : `[subscriptionEmails] Resend request failed: ${err instanceof Error ? err.message : String(err)}`;
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

/**
 * Minimal HTML-escape for user-influenced strings (email addresses) that get
 * interpolated into email markup. Addresses come from Clerk identities and
 * buyer-typed Dodo checkout fields — treat both as untrusted display text.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Mask a login address for disclosure to the UNVERIFIED checkout inbox:
 * "login@example.com" → "l•••@example.com". Recognizable to its owner,
 * useless to a stranger who received the pointer because the buyer typo'd
 * the checkout address. The full address is only ever written to the login
 * inbox itself and to the admin alert.
 */
function maskEmail(address: string): string {
  const at = address.indexOf("@");
  if (at <= 1) return address;
  return `${address[0]}•••${address.slice(at)}`;
}

/**
 * Best-effort sign-in pointer to the checkout inbox (#6330). The buyer typed
 * this address at checkout and demonstrably watches it (it also receives the
 * Dodo receipt) — without this, the only inbox they may check goes silent
 * while the welcome lands somewhere they may not think to look. The address
 * is buyer-typed and may be one Resend rejects outright (typo'd domain), so
 * a failure here must never propagate — log and continue.
 */
async function sendSignInPointer(
  ctx: Pick<ActionCtx, "runQuery">,
  apiKey: string,
  checkoutEmail: string,
  loginEmail: string,
  planName: string,
): Promise<void> {
  try {
    const sent = await sendEmail(
      ctx,
      apiKey,
      checkoutEmail,
      `Your World Monitor subscription is active — where to sign in`,
      `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; background: #0a0a0a; color: #e0e0e0;">
        <div style="background: #4ade80; height: 4px;"></div>
        <div style="padding: 40px 32px;">
          <p style="font-size: 22px; font-weight: 700; color: #fff; margin: 0 0 12px;">Payment received — you're all set.</p>
          <p style="font-size: 14px; color: #999; line-height: 1.5; margin: 0 0 12px;">Your ${planName} subscription is active. This address (${escapeHtml(checkoutEmail)}) is the billing contact for the subscription.</p>
          <p style="font-size: 14px; color: #999; line-height: 1.5; margin: 0 0 24px;">To open your dashboard, sign in with <strong style="color: #fff;">${escapeHtml(maskEmail(loginEmail))}</strong> — your sign-in code will arrive in that inbox.</p>
          <div style="text-align: center;">
            <a href="https://worldmonitor.app" style="display: inline-block; background: #4ade80; color: #0a0a0a; padding: 14px 36px; text-decoration: none; font-weight: 800; font-size: 13px; text-transform: uppercase; letter-spacing: 1.5px; border-radius: 2px;">Open World Monitor</a>
          </div>
          <p style="font-size: 11px; color: #666; text-align: center; margin: 24px 0 0;">Questions? Reply to this email or contact ${ADMIN_EMAIL}.</p>
        </div>
      </div>`,
      { replyTo: ADMIN_EMAIL },
    );
    if (sent) console.log(`[subscriptionEmails] Sign-in pointer sent to checkout address`);
  } catch (err) {
    console.error(
      `[subscriptionEmails] Sign-in pointer to checkout address failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function userWelcomeHtml(planName: string, planKey: string, signInEmail?: string): string {
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
  const ctaHref = isPro ? "https://www.worldmonitor.app/dashboard" : "https://www.worldmonitor.app";
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
      ${
        signInEmail
          ? `<p style="font-size: 13px; color: #999; margin: 12px 0 0; line-height: 1.5;">Sign in with <strong style="color: #fff;">${escapeHtml(signInEmail)}</strong> — the address you entered at checkout is kept as your billing contact.</p>`
          : ""
      }
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
export const canSendBillingEmail = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => !(await billingDeletionForUser(ctx, args.userId)),
});

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
    // #6330: set only when the Dodo checkout email differs from the login
    // email in `userEmail`. Adds the sign-in line to the welcome, a pointer
    // email to the checkout inbox, and the Billing Email row for admin.
    checkoutEmail: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const canSend = () => ctx.runQuery(internal.payments.subscriptionEmails.canSendBillingEmail, { userId: args.userId });
    if (!await canSend()) return;
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.error("[subscriptionEmails] RESEND_API_KEY not set");
      return;
    }

    const planName = PLAN_DISPLAY[args.planKey] ?? args.planKey;

    // Each of the three sends is independently guarded: a rejection or outage
    // on any one of them must not swallow the others. A scheduled
    // internalAction is not auto-retried, so an unguarded throw is a permanent
    // loss of everything sequenced after it — the welcome (customer), the
    // pointer (customer's checkout inbox), and the admin alert (the only ops
    // signal that a paid conversion happened) each matter on their own.

    // 1. Welcome email to user. reply_to routes "Reply to this email" (in the
    // Pro support line) to ADMIN_EMAIL — FROM is noreply@ and Gmail honours
    // Reply-To over From when both are present.
    try {
      const sent = await sendEmail(
        ctx,
        apiKey,
        args.userEmail,
        `Welcome to World Monitor ${planName}`,
        userWelcomeHtml(planName, args.planKey, args.checkoutEmail ? args.userEmail : undefined),
        { replyTo: ADMIN_EMAIL },
      );
      if (sent) console.log(`[subscriptionEmails] Welcome email sent to ${args.userEmail}`);
    } catch (err) {
      console.error(
        `[subscriptionEmails] Welcome email failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 1b. Sign-in pointer to the checkout inbox (#6330) — see sendSignInPointer.
    if (!await canSend()) return;
    if (args.checkoutEmail) {
      await sendSignInPointer(ctx, apiKey, args.checkoutEmail, args.userEmail, planName);
    }

    // 2. Admin notification — leads with what the user actually paid (and how
    // it compares to list price) instead of the opaque subscription_id, which
    // is rarely the question being asked when this email lands.
    if (!await canSend()) return;
    const priceRows = buildPriceRowsHtml({
      planKey: args.planKey,
      recurringPreTaxAmount: args.recurringPreTaxAmount,
      currency: args.currency,
      taxInclusive: args.taxInclusive,
      discountId: args.discountId,
    });
    try {
      await sendEmail(
        ctx,
        apiKey,
        ADMIN_EMAIL,
        `[WM] New User Subscribed to ${planName}`,
        `<div style="font-family: monospace; padding: 20px; background: #0a0a0a; color: #e0e0e0;">
        <p style="color: #4ade80; font-size: 16px; font-weight: bold;">New Subscription</p>
        <table style="font-size: 14px; line-height: 1.8;">
          <tr><td style="color: #888; padding-right: 16px;">Plan:</td><td style="color: #fff;">${planName}</td></tr>
          <tr><td style="color: #888; padding-right: 16px;">Email:</td><td style="color: #fff;">${escapeHtml(args.userEmail)}</td></tr>
          ${args.checkoutEmail ? `<tr><td style="color: #888; padding-right: 16px;">Billing Email:</td><td style="color: #fff;">${escapeHtml(args.checkoutEmail)}</td></tr>` : ""}
          ${priceRows}
          <tr><td style="color: #888; padding-right: 16px;">User ID:</td><td style="color: #fff; font-size: 12px;">${escapeHtml(args.userId)}</td></tr>
        </table>
      </div>`,
        { replyTo: null },
      );
      console.log(`[subscriptionEmails] Admin notification sent for ${args.userEmail}`);
    } catch (err) {
      console.error(
        `[subscriptionEmails] Admin notification failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
});

/**
 * Confirm a subscription.active transition that restored a previously
 * non-active subscription. This is deliberately a customer-only transactional
 * email: the new-subscription action above also notifies admin, while a
 * reactivation should acknowledge the returning customer without creating a
 * second "new subscriber" alert.
 */
export const sendReactivationEmail = internalAction({
  args: {
    // Legacy queued jobs lack an owner; skip them instead of mailing a deleted account.
    userId: v.optional(v.string()),
    userEmail: v.string(),
    planKey: v.string(),
    // #6330: same contract as sendSubscriptionEmails — set only when the Dodo
    // checkout email differs from the login email in `userEmail`. A returning
    // checkout is exactly as capable of alias divergence as a first one.
    checkoutEmail: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = args.userId;
    if (!userId) return;
    const canSend = () => ctx.runQuery(internal.payments.subscriptionEmails.canSendBillingEmail, { userId });
    if (!await canSend()) return;
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.error("[subscriptionEmails] RESEND_API_KEY not set");
      return;
    }

    const planName = PLAN_DISPLAY[args.planKey] ?? args.planKey;
    const signInLine = args.checkoutEmail
      ? `<p style="font-size: 13px; color: #999; line-height: 1.5; margin: 0 0 24px;">Sign in with <strong style="color: #fff;">${escapeHtml(args.userEmail)}</strong> — the address you entered at checkout is kept as your billing contact.</p>`
      : "";
    try {
      const sent = await sendEmail(
        ctx,
        apiKey,
        args.userEmail,
        `Welcome back to World Monitor ${planName}`,
        `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; background: #0a0a0a; color: #e0e0e0;">
        <div style="background: #4ade80; height: 4px;"></div>
        <div style="padding: 40px 32px;">
          <p style="font-size: 22px; font-weight: 700; color: #fff; margin: 0 0 12px;">Welcome back.</p>
          <p style="font-size: 14px; color: #999; line-height: 1.5; margin: 0 0 ${args.checkoutEmail ? "12px" : "24px"};">Your ${planName} subscription is active again and your premium access has been restored.</p>
          ${signInLine}
          <div style="text-align: center;">
            <a href="https://worldmonitor.app/dashboard" style="display: inline-block; background: #4ade80; color: #0a0a0a; padding: 14px 36px; text-decoration: none; font-weight: 800; font-size: 13px; text-transform: uppercase; letter-spacing: 1.5px; border-radius: 2px;">Open World Monitor</a>
          </div>
          <p style="font-size: 11px; color: #666; text-align: center; margin: 24px 0 0;">Questions? Reply to this email or contact ${ADMIN_EMAIL}.</p>
        </div>
      </div>`,
        { replyTo: ADMIN_EMAIL },
      );
      if (sent) console.log(`[subscriptionEmails] Reactivation email sent to ${args.userEmail}`);
    } catch (err) {
      console.error(
        `[subscriptionEmails] Reactivation email failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Sign-in pointer to the checkout inbox — same rationale as the welcome
    // path (#6330); best-effort by construction.
    if (!await canSend()) return;
    if (args.checkoutEmail) {
      await sendSignInPointer(ctx, apiKey, args.checkoutEmail, args.userEmail, planName);
    }
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
// The scan retries an unsent day-0 only once the hold is at least this old.
// Younger holds belong to the webhook's own send, which may still be in its
// Resend slot wait; a scan copy started then could pass the ledger check
// before either records and send the email twice.
export const DUNNING_DAY0_RETRY_MIN_AGE_MS = 60 * 60 * 1000;
export const DUNNING_DAY3_AGE_MS = 3 * DAY_MS;
export const DUNNING_DAY7_AGE_MS = 7 * DAY_MS;
// A hold whose paid period already ended is dunned only within this window,
// so a stale or very late on_hold row never gets a backlog final notice.
export const DUNNING_ENDED_PERIOD_MAX_AGE_MS = DUNNING_DAY7_AGE_MS + 3 * DAY_MS;
// Winback window bounds, measured from currentPeriodEnd (access end).
export const WINBACK_MIN_AGE_MS = 30 * DAY_MS;
export const WINBACK_MAX_AGE_MS = 60 * DAY_MS;
// How long after `cancelledAt` the daily scan will still retry an unsent
// cancellation confirmation (#7314, PR #7328 review). This is a RETRY window,
// not a backfill: an annual subscriber who cancelled months ago is still paid
// through, so an unbounded sweep would mail every historic canceller on the
// first tick after deploy — the same trap WINBACK_MAX_AGE_MS exists to avoid.
// Three days outlives a multi-day Resend outage while keeping the message
// timely enough to still be about a cancellation the subscriber remembers.
export const CANCELLATION_CONFIRM_RETRY_MAX_AGE_MS = 3 * DAY_MS;

const APP_ORIGIN = "https://www.worldmonitor.app";
const DASHBOARD_URL = `${APP_ORIGIN}/dashboard`;
const PRICING_URL = `${APP_ORIGIN}/pro#pricing`;
const DUNNING_PORTAL_PATH = "/api/customer-portal";

// Resend caps at 10 requests/second.
// Original bug (WORLDMONITOR-VH): sends were scheduled at runAfter(0) and burst
// concurrently; the 11th+ threw an uncaught 429 out of sendEmail, and since the
// throw precedes the ledger write those rows re-burst next tick and compounded.
export const SEND_SPACING_MS = 250;

// Shared-cursor key in the generic `counters` table: the epoch-ms timestamp of
// the next free Resend send slot for the dunning/winback fleet. Exported so
// tests can park a future slot and mutate state during the uncapped wait.
export const RESEND_SLOT_COUNTER = "dunning_resend_next_slot";

const dunningStepValidator = v.union(
  v.literal("dunning_day0"),
  v.literal("dunning_day3"),
  v.literal("dunning_day7"),
  v.literal("winback_day30"),
  v.literal("cancellation_confirm"),
);
type DunningStep =
  | "dunning_day0"
  | "dunning_day3"
  | "dunning_day7"
  | "winback_day30"
  | "cancellation_confirm";

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
    if (!sub || await billingDeletionForUser(ctx, sub.userId)) return null;

    const email = await resolveBillingRecipient(ctx, sub);

    const now = Date.now();
    const siblingSubs = await ctx.db
      .query("subscriptions")
      .withIndex("by_userId", (q) => q.eq("userId", sub.userId))
      .collect();
    const hasLiveSub = siblingSubs.some(
      (s) => s.dodoSubscriptionId !== sub.dodoSubscriptionId && isCoveringAt(s, now),
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
      cancelScheduledAt: isCancellationScheduled(sub) ? (sub.cancelScheduledAt ?? null) : null,
      currentPeriodEnd: sub.currentPeriodEnd,
      email,
      hasLiveSub,
      entitlementCoveredUntil,
    };
  },
});

/** Whether a dunning email's portal token may still mint a session. */
export const hasOpenDunningHold = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const subs = await ctx.db
      .query("subscriptions")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    return subs.some((s) => s.status === "on_hold");
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
    const deletion = await billingDeletionForEvent(ctx, { subscription_id: args.dodoSubscriptionId });
    // Deleted accounts keep the dunning ledger row with the real recipient
    // email as retained billing evidence (owner decision 2026-09-21), but a
    // tombstoned subscription must never trigger or fund another send.
    if (deletion) return;
    await ctx.db.insert("dunningEmails", {
      dodoSubscriptionId: args.dodoSubscriptionId,
      step: args.step,
      episodeAt: args.episodeAt,
      email: args.email,
      sentAt: Date.now(),
    });
  },
});

function dunningEmailShell(headline: string, bodyHtml: string, ctaLabel: string, ctaHref: string, footerNote: string, unsubscribeUrl?: string | null): string {
  // `undefined`: payment-failure mail, no line. `null`: a marketing email whose
  // one-click URL could not be signed (EMAIL_UNSUBSCRIBE_SECRET unset); keep
  // a visible support opt-out instead of dropping the line.
  const unsubscribeLine = unsubscribeUrl
    ? `<a href="${escapeHtml(unsubscribeUrl)}" style="color: #666; text-decoration: underline;">Unsubscribe from World Monitor product emails</a><br />`
    : unsubscribeUrl === null
    ? `<a href="mailto:support@worldmonitor.app?subject=Unsubscribe%20from%20product%20emails" style="color: #666; text-decoration: underline;">Email support to unsubscribe from product emails</a><br />`
    : "";
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
      ${unsubscribeLine}<a href="https://worldmonitor.app" style="color: #f59e0b; text-decoration: none;">worldmonitor.app</a>
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
  accessUntil?: number,
  paidUntil?: number,
  unsubscribeUrl?: string | null,
): { subject: string; html: string } {
  const stillCovered = typeof accessUntil === "number" && accessUntil > Date.now();
  // Access can outlive the paid period (a comp grant), so the "ends with your
  // paid period" wording is only true while the paid period itself covers.
  const paidCovered = paidUntil === undefined ? stillCovered : paidUntil > Date.now();
  switch (step) {
    case "cancellation_confirm":
      return buildCancellationConfirmEmail(planName, ctaUrl, accessUntil);
    case "dunning_day0": {
      return {
        subject: stillCovered
          ? `Your World Monitor payment failed — access continues while you fix it`
          : `Your World Monitor payment failed — update your card to restore access`,
        html: dunningEmailShell(
          "Your latest payment didn't go through.",
          stillCovered
            ? `<p style="font-size: 14px; color: #999; margin: 0; line-height: 1.5;">Your ${planName} subscription is paused because the last charge failed — usually an expired card or a bank decline. Your access continues for now: update your payment method and the subscription resumes automatically. No new checkout needed.</p>`
            : `<p style="font-size: 14px; color: #999; margin: 0; line-height: 1.5;">Your ${planName} subscription is paused because the last charge failed — usually an expired card or a bank decline. Paid access has already ended. Update your payment method to restore briefs, alerts and Pro panels. No new checkout needed.</p>`,
          "Update payment method",
          ctaUrl,
          "You're receiving this because a payment on your World Monitor subscription failed.",
        ),
      };
    }
    case "dunning_day3":
      return {
        subject: stillCovered
          ? `Reminder: update your payment method to keep ${planName}`
          : `Reminder: update your payment method to restore ${planName}`,
        html: dunningEmailShell(
          "Still paused — 2 minutes to fix.",
          stillCovered && paidCovered
            ? `<p style="font-size: 14px; color: #999; margin: 0; line-height: 1.5;">Your ${planName} payment is still failing. Once your paid period ends, briefs, alerts and your Pro panels stop. Updating your card takes about two minutes and restores everything instantly.</p>`
            : stillCovered
            ? `<p style="font-size: 14px; color: #999; margin: 0; line-height: 1.5;">Your ${planName} payment is still failing. Your access continues for now; once it ends, briefs, alerts and your Pro panels stop. Updating your card takes about two minutes and keeps everything running.</p>`
            : `<p style="font-size: 14px; color: #999; margin: 0; line-height: 1.5;">Your ${planName} payment is still failing, so briefs, alerts and your Pro panels are off. Updating your card takes about two minutes and restores everything instantly.</p>`,
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
          stillCovered && paidCovered
            ? `<p style="font-size: 14px; color: #999; margin: 0; line-height: 1.5;">This is the last email about this — your ${planName} subscription has been paused for a week over a failed payment. Update your payment method to keep your briefs, alerts and dashboards; otherwise access ends with your paid period.</p>`
            : stillCovered
            ? `<p style="font-size: 14px; color: #999; margin: 0; line-height: 1.5;">This is the last email about this — your ${planName} subscription has been paused for a week over a failed payment. Your access continues for now; update your payment method to keep your briefs, alerts and dashboards after it ends.</p>`
            : `<p style="font-size: 14px; color: #999; margin: 0; line-height: 1.5;">This is the last email about this — your ${planName} subscription has been paused for a week over a failed payment. Update your payment method to restore your briefs, alerts and dashboards.</p>`,
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
          unsubscribeUrl,
        ),
      };
  }
}

/**
 * Token-bucket pacer for Resend POSTs across the whole dunning/winback fleet.
 *
 * Returns the epoch-ms instant at which the caller may perform its Resend POST.
 * sendDunningEmail calls this immediately before the send and waits until the
 * returned slot, so concurrent sends POST >= SEND_SPACING_MS apart.
 * Single-row OCC makes concurrent reservations serialize, so no two callers
 * get overlapping slots. The cursor floors at `now`, so after any idle gap
 * the next send fires immediately instead of sleeping toward a stale future slot.
 *
 * When many sends reserve at once, Convex's in-mutation OCC retries can
 * exhaust (WORLDMONITOR-17R / 17S).
 * Callers MUST use `reserveResendSlotWithOccRetry` so a fresh mutation
 * attempt (with jittered backoff) absorbs that exhaustion instead of
 * dropping the dunning send for the tick.
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
 * Convex permanent OCC failure after the mutation's built-in retries are spent.
 * Matches Convex's message text (docs.convex.dev/error#1); there is no error
 * code to key on. If Convex rewords it, this returns false and the send fails
 * as it did before the retry existed: the action throws before the Resend POST
 * and writes no ledger row.
 */
export function isConvexOccExhaustedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("changed while this mutation was being run") &&
    msg.includes("on every subsequent retry")
  );
}

// Action-level ladder around reserveResendSlot. Each attempt is a fresh
// mutation with its own OCC retry budget; jitter spreads concurrent losers
// so they do not re-herd on the same tick (WORLDMONITOR-17R).
export const RESEND_SLOT_OCC_MAX_ATTEMPTS = 8;
export const RESEND_SLOT_OCC_BASE_DELAY_MS = 25;

export async function reserveResendSlotWithOccRetry(
  run: () => Promise<number>,
  opts?: {
    sleep?: (ms: number) => Promise<void>;
    maxAttempts?: number;
    baseDelayMs?: number;
    random?: () => number;
  },
): Promise<number> {
  const maxAttempts = opts?.maxAttempts ?? RESEND_SLOT_OCC_MAX_ATTEMPTS;
  const baseDelayMs = opts?.baseDelayMs ?? RESEND_SLOT_OCC_BASE_DELAY_MS;
  const sleep =
    opts?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = opts?.random ?? Math.random;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("reserveResendSlotWithOccRetry: maxAttempts must be a positive integer");
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await run();
    } catch (err) {
      lastError = err;
      if (!isConvexOccExhaustedError(err) || attempt === maxAttempts) throw err;
      const delay = Math.round(
        baseDelayMs * 2 ** (attempt - 1) * (0.5 + random()),
      );
      await sleep(delay);
    }
  }
  throw lastError;
}

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

type DunningContext = {
  userId: string;
  planKey: string;
  status: string;
  episodeAnchor: number;
  cancelledAt: number | null;
  cancelScheduledAt: number | null;
  currentPeriodEnd: number;
  email: string;
  hasLiveSub: boolean;
  entitlementCoveredUntil: number;
};

type DunningSkipReason =
  | "unknown_subscription"
  | "not_cancelled"
  | "stale_episode"
  | "not_covering"
  | "still_entitled"
  | "resubscribed"
  | "too_old"
  | "recovered"
  | "no_email"
  | "suppressed"
  | "already_sent";

function logDunningSkip(fields: {
  dodoSubscriptionId: string;
  step: DunningStep;
  episodeAt: number;
  reason: string;
}): void {
  console.log(JSON.stringify({
    event: "dunning_skip",
    dodoSubscriptionId: fields.dodoSubscriptionId,
    step: fields.step,
    episodeAt: fields.episodeAt,
    reason: fields.reason,
  }));
}

/**
 * Live-state gates for a detached send. The Resend wait is uncapped, so
 * eligibility / episode / coverage can change while queued — this is run
 * before the pacer and again immediately after it (PR #7328 review).
 */
function evaluateDunningEligibility(
  step: DunningStep,
  episodeAt: number,
  sub: DunningContext,
  now: number,
): { ok: true } | { ok: false; reason: DunningSkipReason } {
  if (step === "winback_day30") {
    // Winback only for genuinely-gone users: still cancelled, paid period
    // actually over, and no other covering subscription on the account.
    if (sub.status !== "cancelled") return { ok: false, reason: "not_cancelled" };
    // Same stale-episode discipline as dunning (PR #4935 review round 2,
    // finding 1): a pending winback scheduled for cancellation T1 must not
    // fire after the row moved to a different cancellation episode T2 —
    // the T2 window gets its own ledger entry and its own single send.
    if (sub.cancelledAt !== episodeAt) return { ok: false, reason: "stale_episode" };
    if (sub.currentPeriodEnd > now) return { ok: false, reason: "still_entitled" };
    // Comp floor / recomputed entitlement window (round-4 F5): a comped
    // user is covered even with every subscription ended.
    if (sub.entitlementCoveredUntil > now) return { ok: false, reason: "still_entitled" };
    if (sub.hasLiveSub) return { ok: false, reason: "resubscribed" };
    return { ok: true };
  }
  if (step === "cancellation_confirm") {
    // Mirror-image of the winback guards: this email is only correct while
    // the cancelled sub is STILL covering. Re-checked here, not just at
    // schedule time, because the action runs detached — a reactivation or
    // an expiry can land in between, and "your access continues until
    // <past date>" is worse than saying nothing. A portal cancel keeps the
    // row active until period end, so its episode is the scheduled-cancel
    // anchor (null once the cancel is withdrawn).
    const cancellationEpisode = sub.status === "cancelled" ? sub.cancelledAt : sub.cancelScheduledAt;
    if (sub.status !== "cancelled" && cancellationEpisode === null) {
      return { ok: false, reason: "not_cancelled" };
    }
    if (cancellationEpisode !== episodeAt) return { ok: false, reason: "stale_episode" };
    if (sub.currentPeriodEnd <= now) return { ok: false, reason: "not_covering" };
    return { ok: true };
  }
  // Dunning only while THIS episode is still open — a recovery or a
  // newer episode (different anchor) invalidates the scheduled send.
  // A period that ended at or before the hold start is a failed renewal and
  // stays dunned. A period that ends after the hold start means access
  // lapsed mid-dunning, so later steps skip as not_covering.
  if (sub.status !== "on_hold") return { ok: false, reason: "recovered" };
  if (sub.episodeAnchor !== episodeAt) return { ok: false, reason: "stale_episode" };
  if (sub.currentPeriodEnd <= now && sub.currentPeriodEnd > episodeAt) {
    return { ok: false, reason: "not_covering" };
  }
  // An ended-period hold whose user already bought another subscription must
  // not be told to fix this one: restoring it would bill them twice.
  if (sub.currentPeriodEnd <= now && sub.hasLiveSub) {
    return { ok: false, reason: "resubscribed" };
  }
  if (sub.currentPeriodEnd <= now && now - episodeAt > DUNNING_ENDED_PERIOD_MAX_AGE_MS) {
    return { ok: false, reason: "too_old" };
  }
  return { ok: true };
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
      logDunningSkip({ ...args, reason: "no_api_key" });
      return { sent: false, reason: "no_api_key" as const };
    }

    const resolveSend = async (): Promise<
      { ok: true; sub: DunningContext } | { ok: false; reason: DunningSkipReason }
    > => {
      const sub = await ctx.runQuery(
        internal.payments.subscriptionEmails.getDunningContext,
        { dodoSubscriptionId: args.dodoSubscriptionId },
      );
      if (!sub) return { ok: false, reason: "unknown_subscription" };
      const eligibility = evaluateDunningEligibility(
        args.step,
        args.episodeAt,
        sub,
        Date.now(),
      );
      if (!eligibility.ok) return eligibility;
      if (!sub.email) {
        console.warn(`[dunning] no resolvable email for ${args.dodoSubscriptionId} — skipping ${args.step}`);
        return { ok: false, reason: "no_email" };
      }
      const suppressed = await ctx.runQuery(internal.emailSuppressions.isEmailSuppressed, {
        email: sub.email,
        purpose: args.step === "winback_day30" ? "marketing" : "transactional",
      });
      if (suppressed) return { ok: false, reason: "suppressed" };
      const alreadySent = await ctx.runQuery(
        internal.payments.subscriptionEmails.wasDunningStepSent,
        args,
      );
      if (alreadySent) return { ok: false, reason: "already_sent" };
      return { ok: true, sub };
    };

    const first = await resolveSend();
    if (!first.ok) {
      logDunningSkip({ ...args, reason: first.reason });
      return { sent: false, reason: first.reason };
    }

    // Direct Dodo session links expire in ~24h, which is shorter than the
    // day-3 / day-7 reminders.
    let ctaUrl = args.step === "winback_day30" ? PRICING_URL : DASHBOARD_URL;
    if (args.step !== "winback_day30" && args.step !== "cancellation_confirm") {
      try {
        const token = await signDunningPortalToken(first.sub.userId, Date.now());
        ctaUrl = `${APP_ORIGIN}${DUNNING_PORTAL_PATH}?t=${encodeURIComponent(token)}`;
      } catch (err) {
        // Degrade, never drop the send: the tokenless route 302s to
        // /dashboard?billing=portal, which opens the portal after sign-in.
        // console.log, not warn:
        // Convex has no silent-capture helper for the Sentry-coverage gate.
        console.log(
          `[dunning] portal token sign failed for ${args.dodoSubscriptionId} (${err instanceof Error ? err.message : String(err)}) — falling back to sign-in portal route`,
        );
        ctaUrl = `${APP_ORIGIN}${DUNNING_PORTAL_PATH}`;
      }
    }

    const slotAt = await reserveResendSlotWithOccRetry(() =>
      ctx.runMutation(internal.payments.subscriptionEmails.reserveResendSlot, {}),
    );
    const waitMs = resendPacingWaitMs(slotAt, Date.now());
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));

    // Re-read after the uncapped wait. Resume / expiry / a new cancellation
    // episode / suppression / a concurrent ledger write can all land while
    // queued; sending the pre-wait snapshot would be the wrong email.
    const fresh = await resolveSend();
    if (!fresh.ok) {
      logDunningSkip({ ...args, reason: fresh.reason });
      return { sent: false, reason: fresh.reason };
    }

    const planName = PLAN_DISPLAY[fresh.sub.planKey] ?? fresh.sub.planKey;
    // Winback is marketing: one-click unsubscribe (RFC 8058) + footer link,
    // sent from news@. Null when EMAIL_UNSUBSCRIBE_SECRET is unset.
    const isWinback = args.step === "winback_day30";
    const unsubscribeUrl = isWinback
      ? await buildUnsubscribeUrl(fresh.sub.userId, "marketing")
      : undefined;
    const { subject, html } = buildDunningEmail(
      args.step,
      planName,
      ctaUrl,
      args.step === "cancellation_confirm"
        ? fresh.sub.currentPeriodEnd
        : Math.max(fresh.sub.currentPeriodEnd, fresh.sub.entitlementCoveredUntil),
      fresh.sub.currentPeriodEnd,
      unsubscribeUrl,
    );
    const sent = await sendEmail(ctx, apiKey, fresh.sub.email, subject, html, {
      replyTo: ADMIN_EMAIL,
      purpose: isWinback ? "marketing" : "transactional",
      ...(isWinback ? { from: MARKETING_FROM, headers: listUnsubscribeHeaders(unsubscribeUrl) } : {}),
    });
    if (!sent) {
      // resolveSend already checked suppression; this only fires when a
      // suppression landed in the narrow window after the re-read.
      logDunningSkip({ ...args, reason: "suppressed" });
      return { sent: false, reason: "suppressed" as const };
    }
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
      email: fresh.sub.email,
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
      // Mirrors the too_old send gate so ancient holds are not rescheduled daily.
      if (sub.currentPeriodEnd <= now && age > DUNNING_ENDED_PERIOD_MAX_AGE_MS) continue;
      // Day-0 is first enqueued by the on_hold webhook, but a send that throws
      // (Resend error, exhausted slot OCC, RESEND_API_KEY missing at webhook
      // time) leaves no ledger row and is never auto-retried. Retry it here
      // until day-3 takes over; the ledger pre-check below skips a day-0
      // that already went out.
      const step: DunningStep | null =
        age >= DUNNING_DAY7_AGE_MS ? "dunning_day7"
        : age >= DUNNING_DAY3_AGE_MS ? "dunning_day3"
        : age >= DUNNING_DAY0_RETRY_MIN_AGE_MS ? "dunning_day0"
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

    // Durable retry for the cancellation confirmation (#7314, PR #7328
    // review). The webhook enqueues it once, on the enteringCancelled
    // transition — but sendEmail throws BEFORE the ledger write and
    // internalActions are not auto-retried, so a transient Resend error (or a
    // RESEND_API_KEY missing at webhook time) would otherwise lose that
    // customer's confirmation permanently. Every other step in this module
    // recovers through this scan; this one now does too.
    //
    // The still-covering filter is DISJOINT from the winback range above —
    // currentPeriodEnd >= now versus lapsed 30-60 days — so no subscription
    // can be due for both steps in the same tick.
    //
    // Bound the READ by cancelledAt, not currentPeriodEnd. An annual who
    // cancelled months ago stays paid-through until period end, so a
    // currentPeriodEnd >= now collect() would re-read that row every day
    // for the rest of the year and can exceed Convex's per-transaction
    // read cap (PR #7328 review). The three-day retry window is the
    // natural cohort; period-end is then an in-memory still-covering check.
    const recentCancellations = await ctx.db
      .query("subscriptions")
      .withIndex("by_status_cancelledAt", (q) =>
        q
          .eq("status", "cancelled")
          .gte("cancelledAt", now - CANCELLATION_CONFIRM_RETRY_MAX_AGE_MS),
      )
      .collect();
    const paidThroughCancelled: typeof recentCancellations = [];
    for (const sub of recentCancellations) {
      // Same rule as winback: no cancelledAt means no stable episode key.
      // The index omits missing fields; this guard keeps episodeAt typed.
      if (sub.cancelledAt === undefined) continue;
      if (sub.currentPeriodEnd < now) continue;
      paidThroughCancelled.push(sub);
      due.push({
        dodoSubscriptionId: sub.dodoSubscriptionId,
        step: "cancellation_confirm",
        episodeAt: sub.cancelledAt,
      });
    }
    const recentScheduledCancels = await ctx.db
      .query("subscriptions")
      .withIndex("by_status_cancelScheduledAt", (q) =>
        q
          .eq("status", "active")
          .gte("cancelScheduledAt", now - CANCELLATION_CONFIRM_RETRY_MAX_AGE_MS),
      )
      .collect();
    for (const sub of recentScheduledCancels) {
      if (sub.cancelScheduledAt === undefined || !isCancellationScheduled(sub)) continue;
      if (sub.currentPeriodEnd < now) continue;
      paidThroughCancelled.push(sub);
      due.push({
        dodoSubscriptionId: sub.dodoSubscriptionId,
        step: "cancellation_confirm",
        episodeAt: sub.cancelScheduledAt,
      });
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
      `[dunning] scan: ${onHold.length} on_hold, ${cancelled.length} cancelled, ${paidThroughCancelled.length} paid-through cancelled, ${scheduled} sends scheduled`,
    );
    return {
      onHold: onHold.length,
      cancelled: cancelled.length,
      paidThroughCancelled: paidThroughCancelled.length,
      scheduled,
    };
  },
});
