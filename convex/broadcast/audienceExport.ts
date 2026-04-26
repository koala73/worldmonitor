/**
 * PRO-launch broadcast — audience export pipeline.
 *
 * Builds the deduped waitlist audience and pushes contacts to a Resend
 * Audience for one-shot launch broadcasting via Resend Broadcasts.
 *
 * Dedup formula:
 *   registrations
 *     − emailSuppressions (hard bounces, complaints, manual)
 *     − customers (anyone who has been through Dodo checkout — never pitch
 *       PRO to people who already paid)
 *
 * Join key: `normalizedEmail` (lowercased + trimmed). Requires the
 * customers.normalizedEmail backfill (`payments/backfillCustomerNormalizedEmail:backfill`)
 * to have run; otherwise paid users with un-backfilled rows leak into the send.
 *
 * Usage (run from CLI; not callable by clients):
 *   npx convex run broadcast/audienceExport:exportProLaunchAudience \
 *     '{"audienceId":"aud_xxx"}'
 *
 *   # Subsequent pages — pass the continueCursor from the previous response
 *   npx convex run broadcast/audienceExport:exportProLaunchAudience \
 *     '{"audienceId":"aud_xxx","cursor":"<continueCursor>"}'
 *
 *   # Dry run — counts only, no Resend calls
 *   npx convex run broadcast/audienceExport:exportProLaunchAudience \
 *     '{"audienceId":"aud_xxx","dryRun":true}'
 *
 * Re-running a page is safe: Resend's contacts API returns 422
 * `already_exists` for emails already in the audience, which we count
 * separately (not as a failure).
 *
 * Operational sequence for a full export:
 *   1. Backfill customers.normalizedEmail (PR #3424 must be merged + deployed)
 *   2. Run countPending diagnostic to confirm 0 pending
 *   3. Loop this action until isDone:true, passing continueCursor each time
 *   4. Verify contact count in Resend dashboard matches `upserted + alreadyExists`
 */
import { v } from "convex/values";
import {
  internalAction,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";

const RESEND_API_BASE = "https://api.resend.com";

/**
 * Snapshot of suppressed normalizedEmails at call time.
 * Uses `.collect()` — bounded by the size of `emailSuppressions` (Convex's
 * 16,384-doc read limit). At current scale (low thousands of bounces) safe;
 * if the table grows past 16k, switch to a streamed/paginated count.
 */
export const getSuppressedEmails = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("emailSuppressions").collect();
    return all
      .map((row) => row.normalizedEmail)
      .filter((e): e is string => typeof e === "string" && e.length > 0);
  },
});

/**
 * Snapshot of paid (customer) normalizedEmails at call time.
 * Includes ALL customers regardless of subscription status — anyone who's
 * been through Dodo checkout is excluded from the launch pitch (active,
 * cancelled, expired all skip).
 *
 * Same `.collect()` caveat as above. Customers table is small relative to
 * registrations; this is acceptable.
 */
export const getPaidEmails = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("customers").collect();
    return all
      .map((row) => row.normalizedEmail)
      .filter((e): e is string => typeof e === "string" && e.length > 0);
  },
});

/**
 * Paginated page of registrations. Cursor-driven; pass `null` cursor for
 * the first page, then `continueCursor` from each response for the next.
 */
export const getRegistrationsPage = internalQuery({
  args: {
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (ctx, { cursor, numItems }) => {
    return await ctx.db
      .query("registrations")
      .paginate({ cursor, numItems });
  },
});

type ExportStats = {
  upserted: number;
  suppressedSkipped: number;
  paidSkipped: number;
  alreadyExists: number;
  failed: number;
  emptyEmail: number;
  isDone: boolean;
  continueCursor: string;
  pageProcessed: number;
};

export const exportProLaunchAudience = internalAction({
  args: {
    audienceId: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, { audienceId, cursor, numItems, dryRun }): Promise<ExportStats> => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey && !dryRun) {
      throw new Error(
        "[exportProLaunchAudience] RESEND_API_KEY not set (omit or set dryRun:true to test without sending)",
      );
    }

    // Default 200/page: at Resend's ~10 req/s rate limit that's ~20s of
    // wall time per page, comfortably under the 10-minute Convex action cap
    // even with retries and slow API responses.
    const pageSize = numItems ?? 200;
    const dry = dryRun ?? false;

    const [suppressed, paid] = await Promise.all([
      ctx.runQuery(internal.broadcast.audienceExport.getSuppressedEmails, {}),
      ctx.runQuery(internal.broadcast.audienceExport.getPaidEmails, {}),
    ]);
    const suppressedSet = new Set(suppressed);
    const paidSet = new Set(paid);

    const page = await ctx.runQuery(
      internal.broadcast.audienceExport.getRegistrationsPage,
      { cursor: cursor ?? null, numItems: pageSize },
    );

    const stats: ExportStats = {
      upserted: 0,
      suppressedSkipped: 0,
      paidSkipped: 0,
      alreadyExists: 0,
      failed: 0,
      emptyEmail: 0,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
      pageProcessed: page.page.length,
    };

    for (const row of page.page) {
      const email = row.normalizedEmail;
      if (!email || email.length === 0) {
        stats.emptyEmail++;
        continue;
      }
      if (suppressedSet.has(email)) {
        stats.suppressedSkipped++;
        continue;
      }
      if (paidSet.has(email)) {
        stats.paidSkipped++;
        continue;
      }

      if (dry) {
        stats.upserted++;
        continue;
      }

      const res = await fetch(
        `${RESEND_API_BASE}/audiences/${encodeURIComponent(audienceId)}/contacts`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ email, unsubscribed: false }),
        },
      );

      if (res.ok) {
        stats.upserted++;
      } else if (res.status === 409 || res.status === 422) {
        // Resend returns 422 with `name: "validation_error"` and message
        // mentioning duplicate when the email is already in the audience.
        // Treat as already-imported, not a failure.
        stats.alreadyExists++;
      } else {
        stats.failed++;
        const body = await res.text().catch(() => "<no body>");
        console.error(
          `[exportProLaunchAudience] Resend ${res.status} for ${email}: ${body}`,
        );
      }
    }

    console.log(
      `[exportProLaunchAudience] page complete: ${JSON.stringify(stats)}`,
    );

    return stats;
  },
});
