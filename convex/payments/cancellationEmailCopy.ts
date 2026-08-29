/**
 * Paid-through cancellation confirmation copy (#7314).
 *
 * Isolated from subscriptionEmails.ts so user-facing content can change
 * without touching eligibility, persistence, pacing, or scan orchestration.
 */

const ADMIN_EMAIL = "elie@worldmonitor.app";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/**
 * Render an access-end date for email copy, in UTC.
 *
 * Deliberately hand-rolled rather than `toLocaleDateString`: the Convex
 * runtime carries no user locale, so a locale-formatted date is both
 * non-deterministic across runtimes and untestable. UTC (not local) because
 * `currentPeriodEnd` is a UTC instant from Dodo — formatting it in a server
 * timezone would print the wrong calendar day for periods ending near
 * midnight, and this date is the entire point of the cancellation email.
 */
export function formatAccessEndDate(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function cancellationEmailShell(
  headline: string,
  bodyHtml: string,
  ctaLabel: string,
  ctaHref: string,
  footerNote: string,
): string {
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
 * Subject + HTML for the paid-through cancellation confirmation.
 *
 * Plan-neutral on purpose: this step fires for every plan key,
 * api_starter and api_business included, so naming Pro features
 * here would tell an API subscriber about things they never had.
 */
export function buildCancellationConfirmEmail(
  planName: string,
  ctaUrl: string,
  accessUntil?: number,
): { subject: string; html: string } {
  // Lead with the date, in the subject line as well as the body. The
  // escalation that motivated this email (#7314) came from a subscriber
  // who read "cancelled" as "cut off" and asked for a refund of a month
  // he still held — so the reassurance has to survive being read in a
  // notification preview, not just by someone who opens the mail.
  const until = accessUntil === undefined ? null : formatAccessEndDate(accessUntil);
  const untilPhrase = until ? `until ${until}` : "until the end of your paid period";
  return {
    subject: `Your World Monitor ${planName} access continues ${untilPhrase}`,
    html: cancellationEmailShell(
      `Your access continues ${untilPhrase}.`,
      `<p style="font-size: 14px; color: #999; margin: 0; line-height: 1.5;">We've cancelled the renewal on your ${planName} subscription — you won't be charged again. Nothing is switched off today: your ${planName} access keeps working ${untilPhrase}, the period you've already paid for. After that, this subscription ends.</p>`,
      "Open dashboard",
      ctaUrl,
      "You're receiving this because you cancelled a World Monitor subscription. No further charges will be taken.",
    ),
  };
}
