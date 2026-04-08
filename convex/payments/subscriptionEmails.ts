/**
 * Subscription lifecycle emails via Resend.
 *
 * Scheduled from webhook mutations (handleSubscriptionActive) so email
 * delivery does not block webhook processing.
 */

import { v } from "convex/values";
import { internalAction } from "../_generated/server";

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

const API_PLANS = new Set(["api_starter", "api_starter_annual", "api_business", "enterprise"]);

async function sendEmail(
  apiKey: string,
  to: string,
  subject: string,
  html: string,
): Promise<void> {
  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ from: FROM, to: [to], subject, html }),
  });
  if (!res.ok) {
    const body = await res.text();
    const msg = `[subscriptionEmails] Resend ${res.status}: ${body}`;
    console.error(msg);
    throw new Error(msg);
  }
}

function featureCardsHtml(planKey: string): string {
  if (API_PLANS.has(planKey)) {
    return `
      <tr>
        <td style="width: 50%; padding: 12px; vertical-align: top;">
          <div style="background: #111; border: 1px solid #1a1a1a; padding: 16px; height: 100%;">
            <div style="font-size: 20px; margin-bottom: 8px;">&#128273;</div>
            <div style="font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 4px;">Full API Access</div>
            <div style="font-size: 12px; color: #888; line-height: 1.4;">22 services, one API key</div>
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
  // Pro plans: no API access
  return `
      <tr>
        <td style="width: 50%; padding: 12px; vertical-align: top;">
          <div style="background: #111; border: 1px solid #1a1a1a; padding: 16px; height: 100%;">
            <div style="font-size: 20px; margin-bottom: 8px;">&#9889;</div>
            <div style="font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 4px;">Near-Real-Time Data</div>
            <div style="font-size: 12px; color: #888; line-height: 1.4;">Priority pipeline with sub-60s refresh</div>
          </div>
        </td>
        <td style="width: 50%; padding: 12px; vertical-align: top;">
          <div style="background: #111; border: 1px solid #1a1a1a; padding: 16px; height: 100%;">
            <div style="font-size: 20px; margin-bottom: 8px;">&#129504;</div>
            <div style="font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 4px;">AI Analyst</div>
            <div style="font-size: 12px; color: #888; line-height: 1.4;">Morning briefs, flash alerts, pattern detection</div>
          </div>
        </td>
      </tr>
      <tr>
        <td style="width: 50%; padding: 12px; vertical-align: top;">
          <div style="background: #111; border: 1px solid #1a1a1a; padding: 16px; height: 100%;">
            <div style="font-size: 20px; margin-bottom: 8px;">&#128232;</div>
            <div style="font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 4px;">Multi-Channel Alerts</div>
            <div style="font-size: 12px; color: #888; line-height: 1.4;">Slack, Telegram, WhatsApp, Email, Discord</div>
          </div>
        </td>
        <td style="width: 50%; padding: 12px; vertical-align: top;">
          <div style="background: #111; border: 1px solid #1a1a1a; padding: 16px; height: 100%;">
            <div style="font-size: 20px; margin-bottom: 8px;">&#128202;</div>
            <div style="font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 4px;">10 Dashboards</div>
            <div style="font-size: 12px; color: #888; line-height: 1.4;">Custom layouts with CSV + PDF export</div>
          </div>
        </td>
      </tr>`;
}

function userWelcomeHtml(planName: string, planKey: string): string {
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
      <p style="font-size: 18px; font-weight: 600; color: #fff; margin: 0 0 8px;">Welcome to ${planName}!</p>
      <p style="font-size: 14px; color: #999; margin: 0; line-height: 1.5;">Your subscription is now active. Here's what's unlocked:</p>
    </div>

    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom: 28px;">
      ${featureCardsHtml(planKey)}
    </table>

    <div style="text-align: center; margin-bottom: 36px;">
      <a href="https://worldmonitor.app" style="display: inline-block; background: #4ade80; color: #0a0a0a; padding: 14px 36px; text-decoration: none; font-weight: 800; font-size: 13px; text-transform: uppercase; letter-spacing: 1.5px; border-radius: 2px;">Open Dashboard</a>
    </div>
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
 * Send welcome email to user + admin notification on new subscription.
 * Scheduled from handleSubscriptionActive via ctx.scheduler.
 */
export const sendSubscriptionEmails = internalAction({
  args: {
    userEmail: v.string(),
    planKey: v.string(),
    userId: v.string(),
    subscriptionId: v.string(),
  },
  handler: async (_ctx, args) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.error("[subscriptionEmails] RESEND_API_KEY not set");
      return;
    }

    const planName = PLAN_DISPLAY[args.planKey] ?? args.planKey;

    // 1. Welcome email to user
    await sendEmail(
      apiKey,
      args.userEmail,
      `Welcome to World Monitor ${planName}`,
      userWelcomeHtml(planName, args.planKey),
    );
    console.log(`[subscriptionEmails] Welcome email sent to ${args.userEmail}`);

    // 2. Admin notification
    await sendEmail(
      apiKey,
      ADMIN_EMAIL,
      `[WM] New User Subscribed to ${planName}`,
      `<div style="font-family: monospace; padding: 20px; background: #0a0a0a; color: #e0e0e0;">
        <p style="color: #4ade80; font-size: 16px; font-weight: bold;">New Subscription</p>
        <table style="font-size: 14px; line-height: 1.8;">
          <tr><td style="color: #888; padding-right: 16px;">Plan:</td><td style="color: #fff;">${planName}</td></tr>
          <tr><td style="color: #888; padding-right: 16px;">Email:</td><td style="color: #fff;">${args.userEmail}</td></tr>
          <tr><td style="color: #888; padding-right: 16px;">User ID:</td><td style="color: #fff; font-size: 12px;">${args.userId}</td></tr>
          <tr><td style="color: #888; padding-right: 16px;">Subscription:</td><td style="color: #fff; font-size: 12px;">${args.subscriptionId}</td></tr>
        </table>
      </div>`,
    );
    console.log(`[subscriptionEmails] Admin notification sent for ${args.userEmail}`);
  },
});
