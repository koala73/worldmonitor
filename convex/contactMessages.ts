import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const submit = mutation({
  args: {
    name: v.string(),
    email: v.string(),
    organization: v.optional(v.string()),
    phone: v.optional(v.string()),
    message: v.optional(v.string()),
    source: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("contactMessages", {
      name: args.name,
      email: args.email,
      organization: args.organization,
      phone: args.phone,
      message: args.message,
      source: args.source,
      receivedAt: Date.now(),
    });
    return { status: "sent" as const };
  },
});
