import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const VALID_FREQUENCIES = ["hourly", "2h", "6h", "daily", "weekly", "monthly"] as const;
const VALID_VARIANTS = ["full", "tech", "finance", "happy"] as const;

const FREQUENCY_MS: Record<string, number> = {
    hourly: 3_600_000,
    "2h": 7_200_000,
    "6h": 21_600_000,
    daily: 86_400_000,
    weekly: 604_800_000,
    monthly: 2_592_000_000,
};

export const subscribe = mutation({
    args: {
        email: v.string(),
        frequency: v.string(),
        variant: v.string(),
        lang: v.string(),
        categories: v.array(v.string()),
    },
    handler: async (ctx, args) => {
        const normalizedEmail = args.email.trim().toLowerCase();

        if (!VALID_FREQUENCIES.includes(args.frequency as typeof VALID_FREQUENCIES[number])) {
            throw new Error(`Invalid frequency: ${args.frequency}`);
        }
        if (!VALID_VARIANTS.includes(args.variant as typeof VALID_VARIANTS[number])) {
            throw new Error(`Invalid variant: ${args.variant}`);
        }

        const existing = await ctx.db
            .query("digestSubscriptions")
            .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", normalizedEmail))
            .first();

        if (existing) {
            if (existing.confirmed) {
                return { status: "already_subscribed" as const, token: existing.token };
            }
            // Unconfirmed — return token to resend confirmation
            return { status: "pending" as const, token: existing.token };
        }

        const token = crypto.randomUUID();
        await ctx.db.insert("digestSubscriptions", {
            email: args.email.trim(),
            normalizedEmail,
            frequency: args.frequency,
            variant: args.variant,
            lang: args.lang,
            categories: args.categories,
            token,
            confirmed: false,
            createdAt: Date.now(),
        });

        return { status: "subscribed" as const, token };
    },
});

export const confirm = mutation({
    args: { token: v.string() },
    handler: async (ctx, args) => {
        const sub = await ctx.db
            .query("digestSubscriptions")
            .withIndex("by_token", (q) => q.eq("token", args.token))
            .first();

        if (!sub) {
            return { status: "not_found" as const };
        }

        if (sub.confirmed) {
            return { status: "already_confirmed" as const };
        }

        await ctx.db.patch(sub._id, { confirmed: true });
        return { status: "confirmed" as const };
    },
});

export const unsubscribe = mutation({
    args: { token: v.string() },
    handler: async (ctx, args) => {
        const sub = await ctx.db
            .query("digestSubscriptions")
            .withIndex("by_token", (q) => q.eq("token", args.token))
            .first();

        if (!sub) {
            return { status: "not_found" as const };
        }

        await ctx.db.delete(sub._id);
        return { status: "unsubscribed" as const };
    },
});

export const updatePreferences = mutation({
    args: {
        token: v.string(),
        frequency: v.optional(v.string()),
        categories: v.optional(v.array(v.string())),
        variant: v.optional(v.string()),
        lang: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const sub = await ctx.db
            .query("digestSubscriptions")
            .withIndex("by_token", (q) => q.eq("token", args.token))
            .first();

        if (!sub) {
            return { status: "not_found" as const };
        }

        const patch: Record<string, unknown> = {};
        if (args.frequency !== undefined) {
            if (!VALID_FREQUENCIES.includes(args.frequency as typeof VALID_FREQUENCIES[number])) {
                throw new Error(`Invalid frequency: ${args.frequency}`);
            }
            patch.frequency = args.frequency;
        }
        if (args.variant !== undefined) {
            if (!VALID_VARIANTS.includes(args.variant as typeof VALID_VARIANTS[number])) {
                throw new Error(`Invalid variant: ${args.variant}`);
            }
            patch.variant = args.variant;
        }
        if (args.categories !== undefined) patch.categories = args.categories;
        if (args.lang !== undefined) patch.lang = args.lang;

        await ctx.db.patch(sub._id, patch);
        return { status: "updated" as const };
    },
});

export const getByToken = query({
    args: { token: v.string() },
    handler: async (ctx, args) => {
        return ctx.db
            .query("digestSubscriptions")
            .withIndex("by_token", (q) => q.eq("token", args.token))
            .first();
    },
});

export const getDueSubscriptions = query({
    args: {},
    handler: async (ctx) => {
        const now = Date.now();
        const results: Array<{
            _id: string;
            email: string;
            frequency: string;
            variant: string;
            lang: string;
            categories: string[];
            token: string;
        }> = [];

        for (const freq of VALID_FREQUENCIES) {
            const windowMs = FREQUENCY_MS[freq];
            if (!windowMs) continue;

            const subs = await ctx.db
                .query("digestSubscriptions")
                .withIndex("by_confirmed_frequency", (q) =>
                    q.eq("confirmed", true).eq("frequency", freq),
                )
                .collect();

            for (const sub of subs) {
                const lastSent = sub.lastSentAt ?? 0;
                if (now - lastSent >= windowMs) {
                    results.push({
                        _id: sub._id as string,
                        email: sub.email,
                        frequency: sub.frequency,
                        variant: sub.variant,
                        lang: sub.lang,
                        categories: sub.categories,
                        token: sub.token,
                    });
                }
            }
        }

        return results;
    },
});

export const markSent = mutation({
    args: {
        ids: v.array(v.id("digestSubscriptions")),
    },
    handler: async (ctx, args) => {
        const now = Date.now();
        for (const id of args.ids) {
            await ctx.db.patch(id, { lastSentAt: now });
        }
        return { status: "ok" as const, count: args.ids.length };
    },
});
