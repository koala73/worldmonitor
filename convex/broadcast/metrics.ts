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
 * On a successful first-write, also bumps the matching aggregate row in
 * `broadcastEventCounts` so `getBroadcastStats` can read in O(N tracked
 * event types) instead of scanning the full event log. Counter increment
 * is gated on insert success, so duplicate webhook deliveries cannot
 * inflate the count.
 *
 * No `rawPayload` accepted — Resend's `data` object includes recipient
 * emails (`to: string[]`), `from`, `subject`, etc. that are PII or
 * PII-adjacent. Convex dashboard rows are observable; we keep only the
 * identifying metadata. Deeper inspection lives in the Resend dashboard
 * via `emailMessageId`.
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

    // Bump (or create) the aggregate counter. Read-then-write is safe
    // here because Convex mutations run serializably — no two
    // concurrent recordBroadcastEvent calls for the same
    // (broadcastId, eventType) can interleave.
    const counterRow = await ctx.db
      .query("broadcastEventCounts")
      .withIndex("by_broadcast_event", (q) =>
        q.eq("broadcastId", args.broadcastId).eq("eventType", args.eventType),
      )
      .unique();
    const now = Date.now();
    if (counterRow) {
      await ctx.db.patch(counterRow._id, {
        count: counterRow.count + 1,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("broadcastEventCounts", {
        broadcastId: args.broadcastId,
        eventType: args.eventType,
        count: 1,
        updatedAt: now,
      });
    }

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
 * Reads from `broadcastEventCounts` (one row per `(broadcastId, eventType)`)
 * — N index lookups per call (N = tracked event types = 8), constant
 * time regardless of broadcast size. The previous implementation
 * `.collect()`-ed `broadcastEvents` per type and would have thrown
 * Convex's 16,384-doc read limit on a 30k-recipient main send the
 * moment `email.delivered` overflowed.
 */
export const getBroadcastStats = internalQuery({
  args: { broadcastId: v.string() },
  handler: async (ctx, { broadcastId }): Promise<BroadcastStats> => {
    const counts: Record<string, number> = {};
    for (const eventType of BROADCAST_TRACKED_EVENT_TYPES) {
      const row = await ctx.db
        .query("broadcastEventCounts")
        .withIndex("by_broadcast_event", (q) =>
          q.eq("broadcastId", broadcastId).eq("eventType", eventType),
        )
        .unique();
      counts[eventType] = row?.count ?? 0;
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
