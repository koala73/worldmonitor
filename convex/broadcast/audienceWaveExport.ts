/**
 * Per-wave broadcast audience export — pick N un-emailed registrants,
 * stamp them with a wave label, push them to a fresh Resend segment.
 *
 * The sustainable per-send primitive for the PRO-launch ramp. One CLI
 * invocation per wave, no manual Resend dashboard work, no risk of
 * re-emailing prior waves.
 *
 * Why this exists: Resend's API doesn't support broadcast subset/
 * sample/exclude (verified against docs — `POST /broadcasts` accepts
 * `segment_id` only, segments are membership-based and not query-
 * defined via API). Progressive waves require tracking membership
 * somewhere. Convex is the right source of truth: it's where dedup
 * math runs, and it lets us scan unstamped registrations efficiently
 * via the `by_proLaunchWave` index.
 *
 * Flow:
 *   1. Verify `waveLabel` isn't already in use (would mean a prior
 *      run partially completed — operator should pick a different
 *      label or investigate).
 *   2. Build candidate pool by paginating `registrations` and applying
 *      the same dedup rules as `audienceExport.ts`:
 *        - non-empty `normalizedEmail`
 *        - not in `emailSuppressions`
 *        - not in `customers` (paid)
 *        - `proLaunchWave` is undefined (not in any prior wave)
 *      Random-sample N via reservoir sampling (Algorithm R) — fair
 *      sample without knowing total upfront, single pass, O(N) memory.
 *   3. Create a fresh Resend segment named `pro-launch-${waveLabel}`.
 *      MUST happen before any stamping so we never commit a contact
 *      to "do not pick again" until we know they have a destination.
 *   4. For each picked contact: push to the new segment first, THEN
 *      stamp `proLaunchWave = waveLabel` only on a successful push.
 *      Failed pushes leave the contact unstamped and available for
 *      the next wave's pick — no stranded contacts.
 *   5. Return `{ segmentId, assigned, ... }` so the operator can fire
 *      `createProLaunchBroadcast` against the new segmentId.
 *
 * Atomicity: there is no transactional guarantee across Resend +
 * Convex, so the action orders writes to maximise safety:
 *   - createSegment fails → no rows stamped, no contacts orphaned
 *   - upsertContactToSegment fails for a row → that row not stamped,
 *     stays in the pool for next wave
 *   - upsertContactToSegment succeeds, then stamp throws → contact in
 *     the Resend segment but unstamped. Tracked as `stampFailed` in
 *     the return stats. Risk: re-picked into a later wave → duplicate
 *     email. Stamp failure is rare (Convex mutation-level) and the
 *     operator can manually stamp via the Data Explorer if it
 *     happens. We do NOT roll back the Resend push because a DELETE
 *     here is a worse risk than the duplicate-email exposure.
 *
 * Usage (run from CLI; not callable by clients):
 *
 *   npx convex run broadcast/audienceWaveExport:assignAndExportWave \
 *     '{"waveLabel":"wave-2","count":500}'
 *
 *   # Then the existing send flow:
 *   npx convex run broadcast/sendBroadcast:createProLaunchBroadcast \
 *     '{"segmentId":"<returned>","nameSuffix":"wave-2"}'
 *   npx convex run broadcast/sendBroadcast:sendProLaunchBroadcast \
 *     '{"broadcastId":"<bro_xxx>"}'
 *
 * Idempotency: if a prior run with the same `waveLabel` partially
 * succeeded (stamped rows, partial Resend push), re-running with the
 * same label aborts at step 1 ("waveLabel already in use"). To
 * complete a partially-failed run, fix the underlying issue and use a
 * fresh label — the prior stamps act as a permanent "do not pick
 * again" marker, which is the desired behaviour.
 */
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";
import {
  createSegment,
  upsertContactToSegment,
} from "./_resendContacts";

/**
 * Mask an email for log output — same convention as `audienceExport.ts`
 * and `backfillCanaryWaveStamps.ts`. Convex dashboard logs are
 * observable to anyone with project access; raw waitlist emails must
 * not land there in plaintext.
 */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const visible = local.slice(0, Math.min(2, local.length));
  const masked = "*".repeat(Math.max(1, local.length - visible.length));
  return `${visible}${masked}${domain}`;
}

/**
 * Reservoir sampler (Algorithm R). Maintains a buffer of `size`
 * elements that is, at any point, a uniformly random sample of every
 * element passed to `offer()` so far.
 *
 * Used to pick N random un-emailed registrants without knowing the
 * total pool size upfront — works streaming, single pass, O(N) memory.
 *
 * Math.random() is fine here: this is a deliverability sample, not a
 * security primitive. Bias from Math.random's known LSB issues is
 * negligible at sample sizes <100k.
 */
class Reservoir<T> {
  private readonly size: number;
  private readonly buf: T[] = [];
  private seen = 0;
  constructor(size: number) {
    this.size = size;
  }
  offer(item: T): void {
    this.seen++;
    if (this.buf.length < this.size) {
      this.buf.push(item);
    } else {
      const j = Math.floor(Math.random() * this.seen);
      if (j < this.size) this.buf[j] = item;
    }
  }
  values(): T[] {
    return this.buf;
  }
  totalSeen(): number {
    return this.seen;
  }
}

/**
 * Pre-flight check — abort early if the requested `waveLabel` already
 * has stamped rows. Indexed lookup on `by_proLaunchWave` so it stays
 * fast even with tens of thousands of registrations.
 */
export const _hasWaveLabel = internalQuery({
  args: { waveLabel: v.string() },
  handler: async (ctx, { waveLabel }) => {
    const existing = await ctx.db
      .query("registrations")
      .withIndex("by_proLaunchWave", (q) => q.eq("proLaunchWave", waveLabel))
      .first();
    return existing !== null;
  },
});

/**
 * Snapshot of suppressed normalizedEmails. Mirrors
 * `audienceExport.getSuppressedEmails`. Lives here too so the
 * wave-export action doesn't need to cross-import an internal query
 * from a sibling module — keeps the dependency graph flat.
 */
export const _getSuppressedEmails = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("emailSuppressions").collect();
    return all
      .map((row) => row.normalizedEmail)
      .filter((e): e is string => typeof e === "string" && e.length > 0);
  },
});

/**
 * Snapshot of paid (customer) normalizedEmails. Mirrors
 * `audienceExport.getPaidEmails` including the `email`-fallback
 * defence-in-depth for un-backfilled rows.
 */
export const _getPaidEmails = internalQuery({
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
 * Paginated page of registrations. Mirrors
 * `audienceExport.getRegistrationsPage` shape so the call shape is
 * identical between exporters.
 */
export const _getRegistrationsPage = internalQuery({
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

/**
 * Stamp a single registration with `proLaunchWave = waveLabel` by
 * normalizedEmail. Idempotent on `(normalizedEmail, waveLabel)`.
 *
 * Mirrors `backfillCanaryWaveStamps:_stampWaveByNormalizedEmail` —
 * the two are identical logic, kept separate so each module's
 * `internal.broadcast.X._stampWaveByNormalizedEmail` symbol is
 * stable and renaming one doesn't churn the other.
 */
export const _stampWaveByNormalizedEmail = internalMutation({
  args: {
    normalizedEmail: v.string(),
    waveLabel: v.string(),
    assignedAt: v.number(),
  },
  handler: async (ctx, { normalizedEmail, waveLabel, assignedAt }) => {
    const row = await ctx.db
      .query("registrations")
      .withIndex("by_normalized_email", (q) =>
        q.eq("normalizedEmail", normalizedEmail),
      )
      .first();
    if (!row) return { result: "notFound" as const };
    if (row.proLaunchWave === waveLabel) {
      return { result: "alreadyStamped" as const };
    }
    await ctx.db.patch(row._id, {
      proLaunchWave: waveLabel,
      proLaunchWaveAssignedAt: assignedAt,
    });
    return { result: "stamped" as const };
  },
});

type WaveExportStats = {
  waveLabel: string;
  segmentId: string;
  segmentName: string;
  // How many registrations were eligible (passed all dedup filters)
  // and seen by the reservoir. May be > or = to `assigned`.
  poolSize: number;
  // Newly-stamped + pushed to Resend segment.
  assigned: number;
  // Pre-existing Resend contact attached to our new segment.
  linkedExisting: number;
  // Already in the new segment (impossible on first run, possible only
  // if the same registrant is re-attached during a partial retry).
  alreadyExists: number;
  // Push-side failures (Resend rejected the contact). Not stamped, so
  // available for retry in the next wave.
  failed: number;
  // Push succeeded but the Convex stamp throw — pushed contact is in
  // the Resend segment but `proLaunchWave` wasn't set. Rare (Convex
  // mutation-level). The contact may receive a duplicate email if
  // re-picked into a later wave; operator can manually stamp via the
  // Data Explorer if the count is non-zero.
  stampFailed: number;
  // True if pool < count: requested 500 but only 320 unstamped were
  // available. Operator should treat this as "the waitlist is drained
  // for this ramp tier" and adjust the next wave's size accordingly.
  underfilled: boolean;
};

const REGISTRATIONS_PAGE_SIZE = 1000;

export const assignAndExportWave = internalAction({
  args: {
    waveLabel: v.string(),
    count: v.number(),
  },
  handler: async (
    ctx,
    { waveLabel, count },
  ): Promise<WaveExportStats> => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error(
        "[assignAndExportWave] RESEND_API_KEY not set — run with the same env that hosts the prior segments.",
      );
    }
    if (!Number.isFinite(count) || count <= 0) {
      throw new Error(
        `[assignAndExportWave] count must be a positive integer; got ${count}`,
      );
    }
    if (waveLabel.length === 0 || waveLabel.length > 64) {
      throw new Error(
        "[assignAndExportWave] waveLabel must be 1-64 chars",
      );
    }

    // Step 1: refuse to overlap with an existing wave.
    const exists = await ctx.runQuery(
      internal.broadcast.audienceWaveExport._hasWaveLabel,
      { waveLabel },
    );
    if (exists) {
      throw new Error(
        `[assignAndExportWave] waveLabel "${waveLabel}" already has stamped rows — pick a unique label, or use the Resend dashboard to inspect/clean up the prior wave's segment first.`,
      );
    }

    // Step 2: stream registrations, dedup, reservoir-sample N.
    const [suppressed, paid] = await Promise.all([
      ctx.runQuery(
        internal.broadcast.audienceWaveExport._getSuppressedEmails,
        {},
      ),
      ctx.runQuery(internal.broadcast.audienceWaveExport._getPaidEmails, {}),
    ]);
    const suppressedSet = new Set(suppressed);
    const paidSet = new Set(paid);

    const reservoir = new Reservoir<string>(count);
    let cursor: string | null = null;
    while (true) {
      // Explicit type — `internalAction → runQuery → internalQuery` chain
      // re-introduces the inferred type via the generated `internal` map;
      // TS sometimes can't recurse far enough and falls back to `any`.
      // Annotating here keeps strict mode happy without a project-wide
      // tsconfig change.
      const page: {
        page: Array<{
          normalizedEmail: string;
          proLaunchWave?: string;
        }>;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(
        internal.broadcast.audienceWaveExport._getRegistrationsPage,
        { cursor, numItems: REGISTRATIONS_PAGE_SIZE },
      );
      for (const row of page.page) {
        const email = row.normalizedEmail;
        if (!email || email.length === 0) continue;
        if (suppressedSet.has(email)) continue;
        if (paidSet.has(email)) continue;
        if (row.proLaunchWave) continue;
        reservoir.offer(email);
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }

    const picked = reservoir.values();
    const poolSize = reservoir.totalSeen();

    if (picked.length === 0) {
      throw new Error(
        `[assignAndExportWave] pool empty — all registrations are suppressed/paid/already-stamped. Nothing to send.`,
      );
    }

    // Step 3: create the Resend segment FIRST so we never stamp a
    // contact until we know it has a destination to land in. If
    // segment creation fails, the picked rows are still unstamped and
    // remain available for the next wave's pick — no data loss, no
    // stranded contacts.
    const segmentName = `pro-launch-${waveLabel}`;
    const segmentId = await createSegment(apiKey, segmentName);

    // Step 4: push picked contacts to the segment, then stamp ONLY on
    // successful push outcomes (created / linkedExisting /
    // alreadyInSegment). This ordering is load-bearing — see the
    // file docstring's "Atomicity" section.
    //
    //   - push succeeds  → stamp Convex → contact won't be re-picked
    //   - push fails     → don't stamp → contact stays available for
    //                      retry in the next wave
    //
    // Edge case: stamp throws AFTER successful push. The contact is
    // in the Resend segment but unstamped, so a future wave could
    // re-pick them and they'd land in TWO segments and receive a
    // duplicate email. Stamp failure is rare (Convex mutation-level)
    // and we log + count, but we don't try to roll back the Resend
    // push — that would require a DELETE call we trust less than the
    // duplicate-email risk.
    const stats: WaveExportStats = {
      waveLabel,
      segmentId,
      segmentName,
      poolSize,
      assigned: 0,
      linkedExisting: 0,
      alreadyExists: 0,
      failed: 0,
      stampFailed: 0,
      underfilled: picked.length < count,
    };
    const assignedAt = Date.now();

    for (const email of picked) {
      const outcome = await upsertContactToSegment(apiKey, email, segmentId);
      switch (outcome.kind) {
        case "created":
          stats.assigned++;
          break;
        case "linkedExisting":
          stats.assigned++;
          stats.linkedExisting++;
          break;
        case "alreadyInSegment":
          stats.alreadyExists++;
          break;
        case "failed":
          stats.failed++;
          // Mask the email — Convex dashboard logs are observable to
          // anyone with project access; raw waitlist addresses must
          // not land there.
          console.error(
            `[assignAndExportWave] Resend push failed for ${maskEmail(email)}: ${outcome.reason}`,
          );
          // DO NOT stamp on failure — contact stays unstamped and
          // available for the next wave to re-pick.
          continue;
      }

      // Push succeeded — stamp Convex so this contact won't be
      // re-picked into a future wave. Wrapped in try/catch so a stamp
      // failure on one row doesn't abort the rest of the loop; the
      // duplicate-email risk for the rare un-stamped-but-pushed case
      // is documented above and far preferable to halting the wave.
      try {
        await ctx.runMutation(
          internal.broadcast.audienceWaveExport._stampWaveByNormalizedEmail,
          { normalizedEmail: email, waveLabel, assignedAt },
        );
      } catch (err) {
        // sentry-coverage-ok: stamp failures are counted into
        // `stats.stampFailed` and surfaced in the action's return
        // value — operator's visible surface for the rare
        // pushed-but-not-stamped condition. Convex auto-Sentry
        // captures the underlying mutation throw separately.
        stats.stampFailed++;
        console.error(
          `[assignAndExportWave] stamp failed for ${maskEmail(email)} (already in Resend segment ${segmentName}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    console.log(
      `[assignAndExportWave] complete: ${JSON.stringify(stats)}`,
    );

    return stats;
  },
});
