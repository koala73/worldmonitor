/**
 * Trigger the PRO-launch Resend Broadcast against a Resend Segment.
 *
 * Splits create + send so the operator can:
 *   1. Create the broadcast (any segment, any time) — returns the
 *      Resend `broadcastId` for tracking.
 *   2. Inspect raw headers / preview the rendered HTML in the Resend
 *      dashboard before firing.
 *   3. Trigger the send — either immediately (`scheduledAt` omitted)
 *      or at a specific ISO timestamp ("in 2 hours" / scheduled times
 *      are supported by Resend's API).
 *
 * Operational sequence for the canary plan (250 → 500 → ramp):
 *   - Pre-build a `pro-launch-canary` segment in Resend with the first
 *     250 deduped contacts (manually in dashboard, OR via a follow-up
 *     PR that splits the audience programmatically).
 *   - Pre-build a `pro-launch-main` segment with the rest, mutually
 *     exclusive from canary.
 *   - createProLaunchBroadcast({ segmentId: canarySegmentId }) → store id
 *   - sendProLaunchBroadcast({ broadcastId }) → fire
 *   - Poll `broadcast/metrics:getBroadcastStats` every few seconds.
 *     Halt before main-send if `bouncesOverThreshold` or
 *     `complaintsOverThreshold` flips true.
 *   - createProLaunchBroadcast({ segmentId: mainSegmentId }) → store id
 *   - sendProLaunchBroadcast({ broadcastId }) → fire
 *
 * Usage (run from CLI; not callable by clients):
 *   npx convex run broadcast/sendBroadcast:createProLaunchBroadcast \
 *     '{"segmentId":"seg_xxx"}'
 *   npx convex run broadcast/sendBroadcast:sendProLaunchBroadcast \
 *     '{"broadcastId":"bro_xxx"}'
 *   # Or schedule:
 *   npx convex run broadcast/sendBroadcast:sendProLaunchBroadcast \
 *     '{"broadcastId":"bro_xxx","scheduledAt":"2026-04-27T13:00:00Z"}'
 */
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import {
  PRO_LAUNCH_FROM,
  PRO_LAUNCH_HTML,
  PRO_LAUNCH_PHYSICAL_ADDRESS,
  PRO_LAUNCH_REPLY_TO,
  PRO_LAUNCH_SUBJECT,
  PRO_LAUNCH_TEXT,
} from "./proLaunchEmailContent";
import {
  BLACK_FRIDAY_FROM,
  BLACK_FRIDAY_LOCALES,
  BLACK_FRIDAY_OFFER,
  BLACK_FRIDAY_REPLY_TO,
  BLACK_FRIDAY_VERSIONS,
  RESEND_UNSUBSCRIBE_TOKEN,
  renderBlackFridayEmail,
  type BlackFridayVersion,
} from "./blackFridayEmailContent";
import { fetchResendWithRateLimitRetry } from "../lib/resendEmail";

const RESEND_API_BASE = "https://api.resend.com";
const USER_AGENT = "WorldMonitor-PROLaunchSender/1.0 (+https://worldmonitor.app)";

/**
 * Create a Resend Broadcast (a draft: nothing is sent) and return its id.
 * The one `POST /broadcasts` call site, shared by every campaign's content.
 */
export async function createResendBroadcast(
  apiKey: string,
  caller: string,
  content: {
    name: string;
    segmentId: string;
    from: string;
    replyTo: string;
    subject: string;
    html: string;
    text: string;
  },
): Promise<string> {
  const res = await fetchResendWithRateLimitRetry(() => fetch(`${RESEND_API_BASE}/broadcasts`, {
    signal: AbortSignal.timeout(10_000),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      name: content.name,
      segment_id: content.segmentId,
      from: content.from,
      reply_to: content.replyTo,
      subject: content.subject,
      html: content.html,
      text: content.text,
    }),
  }));

  if (!res.ok) {
    const body = await res.text().catch(() => "<no body>");
    throw new Error(`[${caller}] Resend ${res.status}: ${body}`);
  }

  const json = (await res.json().catch(() => null)) as { id?: string } | null;
  if (!json?.id) {
    throw new Error(`[${caller}] Resend response missing id: ${JSON.stringify(json)}`);
  }
  return json.id;
}

/**
 * Create a Resend Broadcast from the locked launch content. Does NOT
 * send — separate `sendProLaunchBroadcast` step. Returns the new
 * broadcast id so the operator can preview in the Resend dashboard
 * before firing.
 *
 * Idempotency: NOT idempotent on segmentId. Calling twice with the same
 * segment creates two separate broadcasts. The operator owns "have I
 * already created this?" tracking.
 */
export const createProLaunchBroadcast = internalAction({
  args: {
    segmentId: v.string(),
    nameSuffix: v.optional(v.string()),
  },
  handler: async (_ctx, { segmentId, nameSuffix }) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error("[createProLaunchBroadcast] RESEND_API_KEY not set");
    }

    // Hard-gate: refuse to ship the placeholder physical address.
    // CAN-SPAM requires a valid postal address in every commercial
    // email footer; sending the literal "physical address TBD" string
    // is non-compliant and embarrassing. Edit
    // `PRO_LAUNCH_PHYSICAL_ADDRESS` in proLaunchEmailContent.ts to the
    // real postal address before invoking this action.
    if (
      PRO_LAUNCH_PHYSICAL_ADDRESS.includes("TBD") ||
      PRO_LAUNCH_PHYSICAL_ADDRESS.includes("placeholder")
    ) {
      throw new Error(
        `[createProLaunchBroadcast] PRO_LAUNCH_PHYSICAL_ADDRESS is still a placeholder ("${PRO_LAUNCH_PHYSICAL_ADDRESS}"). ` +
          "Set the real CAN-SPAM postal address in convex/broadcast/proLaunchEmailContent.ts before sending.",
      );
    }

    const name =
      nameSuffix && nameSuffix.length > 0
        ? `PRO Launch — ${nameSuffix}`
        : `PRO Launch — ${new Date().toISOString().slice(0, 10)}`;

    const broadcastId = await createResendBroadcast(apiKey, "createProLaunchBroadcast", {
      name,
      segmentId,
      from: PRO_LAUNCH_FROM,
      replyTo: PRO_LAUNCH_REPLY_TO,
      subject: PRO_LAUNCH_SUBJECT,
      html: PRO_LAUNCH_HTML,
      text: PRO_LAUNCH_TEXT,
    });

    return {
      broadcastId,
      name,
      segmentId,
      subject: PRO_LAUNCH_SUBJECT,
    };
  },
});

/**
 * Create the Resend Broadcast for one Black Friday segment: one version, in
 * one locale, for one recipient type. Does NOT send. Called by
 * `finalizeWaveAction` for campaign runs; the run is then held until an
 * operator releases it (see blackFriday.ts and the runbook beside it).
 *
 * The unsubscribe link is Resend's per-contact token, which Resend fills for
 * every contact in the segment, account or waitlist, and backs with its own
 * List-Unsubscribe headers. The webhook turns that unsubscribe into an
 * `emailSuppressions` row (resendWebhookHandler.ts).
 */
export const createBlackFridayBroadcast = internalAction({
  args: {
    segmentId: v.string(),
    nameSuffix: v.string(),
    campaignId: v.string(),
    version: v.string(),
    locale: v.string(),
    recipient: v.union(v.literal("account"), v.literal("waitlist")),
  },
  handler: async (_ctx, args) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error("[createBlackFridayBroadcast] RESEND_API_KEY not set");
    }
    if (args.campaignId !== BLACK_FRIDAY_OFFER.campaignId) {
      throw new Error(`[createBlackFridayBroadcast] unknown campaign ${args.campaignId}`);
    }
    if (!(BLACK_FRIDAY_VERSIONS as readonly string[]).includes(args.version)) {
      throw new Error(`[createBlackFridayBroadcast] unknown version ${args.version}`);
    }
    if (!(BLACK_FRIDAY_LOCALES as readonly string[]).includes(args.locale)) {
      throw new Error(`[createBlackFridayBroadcast] unknown locale ${args.locale}`);
    }
    // The offer ends by clock. A broadcast created after it would promise a
    // price checkout no longer gives.
    if (Date.now() >= BLACK_FRIDAY_OFFER.endsAtMs) {
      throw new Error("[createBlackFridayBroadcast] the offer has ended");
    }
    const email = renderBlackFridayEmail({
      version: args.version as BlackFridayVersion,
      locale: args.locale,
      recipient: args.recipient,
    });
    if (!email.html.includes(RESEND_UNSUBSCRIBE_TOKEN) || !email.text.includes(RESEND_UNSUBSCRIBE_TOKEN)) {
      throw new Error("[createBlackFridayBroadcast] content is missing the unsubscribe token");
    }
    const name = `Black Friday 2026 — ${args.nameSuffix}`;
    const broadcastId = await createResendBroadcast(apiKey, "createBlackFridayBroadcast", {
      name,
      segmentId: args.segmentId,
      from: BLACK_FRIDAY_FROM,
      replyTo: BLACK_FRIDAY_REPLY_TO,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
    return { broadcastId, name, segmentId: args.segmentId, subject: email.subject };
  },
});

/**
 * Send (or schedule) a previously-created Resend Broadcast.
 *
 * `scheduledAt`: ISO 8601 timestamp string OR a natural-language phrase
 * Resend accepts ("in 2 hours"). Omit for immediate send.
 *
 * Resend's send endpoint is fire-and-forget — it returns immediately
 * after queueing. Track delivery via the `broadcastEvents` table
 * (populated by webhook events) or the `getBroadcastStats` action.
 */
export const sendProLaunchBroadcast = internalAction({
  args: {
    broadcastId: v.string(),
    scheduledAt: v.optional(v.string()),
  },
  handler: async (_ctx, { broadcastId, scheduledAt }) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error("[sendProLaunchBroadcast] RESEND_API_KEY not set");
    }

    const body: Record<string, unknown> = {};
    if (scheduledAt) body.scheduled_at = scheduledAt;

    // Single attempt on purpose, 429 included: the campaign stop and send
    // cutoff are checked by the caller, so an in-action retry could fire a
    // broadcast after an operator stop. A failed send goes through the
    // runbook's send-broadcast-failed recovery, which re-checks the gate.
    const res = await fetch(
      `${RESEND_API_BASE}/broadcasts/${encodeURIComponent(broadcastId)}/send`,
      {
        signal: AbortSignal.timeout(10_000),
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(body),
      },
    );

    if (!res.ok) {
      const errBody = await res.text().catch(() => "<no body>");
      throw new Error(
        `[sendProLaunchBroadcast] Resend ${res.status}: ${errBody}`,
      );
    }

    return {
      broadcastId,
      status: scheduledAt ? "scheduled" : "queued",
      scheduledAt: scheduledAt ?? null,
    };
  },
});
