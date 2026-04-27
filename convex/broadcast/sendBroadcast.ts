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

const RESEND_API_BASE = "https://api.resend.com";
const USER_AGENT = "WorldMonitor-PROLaunchSender/1.0 (+https://worldmonitor.app)";

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

    const res = await fetch(`${RESEND_API_BASE}/broadcasts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        name,
        segment_id: segmentId,
        from: PRO_LAUNCH_FROM,
        reply_to: PRO_LAUNCH_REPLY_TO,
        subject: PRO_LAUNCH_SUBJECT,
        html: PRO_LAUNCH_HTML,
        text: PRO_LAUNCH_TEXT,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "<no body>");
      throw new Error(
        `[createProLaunchBroadcast] Resend ${res.status}: ${body}`,
      );
    }

    const json = (await res.json().catch(() => null)) as {
      id?: string;
    } | null;
    if (!json?.id) {
      throw new Error(
        `[createProLaunchBroadcast] Resend response missing id: ${JSON.stringify(json)}`,
      );
    }

    return {
      broadcastId: json.id,
      name,
      segmentId,
      subject: PRO_LAUNCH_SUBJECT,
    };
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

    const res = await fetch(
      `${RESEND_API_BASE}/broadcasts/${encodeURIComponent(broadcastId)}/send`,
      {
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
