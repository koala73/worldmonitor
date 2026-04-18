import { internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { DatabaseReader, DatabaseWriter } from "./_generated/server";

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

async function generateUniqueReferralCode(
  db: DatabaseReader,
  email: string,
): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const input = attempt === 0 ? email : `${email}:${attempt}`;
    const code = hashCode(input).toString(36).padStart(6, "0").slice(0, 8);
    const existing = await db
      .query("registrations")
      .withIndex("by_referral_code", (q) => q.eq("referralCode", code))
      .first();
    if (!existing) return code;
  }
  // Fallback: timestamp-based code (extremely unlikely path)
  return Date.now().toString(36).slice(-8);
}

async function getCounter(db: DatabaseReader, name: string): Promise<number> {
  const counter = await db
    .query("counters")
    .withIndex("by_name", (q) => q.eq("name", name))
    .first();
  return counter?.value ?? 0;
}

async function incrementCounter(db: DatabaseWriter, name: string): Promise<number> {
  const counter = await db
    .query("counters")
    .withIndex("by_name", (q) => q.eq("name", name))
    .first();
  const newVal = (counter?.value ?? 0) + 1;
  if (counter) {
    await db.patch(counter._id, { value: newVal });
  } else {
    await db.insert("counters", { name, value: newVal });
  }
  return newVal;
}

export const register = mutation({
  args: {
    email: v.string(),
    source: v.optional(v.string()),
    appVersion: v.optional(v.string()),
    referredBy: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const normalizedEmail = args.email.trim().toLowerCase();

    const existing = await ctx.db
      .query("registrations")
      .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", normalizedEmail))
      .first();

    if (existing) {
      let code = existing.referralCode;
      if (!code) {
        code = await generateUniqueReferralCode(ctx.db, normalizedEmail);
        await ctx.db.patch(existing._id, { referralCode: code });
      }
      return {
        status: "already_registered" as const,
        referralCode: code,
        referralCount: existing.referralCount ?? 0,
      };
    }

    const referralCode = await generateUniqueReferralCode(ctx.db, normalizedEmail);

    // Credit the referrer
    if (args.referredBy) {
      const referrer = await ctx.db
        .query("registrations")
        .withIndex("by_referral_code", (q) => q.eq("referralCode", args.referredBy))
        .first();
      if (referrer) {
        await ctx.db.patch(referrer._id, {
          referralCount: (referrer.referralCount ?? 0) + 1,
        });
      }
    }

    const position = await incrementCounter(ctx.db, "registrations_total");

    await ctx.db.insert("registrations", {
      email: args.email.trim(),
      normalizedEmail,
      registeredAt: Date.now(),
      source: args.source ?? "unknown",
      appVersion: args.appVersion ?? "unknown",
      referralCode,
      referredBy: args.referredBy,
      referralCount: 0,
    });

    const suppressed = await ctx.db
      .query("emailSuppressions")
      .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", normalizedEmail))
      .first();

    return {
      status: "registered" as const,
      referralCode,
      referralCount: 0,
      position,
      emailSuppressed: !!suppressed,
    };
  },
});

/**
 * Phase 9 / Todo #223: count registrations attributed to a referral code.
 *
 * Called by the relay-path `/relay/referral-stats` HTTP action.
 * Privacy: returns counts only, never emails. Handles both
 * `registrations.referralCode` (a user's own code) and collisions
 * between the 6-char registrations namespace and the 8-char
 * Clerk-derived namespace — the filter on `by_referral_code` is
 * exact-match, so the two namespaces coexist safely.
 */
export const getReferralStatsByCode = internalQuery({
  args: { referralCode: v.string() },
  handler: async (ctx, args) => {
    // Count the registrations rows that named this code as their
    // referredBy. The table has no index on referredBy, so we scan —
    // acceptable at current scale (< 10k rows). If this becomes hot,
    // add an `.index("by_referred_by", ["referredBy"])` and migrate.
    const all = await ctx.db.query("registrations").collect();
    let invitedCount = 0;
    for (const r of all) {
      if (r.referredBy === args.referralCode) invitedCount += 1;
    }
    return { invitedCount };
  },
});

export const getPosition = query({
  args: { referralCode: v.string() },
  handler: async (ctx, args) => {
    const reg = await ctx.db
      .query("registrations")
      .withIndex("by_referral_code", (q) => q.eq("referralCode", args.referralCode))
      .first();
    if (!reg) return null;

    const total = await getCounter(ctx.db, "registrations_total");

    return {
      referralCount: reg.referralCount ?? 0,
      total,
    };
  },
});
