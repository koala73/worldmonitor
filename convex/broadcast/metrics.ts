/**
 * Broadcast metrics — record per-event Resend webhook deliveries against
 * a broadcast and expose live aggregates for canary kill-gate decisions.
 *
 * Kill-gate thresholds (per project memory `pro_launch_broadcast`):
 *   - hard bounce > 4% of `delivered` → halt rollout
 *   - spam complaint > 0.08% of `delivered` → halt rollout
 *
 * Resend webhook events that count:
 *   email.delivered, email.bounced, email.complained, email.opened,
 *   email.clicked, email.delivery_delayed, email.suppressed, email.failed
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

export const BROADCAST_TRACKED_EVENT_TYPES = [
  "email.delivered",
  "email.bounced",
  "email.complained",
  "email.opened",
  "email.clicked",
  "email.delivery_delayed",
  "email.suppressed",
  "email.failed",
] as const;

const TRACKED_SET: ReadonlySet<string> = new Set(BROADCAST_TRACKED_EVENT_TYPES);

/**
 * Record one Resend webhook event against a broadcast. Idempotent on
 * `webhookEventId` — Resend retries on 5xx and the same event may be
 * delivered multiple times. We trust the svix-id header (passed in as
 * `webhookEventId`) for de-duplication.
 *
 * Returns `{ inserted }` so the caller can distinguish first-write from
 * a retry.
 */
export const recordBroadcastEvent = internalMutation({
  args: {
    webhookEventId: v.string(),
    broadcastId: v.string(),
    emailMessageId: v.optional(v.string()),
    eventType: v.string(),
    occurredAt: v.number(),
    rawPayload: v.any(),
  },
  handler: async (ctx, args) => {
    if (!TRACKED_SET.has(args.eventType)) {
      // Drop — caller should pre-filter, but guard anyway so a future
      // event type added upstream doesn't silently accumulate rows we
      // can't aggregate against.
      return { inserted: false, reason: "untracked_event_type" as const };
    }

    const existing = await ctx.db
      .query("broadcastEvents")
      .withIndex("by_webhookEventId", (q) =>
        q.eq("webhookEventId", args.webhookEventId),
      )
      .first();

    if (existing) {
      return { inserted: false, reason: "duplicate" as const };
    }

    await ctx.db.insert("broadcastEvents", args);
    return { inserted: true, reason: "ok" as const };
  },
});

type BroadcastStats = {
  broadcastId: string;
  counts: Record<string, number>;
  // Computed against `delivered` as the denominator. `null` when
  // `delivered === 0` (rate is undefined, not zero).
  bounceRate: number | null;
  complaintRate: number | null;
  openRate: number | null;
  clickRate: number | null;
  // Kill-gate booleans — `true` if the threshold has been crossed.
  // Use these to halt subsequent canary expansion.
  bouncesOverThreshold: boolean;
  complaintsOverThreshold: boolean;
};

const BOUNCE_KILL_THRESHOLD = 0.04; // 4%
const COMPLAINT_KILL_THRESHOLD = 0.0008; // 0.08%

/**
 * Live aggregate for one broadcast. Designed for operator polling during
 * a canary send — call from a watch script every few seconds and stop
 * the rollout the moment a kill-gate trips.
 *
 * Counts each event type via the `by_broadcast_event` compound index;
 * read cost is proportional to the per-type result size, not the full
 * `broadcastEvents` table.
 */
export const getBroadcastStats = internalQuery({
  args: { broadcastId: v.string() },
  handler: async (ctx, { broadcastId }): Promise<BroadcastStats> => {
    const counts: Record<string, number> = {};
    for (const eventType of BROADCAST_TRACKED_EVENT_TYPES) {
      const rows = await ctx.db
        .query("broadcastEvents")
        .withIndex("by_broadcast_event", (q) =>
          q.eq("broadcastId", broadcastId).eq("eventType", eventType),
        )
        .collect();
      counts[eventType] = rows.length;
    }

    const delivered = counts["email.delivered"] ?? 0;
    const rate = (n: number) => (delivered > 0 ? n / delivered : null);

    const bounceRate = rate(counts["email.bounced"] ?? 0);
    const complaintRate = rate(counts["email.complained"] ?? 0);

    return {
      broadcastId,
      counts,
      bounceRate,
      complaintRate,
      openRate: rate(counts["email.opened"] ?? 0),
      clickRate: rate(counts["email.clicked"] ?? 0),
      bouncesOverThreshold:
        bounceRate !== null && bounceRate > BOUNCE_KILL_THRESHOLD,
      complaintsOverThreshold:
        complaintRate !== null && complaintRate > COMPLAINT_KILL_THRESHOLD,
    };
  },
});
