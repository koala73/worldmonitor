import { internalMutation, mutation, query } from "./_generated/server";
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

    // Credit the referrer. Two code spaces can match:
    //   1. registrations.referralCode — 6-char email-derived codes
    //      assigned to waitlist entries before signup. Credit lives
    //      on `registrations.referralCount` for the matching row.
    //   2. userReferralCodes.code — 8-char HMAC codes assigned to
    //      signed-in Clerk users via the share-button feature. The
    //      referrer has no registrations row, so credit lives on
    //      the separate `userReferralCredits` table.
    //
    // Try (1) first for backwards-compatibility with existing
    // waitlist referrals, then fall through to (2). Never credits
    // both — the two namespaces are disjoint by design (6-char vs
    // 8-char hex).
    if (args.referredBy) {
      const registrationReferrer = await ctx.db
        .query("registrations")
        .withIndex("by_referral_code", (q) => q.eq("referralCode", args.referredBy))
        .first();
      if (registrationReferrer) {
        await ctx.db.patch(registrationReferrer._id, {
          referralCount: (registrationReferrer.referralCount ?? 0) + 1,
        });
      } else {
        const clerkReferrer = await ctx.db
          .query("userReferralCodes")
          .withIndex("by_code", (q) => q.eq("code", args.referredBy as string))
          .first();
        if (clerkReferrer) {
          // Dedupe by (referrer, email). Returning visitors who
          // re-submit the waitlist form must not double-credit.
          const existingCredit = await ctx.db
            .query("userReferralCredits")
            .withIndex("by_referrer_email", (q) =>
              q.eq("referrerUserId", clerkReferrer.userId).eq("refereeEmail", normalizedEmail),
            )
            .first();
          if (!existingCredit) {
            await ctx.db.insert("userReferralCredits", {
              referrerUserId: clerkReferrer.userId,
              refereeEmail: normalizedEmail,
              createdAt: Date.now(),
            });
          }
        }
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
 * Phase 9 / Todo #223: bind a Clerk-derived 8-char share code to a
 * Clerk userId so future /pro?ref=<code> visitors can be credited
 * back to the sharer. Idempotent — the same (userId, code) pair is
 * inserted at most once. Called by /api/referral/me on every call
 * so the mapping is live by the time anyone clicks a shared link.
 *
 * Code collisions: the Clerk HMAC space is 4B slots; at our scale
 * collisions are a rounding error. If the same code somehow maps
 * to two userIds we keep the first write and ignore the second —
 * the later-registered user will simply not be creditable through
 * the share flow. An alert on this log is appropriate operational
 * signal that it's time to rotate the signing secret.
 */
export const registerUserReferralCode = internalMutation({
  args: { userId: v.string(), code: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("userReferralCodes")
      .withIndex("by_code", (q) => q.eq("code", args.code))
      .first();
    if (existing) {
      if (existing.userId !== args.userId) {
        console.warn(
          `[referral] code collision: ${args.code} first bound to ${existing.userId}, ignoring request from ${args.userId}`,
        );
      }
      return { isNew: false };
    }
    await ctx.db.insert("userReferralCodes", {
      userId: args.userId,
      code: args.code,
      createdAt: Date.now(),
    });
    return { isNew: true };
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
