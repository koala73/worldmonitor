/**
 * PRO-launch broadcast — audience export pipeline.
 *
 * Builds the deduped waitlist audience and pushes contacts to a Resend
 * Segment (formerly Audience) for one-shot launch broadcasting via Resend
 * Broadcasts.
 *
 * Dedup formula:
 *   registrations
 *     − emailSuppressions (hard bounces, complaints, manual)
 *     − customers (anyone who has been through Dodo checkout — never pitch
 *       PRO to people who already paid)
 *
 * Join key: `normalizedEmail` (lowercased + trimmed). Defense in depth:
 * `getPaidEmails` falls back to deriving the key from `customers.email`
 * if `normalizedEmail` is missing, so a missed/incomplete backfill no
 * longer leaks paid users into the audience.
 *
 * Usage (run from CLI; not callable by clients):
 *   npx convex run broadcast/audienceExport:exportProLaunchAudience \
 *     '{"segmentId":"seg_xxx"}'
 *
 *   # Subsequent pages — pass the continueCursor from the previous response
 *   npx convex run broadcast/audienceExport:exportProLaunchAudience \
 *     '{"segmentId":"seg_xxx","cursor":"<continueCursor>"}'
 *
 *   # Dry run — counts only, no Resend calls
 *   npx convex run broadcast/audienceExport:exportProLaunchAudience \
 *     '{"segmentId":"seg_xxx","dryRun":true}'
 *
 * Re-running a page is safe: Resend returns 422 with a duplicate-shaped
 * error body when the email is already in the segment; that path increments
 * `alreadyExists`. Other 422s (missing segment, invalid email, etc.) are
 * logged and counted as `failed` so they don't masquerade as duplicates.
 *
 * Operational sequence for a full export:
 *   1. Backfill customers.normalizedEmail (`payments/backfillCustomerNormalizedEmail:backfill`)
 *   2. Run `payments/backfillCustomerNormalizedEmail:countPending` to confirm 0 pending
 *   3. Loop this action until `isDone:true`, passing `continueCursor` each call
 *   4. Verify segment contact count in Resend dashboard matches `upserted + alreadyExists`
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
 *
 * `emailSuppressions.normalizedEmail` is a required field (non-optional in
 * the schema), so no fallback derivation is needed here.
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
 * Defense-in-depth fallback: `customers.normalizedEmail` is OPTIONAL in
 * the schema (added by PR #3424; backfill populates existing rows), so a
 * missed or incomplete backfill could otherwise silently let paid users
 * through the dedup. We derive the join key from `row.email` on the fly
 * when `normalizedEmail` isn't set, matching the convention used at every
 * write site (`email.trim().toLowerCase()`).
 *
 * Same `.collect()` caveat as above. Customers table is small relative to
 * registrations; this is acceptable.
 */
export const getPaidEmails = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("customers").collect();
    return all
      .map((row) => {
        const stored = row.normalizedEmail;
        if (stored && stored.length > 0) return stored;
        return (row.email ?? "").trim().toLowerCase();
      })
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
  linkedExisting: number;
  suppressedSkipped: number;
  paidSkipped: number;
  alreadyExists: number;
  failed: number;
  emptyEmail: number;
  isDone: boolean;
  continueCursor: string;
  pageProcessed: number;
};

/**
 * Heuristic for distinguishing duplicate-shaped 422 responses from other
 * 422-flavored validation errors (missing segment, invalid email,
 * unauthorized field, etc., which we want to count as `failed` and log).
 *
 * Resend's error shape on 422 is `{ name, message, statusCode }`.
 * Duplicate responses use names like `email_already_exists` /
 * `contact_already_exists` and messages mentioning "already". We match
 * generously on the message in case the `name` evolves.
 *
 * Used for BOTH `POST /contacts` duplicates (contact exists globally) AND
 * `POST /contacts/{email}/segments/{segmentId}` duplicates (contact is
 * already in this specific segment) — same shape, same heuristic.
 */
function isDuplicateContactError(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const obj = body as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name.toLowerCase() : "";
  const message = typeof obj.message === "string" ? obj.message.toLowerCase() : "";
  if (name.includes("already_exists") || name.includes("duplicate")) return true;
  if (/already (exists|in (the )?(audience|segment))|duplicate/.test(message)) return true;
  return false;
}

type UpsertOutcome =
  | { kind: "created" }
  | { kind: "linkedExisting" }
  | { kind: "alreadyInSegment" }
  | { kind: "failed"; reason: string };

/**
 * Two-step contact-to-segment upsert that guarantees the contact ends up
 * in `segmentId` regardless of pre-existing global state:
 *
 *   1. `POST /contacts` with `segments: [{ id }]`. If the contact is brand
 *      new globally, this creates it AND attaches to the segment in one
 *      call → "created".
 *   2. If step 1 returns a duplicate-shaped 422, the contact already
 *      exists globally — but Resend's documented behaviour is that the
 *      `segments` field on the duplicate path is NOT applied. We don't
 *      know whether the contact is already in our segment or in some
 *      OTHER segment / no segment at all. Resolve the ambiguity with an
 *      explicit `POST /contacts/{email}/segments/{segmentId}`:
 *        - 2xx → it was global-only or in another segment, now linked
 *          → "linkedExisting"
 *        - 422 duplicate-shaped → was already in this segment
 *          → "alreadyInSegment"
 *        - anything else → "failed"
 *
 * Without step 2, paid-customers-or-anyone-else who happen to already
 * exist as global contacts can be silently OMITTED from the launch
 * segment while the export reports success. (Caught in PR #3431 review.)
 */
async function upsertContactToSegment(
  apiKey: string,
  email: string,
  segmentId: string,
): Promise<UpsertOutcome> {
  const createRes = await fetch(`${RESEND_API_BASE}/contacts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      email,
      segments: [{ id: segmentId }],
      unsubscribed: false,
    }),
  });

  if (createRes.ok) return { kind: "created" };

  if (createRes.status === 422) {
    const createBody = await createRes.json().catch(() => null);
    if (!isDuplicateContactError(createBody)) {
      return {
        kind: "failed",
        reason: `POST /contacts 422 (non-duplicate): ${JSON.stringify(createBody)}`,
      };
    }

    // Contact exists globally — attach to our segment explicitly.
    const addRes = await fetch(
      `${RESEND_API_BASE}/contacts/${encodeURIComponent(email)}/segments/${encodeURIComponent(segmentId)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      },
    );

    if (addRes.ok) return { kind: "linkedExisting" };

    if (addRes.status === 422) {
      const addBody = await addRes.json().catch(() => null);
      if (isDuplicateContactError(addBody)) return { kind: "alreadyInSegment" };
      return {
        kind: "failed",
        reason: `POST /contacts/{email}/segments/{id} 422 (non-duplicate): ${JSON.stringify(addBody)}`,
      };
    }

    const addText = await addRes.text().catch(() => "<no body>");
    return {
      kind: "failed",
      reason: `POST /contacts/{email}/segments/{id} ${addRes.status}: ${addText}`,
    };
  }

  const createText = await createRes.text().catch(() => "<no body>");
  return {
    kind: "failed",
    reason: `POST /contacts ${createRes.status}: ${createText}`,
  };
}

export const exportProLaunchAudience = internalAction({
  args: {
    segmentId: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, { segmentId, cursor, numItems, dryRun }): Promise<ExportStats> => {
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
      linkedExisting: 0,
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

      const outcome = await upsertContactToSegment(apiKey!, email, segmentId);
      switch (outcome.kind) {
        case "created":
          stats.upserted++;
          break;
        case "linkedExisting":
          // Pre-existing global contact, now linked to our segment.
          // Counted as `upserted` (it ended up in the segment via this
          // call) and tracked separately for diagnostics.
          stats.upserted++;
          stats.linkedExisting++;
          break;
        case "alreadyInSegment":
          stats.alreadyExists++;
          break;
        case "failed":
          stats.failed++;
          console.error(
            `[exportProLaunchAudience] Resend failure for ${email}: ${outcome.reason}`,
          );
          break;
      }
    }

    console.log(
      `[exportProLaunchAudience] page complete: ${JSON.stringify(stats)}`,
    );

    return stats;
  },
});
