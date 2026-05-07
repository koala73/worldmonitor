/**
 * One-time backfill: populate `customers.normalizedEmail` on rows
 * that predate the field's introduction.
 *
 * Required before the PRO-launch broadcast — the dedup query
 * (`registrations` − `emailSuppressions` − paying-customers) joins
 * on `normalizedEmail`, and rows missing the field would otherwise
 * fall through and receive a "buy PRO!" email despite already paying.
 *
 * Idempotent: only reads rows where `normalizedEmail` is missing.
 * Paginated: pass a `batchSize` (default 500). Re-run until `done: true`.
 *
 * Usage:
 *   npx convex run payments/backfillCustomerNormalizedEmail:backfill
 *   npx convex run payments/backfillCustomerNormalizedEmail:backfill '{"batchSize":1000}'
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

export const backfill = internalMutation({
  args: {
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, { batchSize }) => {
    const limit = batchSize ?? 500;

    // Filter for missing normalizedEmail keeps reads proportional to batchSize
    // instead of scanning the entire `customers` table on every call (which
    // would hit Convex's 16,384-document read limit once the table grows).
    // Once we patch a row (even to empty string) it drops out of this filter,
    // so the backfill drains in O(N/limit) calls and self-terminates.
    const rows = await ctx.db
      .query("customers")
      .filter((q) => q.eq(q.field("normalizedEmail"), undefined))
      .take(limit);

    let patched = 0;
    let emptyEmail = 0;

    for (const row of rows) {
      const computed = (row.email ?? "").trim().toLowerCase();
      if (computed.length === 0) {
        emptyEmail++;
        await ctx.db.patch(row._id, { normalizedEmail: "" });
      } else {
        await ctx.db.patch(row._id, { normalizedEmail: computed });
      }
      patched++;
    }

    const done = rows.length < limit;
    return { read: rows.length, patched, emptyEmail, done };
  },
});

/**
 * Diagnostic: how many customer rows still need backfilling?
 * `internalQuery` so it can only be invoked from server contexts (CLI / scheduler),
 * not by authenticated clients — comment intent now matches the export.
 */
export const countPending = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("customers").collect();
    let pending = 0;
    let withEmail = 0;
    const total = all.length;
    for (const row of all) {
      if (!row.normalizedEmail || row.normalizedEmail.length === 0) pending++;
      if (row.email && row.email.length > 0) withEmail++;
    }
    return { total, pending, withEmail };
  },
});
