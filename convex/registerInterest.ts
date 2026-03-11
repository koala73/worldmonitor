import { mutation } from "./_generated/server";
import { v } from "convex/values";

const EMAIL_MAX_LENGTH = 254; // RFC 5321 maximum
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Simple source-keyed rate limit: max 5 registrations per hour per source.
// Convex doesn't expose the client IP natively, so we use the caller-supplied
// source field as a best-effort abuse signal.
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT = 5;

export const register = mutation({
  args: {
    email: v.string(),
    source: v.optional(v.string()),
    appVersion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Validate email format and length before any DB work.
    const rawEmail = args.email.trim();
    if (!rawEmail || rawEmail.length > EMAIL_MAX_LENGTH || !EMAIL_REGEX.test(rawEmail)) {
      return { status: "invalid_email" as const };
    }

    // Rate limit: reject if the same source has registered too many times recently.
    const source = (args.source ?? "unknown").slice(0, 100);
    const windowStart = Date.now() - RATE_WINDOW_MS;
    const recentFromSource = await ctx.db
      .query("registrations")
      .withIndex("by_registered_at", (q) => q.gte("registeredAt", windowStart))
      .filter((q) => q.eq(q.field("source"), source))
      .take(RATE_LIMIT + 1);
    if (recentFromSource.length > RATE_LIMIT) {
      return { status: "rate_limited" as const };
    }

    const normalizedEmail = rawEmail.toLowerCase();

    const existing = await ctx.db
      .query("registrations")
      .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", normalizedEmail))
      .first();

    if (existing) {
      return { status: "already_registered" as const };
    }

    await ctx.db.insert("registrations", {
      email: rawEmail,
      normalizedEmail,
      registeredAt: Date.now(),
      source,
      appVersion: (args.appVersion ?? "unknown").slice(0, 50),
    });

    return { status: "registered" as const };
  },
});
