/**
 * One-time backfill: populate `customers.normalizedEmail` on rows
 * that predate the field's introduction.
 *
 * Required before the PRO-launch broadcast — the dedup query
 * (`registrations` − `emailSuppressions` − paying-customers) joins
 * on `normalizedEmail`, and rows missing the field would otherwise
 * fall through and receive a "buy PRO!" email despite already paying.
 *
 * Idempotent: skips rows that already have a non-empty `normalizedEmail`.
 * Paginated: pass a `batchSize` (default 500). Re-run until `done: true`.
 *
 * Usage:
 *   npx convex run payments/backfillCustomerNormalizedEmail:backfill
 *   npx convex run payments/backfillCustomerNormalizedEmail:backfill '{"batchSize":1000}'
 */
import { v } from "convex/values";
import { internalMutation, query } from "../_generated/server";

export const backfill = internalMutation({
  args: {
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, { batchSize }) => {
    const limit = batchSize ?? 500;
    const all = await ctx.db.query("customers").collect();

    let scanned = 0;
    let patched = 0;
    let alreadySet = 0;
    let emptyEmail = 0;

    for (const row of all) {
      scanned++;

      if (row.normalizedEmail && row.normalizedEmail.length > 0) {
        alreadySet++;
        continue;
      }

      const computed = (row.email ?? "").trim().toLowerCase();
      if (computed.length === 0) {
        emptyEmail++;
        await ctx.db.patch(row._id, { normalizedEmail: "" });
        continue;
      }

      await ctx.db.patch(row._id, { normalizedEmail: computed });
      patched++;
      if (patched >= limit) break;
    }

    const remaining = all.length - scanned;
    const done = remaining === 0;
    return { total: all.length, scanned, patched, alreadySet, emptyEmail, remaining, done };
  },
});

/**
 * Diagnostic: how many customer rows still need backfilling?
 * Returns an exact count (full scan — only run from CLI, not hot paths).
 */
export const countPending = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("customers").collect();
    let pending = 0;
    let withEmail = 0;
    let total = all.length;
    for (const row of all) {
      if (!row.normalizedEmail || row.normalizedEmail.length === 0) pending++;
      if (row.email && row.email.length > 0) withEmail++;
    }
    return { total, pending, withEmail };
  },
});
