/**
 * State change behind the one-click unsubscribe endpoint
 * (POST /email/unsubscribe in convex/http.ts; token in lib/emailUnsubscribe).
 *
 * - "brief":     removes the email channel from the user's digest rules
 *                (digestMode daily / twice_daily / weekly).
 * - "alerts":    removes the email channel from the user's real-time rules
 *                (digestMode absent or "realtime").
 * - "marketing": records a broadcast-style `unsubscribe` suppression for the
 *                user's known addresses (account, customer and subscription
 *                checkout emails). That blocks winback and broadcasts
 *                (purpose "marketing") but still lets account and billing
 *                mail through, matching the existing Resend unsubscribe
 *                semantics in emailSuppressions.ts.
 *
 * The digest cron and the alert relay read rules and channels fresh from
 * Convex on every send, so the change applies to the very next send. Other
 * channels (Telegram, Slack, ...) on the same rules are untouched, and the
 * user can re-enable email in Settings at any time.
 */

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

function isDigestRule(digestMode: string | undefined): boolean {
  return digestMode !== undefined && digestMode !== "realtime";
}

export const applyUnsubscribe = internalMutation({
  args: {
    userId: v.string(),
    list: v.union(v.literal("brief"), v.literal("alerts"), v.literal("marketing")),
  },
  handler: async (ctx, args): Promise<{ changed: number }> => {
    if (args.list === "marketing") {
      const customer = await ctx.db
        .query("customers")
        .withIndex("by_userId", (q) => q.eq("userId", args.userId))
        .first();
      const user = await ctx.db
        .query("users")
        .withIndex("by_userId", (q) => q.eq("userId", args.userId))
        .first();
      // Winback addresses the subscription's checkout email first
      // (getDunningContext), so include those alongside the account emails.
      const subscriptions = await ctx.db
        .query("subscriptions")
        .withIndex("by_userId", (q) => q.eq("userId", args.userId))
        // Uncapped: winback can address any of the user's subscriptions, so
        // every checkout address must be covered (a user has a handful).
        .collect();
      const checkoutEmails = subscriptions.map(
        (sub) => (sub.rawPayload as { customer?: { email?: unknown } } | null)?.customer?.email,
      );
      const emails = new Set(
        [customer?.email, user?.email, ...checkoutEmails]
          .filter((e): e is string => typeof e === "string" && e.includes("@"))
          .map((e) => e.trim().toLowerCase()),
      );
      let changed = 0;
      for (const normalizedEmail of emails) {
        const existing = await ctx.db
          .query("emailSuppressions")
          .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", normalizedEmail))
          .first();
        // Any existing row already blocks marketing mail; never downgrade a
        // bounce/complaint/manual row to a broadcast-only unsubscribe.
        if (existing) continue;
        await ctx.db.insert("emailSuppressions", {
          normalizedEmail,
          reason: "unsubscribe",
          suppressedAt: Date.now(),
          source: "one-click-unsubscribe:marketing",
        });
        changed++;
      }
      return { changed };
    }

    const rules = await ctx.db
      .query("alertRules")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    let changed = 0;
    for (const rule of rules) {
      const matches = args.list === "brief" ? isDigestRule(rule.digestMode) : !isDigestRule(rule.digestMode);
      if (!matches || !rule.channels.includes("email")) continue;
      await ctx.db.patch(rule._id, {
        channels: rule.channels.filter((channel) => channel !== "email"),
        updatedAt: Date.now(),
      });
      changed++;
    }
    return { changed };
  },
});
