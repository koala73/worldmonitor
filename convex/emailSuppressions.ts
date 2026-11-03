import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";

/** The suppression row for an address, matched on its trimmed lowercase form. */
export async function findEmailSuppression(
  ctx: QueryCtx | MutationCtx,
  email: string,
): Promise<Doc<"emailSuppressions"> | null> {
  const normalizedEmail = email.trim().toLowerCase();
  return await ctx.db
    .query("emailSuppressions")
    .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", normalizedEmail))
    .first();
}

export const suppress = internalMutation({
  args: {
    email: v.string(),
    reason: v.union(
      v.literal("bounce"),
      v.literal("complaint"),
      v.literal("manual"),
      v.literal("unsubscribe"),
    ),
    source: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const normalizedEmail = args.email.trim().toLowerCase();

    const existing = await ctx.db
      .query("emailSuppressions")
      .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", normalizedEmail))
      .first();

    if (existing) {
      // A Resend unsubscribe applies to broadcasts only. Do not let it erase
      // a hard delivery suppression that also protects transactional mail.
      // Conversely, a later delivery failure upgrades a broadcast-only row.
      if (existing.reason === "unsubscribe" && args.reason !== "unsubscribe") {
        await ctx.db.patch(existing._id, {
          reason: args.reason,
          suppressedAt: Date.now(),
          source: args.source,
        });
      }
      return existing._id;
    }

    return await ctx.db.insert("emailSuppressions", {
      normalizedEmail,
      reason: args.reason,
      suppressedAt: Date.now(),
      source: args.source,
    });
  },
});

export const isEmailSuppressed = internalQuery({
  args: {
    email: v.string(),
    purpose: v.union(v.literal("transactional"), v.literal("marketing")),
  },
  handler: async (ctx, args) => {
    const entry = await findEmailSuppression(ctx, args.email);
    // Broadcast exporters consume every emailSuppressions row. Transactional
    // senders may deliver account and payment notices after a broadcast
    // opt-out; marketing senders must retain that opt-out.
    return !!entry && (entry.reason !== "unsubscribe" || args.purpose === "marketing");
  },
});

export const bulkSuppress = internalMutation({
  args: {
    emails: v.array(v.object({
      email: v.string(),
      reason: v.union(v.literal("bounce"), v.literal("complaint"), v.literal("manual")),
      source: v.optional(v.string()),
    })),
  },
  handler: async (ctx, args) => {
    let added = 0;
    let skipped = 0;
    let upgraded = 0;
    for (const entry of args.emails) {
      const normalizedEmail = entry.email.trim().toLowerCase();
      const existing = await ctx.db
        .query("emailSuppressions")
        .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", normalizedEmail))
        .first();

      if (existing) {
        // Keep bulk imports consistent with suppress: a later delivery block
        // upgrades a broadcast-only unsubscribe, so transactional sends stop.
        if (existing.reason === "unsubscribe") {
          await ctx.db.patch(existing._id, {
            reason: entry.reason,
            suppressedAt: Date.now(),
            source: entry.source,
          });
          upgraded++;
          continue;
        }
        skipped++;
        continue;
      }

      await ctx.db.insert("emailSuppressions", {
        normalizedEmail,
        reason: entry.reason,
        suppressedAt: Date.now(),
        source: entry.source,
      });
      added++;
    }
    return { added, skipped, upgraded };
  },
});

export const remove = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const normalizedEmail = args.email.trim().toLowerCase();
    const entry = await ctx.db
      .query("emailSuppressions")
      .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", normalizedEmail))
      .first();

    if (entry) {
      await ctx.db.delete(entry._id);
      return true;
    }
    return false;
  },
});

/**
 * Soft-bounce policy (Resend webhook, see convex/resendWebhookHandler.ts).
 *
 * Resend reports a bounce's class in `data.bounce.type`:
 *   - "Permanent" (hard bounce): suppressed at once via `suppress`.
 *   - "Transient" (soft bounce, e.g. MailboxFull) and "Undetermined": one
 *     strike per Resend message. SOFT_BOUNCE_SUPPRESS_THRESHOLD strikes inside
 *     SOFT_BOUNCE_WINDOW_MS suppress the address with reason "bounce".
 *
 * 3 strikes in 30 days: a daily-brief recipient whose mailbox stays full or
 * whose server keeps refusing us for most of a week is suppressed before the
 * failures drag on sender reputation, while one or two transient blips in a
 * month never suppress anyone. An `email.delivered` for the address clears
 * the strikes that happened before it, so the count only grows while the
 * mailbox keeps failing. Bounces older than the window, or older than a
 * later delivery, are stale and never count (webhooks can arrive late and
 * out of order).
 *
 * `email.delivery_delayed` is not a strike: Resend keeps retrying and later
 * emits `email.delivered` or `email.bounced` for the same message, so counting
 * the delay would double-count it and punish greylisting servers.
 * Content-caused transient subtypes (MessageTooLarge, ContentRejected,
 * AttachmentRejected) describe our message, not the mailbox, so they are not
 * strikes either.
 */
export const SOFT_BOUNCE_SUPPRESS_THRESHOLD = 3;
export const SOFT_BOUNCE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

async function readReset(ctx: MutationCtx, normalizedEmail: string) {
  return await ctx.db
    .query("emailSoftBounceResets")
    .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", normalizedEmail))
    .first();
}

export const recordSoftBounce = internalMutation({
  args: {
    email: v.string(),
    emailMessageId: v.string(),
    bounceType: v.string(),
    bounceSubType: v.optional(v.string()),
    occurredAt: v.number(),
    source: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const normalizedEmail = args.email.trim().toLowerCase();
    const now = Date.now();
    const windowStart = now - SOFT_BOUNCE_WINDOW_MS;
    // A provider timestamp in the future is clamped to now. One older than
    // the window is stale (a replay or a long-delayed delivery) and never
    // counts.
    const occurredAt = Math.min(args.occurredAt, now);

    const existingSuppression = await ctx.db
      .query("emailSuppressions")
      .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", normalizedEmail))
      .first();
    if (existingSuppression && existingSuppression.reason !== "unsubscribe") {
      return { strikes: 0, suppressed: true, ignored: true };
    }

    const reset = await readReset(ctx, normalizedEmail);
    if (reset && reset.lastDeliveredAt < windowStart) {
      await ctx.db.delete(reset._id);
    }
    const lastDeliveredAt = reset && reset.lastDeliveredAt >= windowStart
      ? reset.lastDeliveredAt
      : null;

    const rows = await ctx.db
      .query("emailSoftBounces")
      .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", normalizedEmail))
      .collect();
    const live = [];
    for (const row of rows) {
      if (row.occurredAt < windowStart) {
        await ctx.db.delete(row._id);
      } else {
        live.push(row);
      }
    }

    // Stale evidence: outside the window, or older than a later delivery
    // that already proved the mailbox works.
    const stale = occurredAt < windowStart
      || (lastDeliveredAt !== null && occurredAt <= lastDeliveredAt);
    const duplicate = live.some((row) => row.emailMessageId === args.emailMessageId);
    if (stale || duplicate) {
      return { strikes: live.length, suppressed: false, ignored: true };
    }

    const id = await ctx.db.insert("emailSoftBounces", {
      normalizedEmail,
      emailMessageId: args.emailMessageId,
      bounceType: args.bounceType,
      bounceSubType: args.bounceSubType,
      occurredAt,
    });
    const inserted = await ctx.db.get(id);
    if (inserted) live.push(inserted);

    const strikes = live.length;
    if (strikes < SOFT_BOUNCE_SUPPRESS_THRESHOLD) {
      return { strikes, suppressed: false, ignored: false };
    }

    const source = `soft-bounce:${strikes}-in-30d${args.source ? `:${args.source}` : ""}`;
    if (existingSuppression) {
      // Upgrade a broadcast-only unsubscribe, matching `suppress`.
      await ctx.db.patch(existingSuppression._id, {
        reason: "bounce",
        suppressedAt: now,
        source,
      });
    } else {
      await ctx.db.insert("emailSuppressions", {
        normalizedEmail,
        reason: "bounce",
        suppressedAt: now,
        source,
      });
    }
    for (const row of live) await ctx.db.delete(row._id);
    if (reset) {
      const stillThere = await ctx.db.get(reset._id);
      if (stillThere) await ctx.db.delete(reset._id);
    }
    return { strikes, suppressed: true, ignored: false };
  },
});

/**
 * A delivered message proves the mailbox worked at `deliveredAt`: drop the
 * strikes that happened before it and remember the time, so an older bounce
 * that arrives late cannot restart the count. Strikes after `deliveredAt`
 * (a newer failure whose webhook beat this one) are kept.
 */
export const clearSoftBounces = internalMutation({
  args: { email: v.string(), deliveredAt: v.number() },
  handler: async (ctx, args) => {
    const normalizedEmail = args.email.trim().toLowerCase();
    const deliveredAt = Math.min(args.deliveredAt, Date.now());
    const rows = await ctx.db
      .query("emailSoftBounces")
      .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", normalizedEmail))
      .collect();
    let cleared = 0;
    for (const row of rows) {
      if (row.occurredAt <= deliveredAt) {
        await ctx.db.delete(row._id);
        cleared++;
      }
    }
    const reset = await readReset(ctx, normalizedEmail);
    if (reset) {
      if (deliveredAt > reset.lastDeliveredAt) {
        await ctx.db.patch(reset._id, { lastDeliveredAt: deliveredAt });
      }
    } else {
      await ctx.db.insert("emailSoftBounceResets", { normalizedEmail, lastDeliveredAt: deliveredAt });
    }
    return cleared;
  },
});

/** Expired strikes and delivery watermarks cannot affect the current window. */
export const pruneSoftBounceData = internalMutation({
  args: { cutoff: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const cutoff = args.cutoff ?? Date.now() - SOFT_BOUNCE_WINDOW_MS;
    const batch = 500;
    const strikes = await ctx.db
      .query("emailSoftBounces")
      .withIndex("by_occurred_at", (q) => q.lt("occurredAt", cutoff))
      .take(batch);
    const resets = await ctx.db
      .query("emailSoftBounceResets")
      .withIndex("by_last_delivered_at", (q) => q.lt("lastDeliveredAt", cutoff))
      .take(batch);
    for (const row of strikes) await ctx.db.delete(row._id);
    for (const row of resets) await ctx.db.delete(row._id);
    const rescheduled = strikes.length === batch || resets.length === batch;
    if (rescheduled) {
      await ctx.scheduler.runAfter(0, internal.emailSuppressions.pruneSoftBounceData, { cutoff });
    }
    return { strikesDeleted: strikes.length, resetsDeleted: resets.length, rescheduled };
  },
});
