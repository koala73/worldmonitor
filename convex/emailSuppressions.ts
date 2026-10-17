import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

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
    const normalizedEmail = args.email.trim().toLowerCase();
    const entry = await ctx.db
      .query("emailSuppressions")
      .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", normalizedEmail))
      .first();
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
 * month never suppress anyone. Any `email.delivered` for the address clears
 * its strikes, so the count only grows while the mailbox keeps failing.
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

    const existingSuppression = await ctx.db
      .query("emailSuppressions")
      .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", normalizedEmail))
      .first();
    if (existingSuppression && existingSuppression.reason !== "unsubscribe") {
      return { strikes: 0, suppressed: true };
    }

    const rows = await ctx.db
      .query("emailSoftBounces")
      .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", normalizedEmail))
      .collect();

    const windowStart = now - SOFT_BOUNCE_WINDOW_MS;
    const live = [];
    for (const row of rows) {
      if (row.occurredAt < windowStart) {
        await ctx.db.delete(row._id);
      } else {
        live.push(row);
      }
    }

    // Clamp provider timestamps into [windowStart, now] so a skewed or
    // missing created_at can neither backdate a strike out of the window
    // nor park it in the future.
    const occurredAt = Math.min(Math.max(args.occurredAt, windowStart), now);
    if (!live.some((row) => row.emailMessageId === args.emailMessageId)) {
      const id = await ctx.db.insert("emailSoftBounces", {
        normalizedEmail,
        emailMessageId: args.emailMessageId,
        bounceType: args.bounceType,
        bounceSubType: args.bounceSubType,
        occurredAt,
      });
      const inserted = await ctx.db.get(id);
      if (inserted) live.push(inserted);
    }

    const strikes = live.length;
    if (strikes < SOFT_BOUNCE_SUPPRESS_THRESHOLD) {
      return { strikes, suppressed: false };
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
    return { strikes, suppressed: true };
  },
});

/** A delivered message proves the mailbox works again: drop its strikes. */
export const clearSoftBounces = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const normalizedEmail = args.email.trim().toLowerCase();
    const rows = await ctx.db
      .query("emailSoftBounces")
      .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", normalizedEmail))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length;
  },
});
