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
 *
 * Storage model: `broadcastEvents` is the sole source of truth — one row
 * per (svix-id) tracked event. There is no derived counter table; an
 * earlier `broadcastEventCounts` aggregate caused OCC contention under
 * webhook burst (every event raced for the same `(broadcastId, eventType)`
 * counter row, exhausted Convex's mutation retry budget, and the entire
 * mutation rolled back — losing the per-event row too).
 *
 * `getBroadcastStats` paginates the event log at read time. Read cost is
 * O(events / page_size) per stats call — fine for 30s polling cadence
 * even at 30k+ recipients, since each page is its own function execution
 * with its own 16,384-doc budget.
 */
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";

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
 * `webhookEventId` (the svix-id header) — Resend retries on 5xx and the
 * same event may be delivered multiple times. The webhook handler MUST
 * propagate any throw from this mutation back as a 5xx HTTP response so
 * Resend retries, otherwise events are silently lost.
 *
 * Single insert into `broadcastEvents`. No counter bump — counts are
 * derived at read time by `getBroadcastStats`.
 *
 * No `rawPayload` accepted — Resend's `data` object includes recipient
 * emails (`to: string[]`), `from`, `subject`, etc. that are PII or
 * PII-adjacent. Convex dashboard rows are observable; we keep only the
 * identifying metadata. Deeper inspection lives in the Resend dashboard
 * via `emailMessageId`.
 *
 * Returns `{ inserted, reason }` so the caller can distinguish first-write
 * from a retry.
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

// Convex paginate caps at 16,384 docs per page; we pick a smaller page so
// each query execution stays well under its read budget and finishes
// quickly. At 4096/page, a 30k-recipient `email.delivered` count is 8
// pages — comfortably under the 10s action time limit even with network
// jitter, and still 1 page for any event type with <4k events.
const PAGE_SIZE = 4096;

/**
 * Internal helper — one paginated page of event counts for a given
 * (broadcastId, eventType). Each call is its own function execution, so
 * the 16,384-doc per-query read budget resets between pages.
 *
 * Exported only so Convex's code-gen includes it in the `internal` API
 * map (consumed by `getBroadcastStats` below via
 * `internal.broadcast.metrics._countBroadcastEventsPage`). Callers
 * outside this module should use `getBroadcastStats` instead — the `_`
 * prefix signals that this is an implementation detail.
 */
export const _countBroadcastEventsPage = internalQuery({
  args: {
    broadcastId: v.string(),
    eventType: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { broadcastId, eventType, cursor }) => {
    const result = await ctx.db
      .query("broadcastEvents")
      .withIndex("by_broadcast_event", (q) =>
        q.eq("broadcastId", broadcastId).eq("eventType", eventType),
      )
      .paginate({ cursor, numItems: PAGE_SIZE });
    return {
      count: result.page.length,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

/**
 * Live aggregate for one broadcast. Designed for operator polling during
 * a canary send — call from a watch script every few seconds and stop
 * the rollout the moment a kill-gate trips.
 *
 * Implementation: an internal action that iterates `broadcastEvents` per
 * tracked event type via `_countBroadcastEventsPage`. Read cost per stats
 * call is O(total events / PAGE_SIZE), but each page is a separate query
 * execution with its own read budget so we are not capped by Convex's
 * 16,384-doc per-query limit. At 30k recipients × 8 event types, expect
 * ~10-15 page reads per call (most event types fit in 1 page).
 *
 * This is an action (not a query) because Convex queries can't paginate
 * across executions — they're a single read transaction. The action
 * pattern lets us stitch arbitrary numbers of pages together.
 *
 * Consistency: each page read is its own query snapshot, so events
 * inserted between page reads for the same eventType could appear in
 * more than one page or be missed entirely. Counts are eventually
 * consistent during a live send (when webhooks are still arriving), and
 * exact once the send settles. For canary kill-gate use this is
 * harmless — thresholds converge as soon as inflow stops, well before
 * any operator decision based on them.
 */
export const getBroadcastStats = internalAction({
  args: { broadcastId: v.string() },
  handler: async (ctx, { broadcastId }): Promise<BroadcastStats> => {
    const counts: Record<string, number> = {};
    for (const eventType of BROADCAST_TRACKED_EVENT_TYPES) {
      let total = 0;
      let cursor: string | null = null;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const page: {
          count: number;
          isDone: boolean;
          continueCursor: string;
        } = await ctx.runQuery(
          internal.broadcast.metrics._countBroadcastEventsPage,
          { broadcastId, eventType, cursor },
        );
        total += page.count;
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
      counts[eventType] = total;
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
