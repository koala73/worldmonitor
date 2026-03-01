import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  registrations: defineTable({
    email: v.string(),
    normalizedEmail: v.string(),
    registeredAt: v.number(),
    source: v.optional(v.string()),
    appVersion: v.optional(v.string()),
  }).index("by_normalized_email", ["normalizedEmail"]),

  digestSubscriptions: defineTable({
    email: v.string(),
    normalizedEmail: v.string(),
    frequency: v.string(),
    variant: v.string(),
    lang: v.string(),
    categories: v.array(v.string()),
    token: v.string(),
    confirmed: v.boolean(),
    createdAt: v.number(),
    lastSentAt: v.optional(v.number()),
  })
    .index("by_normalized_email", ["normalizedEmail"])
    .index("by_token", ["token"])
    .index("by_confirmed_frequency", ["confirmed", "frequency"]),
});
