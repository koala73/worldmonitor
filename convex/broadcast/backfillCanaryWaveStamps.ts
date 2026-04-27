/**
 * One-shot backfill: stamp `proLaunchWave = "canary-250"` on the 244
 * registrations who received the first PRO-launch broadcast on
 * 2026-04-26. Without this stamp, the next wave-export action would
 * re-pick those contacts and re-email them.
 *
 * Reads the canary segment's contact list directly from Resend (the
 * authoritative record of who got that send), maps each email back to
 * `registrations.normalizedEmail`, and patches the wave fields.
 *
 * Run once:
 *   npx convex run broadcast/backfillCanaryWaveStamps:backfillCanary250
 *
 * Idempotent — re-runs are no-ops for already-stamped rows. Safe to
 * re-invoke if it's interrupted (e.g., transient Resend 429).
 */
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
} from "../_generated/server";
import { internal } from "../_generated/api";

const RESEND_API_BASE = "https://api.resend.com";
const USER_AGENT =
  "WorldMonitor-CanaryWaveBackfill/1.0 (+https://worldmonitor.app)";

// Hard-coded — this is a one-off backfill for a specific historical
// send. Future wave-export actions will pass these as parameters.
const CANARY_SEGMENT_ID = "4be8a9fd-8066-4322-ae27-4f9ed74cfab9";
const CANARY_WAVE_LABEL = "canary-250";
// Resend `sent_at` for the canary broadcast 2cc31355-15b1-459b-9142-489441c4d6cb.
const CANARY_SENT_AT_MS = Date.parse("2026-04-26T22:50:49.673Z");

// Resend caps `limit` at 100 per page. Pagination via `after=<contact_id>`.
const RESEND_PAGE_SIZE = 100;

/**
 * Mask an email for log output. Convex dashboard logs are observable to
 * anyone with project access; raw waitlist addresses must not land
 * there. Mirrors the helper in `audienceExport.ts` for consistency.
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
 * Stamp the PRO-launch wave on a single `registrations` row by
 * normalizedEmail. Idempotent: returns `alreadyStamped: true` if the
 * row already carries the same wave label, `notFound` if no
 * registration matches the email (e.g., manually-imported Resend
 * contacts that never came through the waitlist), or `stamped: true`
 * on a successful patch.
 *
 * Internal because callers are server-side actions only — this is not
 * a user-facing mutation.
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
    if (!row) {
      return { result: "notFound" as const };
    }
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

type ResendListContactsResponse = {
  object: "list";
  has_more: boolean;
  data: Array<{
    id: string;
    email: string;
    // Resend may include other fields; we only use id + email.
  }>;
};

type BackfillStats = {
  fetched: number;
  stamped: number;
  alreadyStamped: number;
  notFound: number;
  failed: number;
};

/**
 * Page Resend's `GET /contacts?segment_id=...` with cursor pagination
 * (`after=<contact-id>`) until exhausted, calling
 * `_stampWaveByNormalizedEmail` for each contact's email.
 *
 * Convex action time limit is 10 minutes; at ~244 contacts and one
 * Resend GET per ~100 plus one Convex mutation per contact, this
 * comfortably fits in well under a minute.
 *
 * All Resend addresses are normalized via the same `trim().toLowerCase()`
 * convention used at every write site — must match
 * `registrations.normalizedEmail` semantics or the join would silently
 * miss rows.
 */
export const backfillCanary250 = internalAction({
  args: {},
  handler: async (ctx): Promise<BackfillStats> => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error(
        "[backfillCanary250] RESEND_API_KEY not set — run with the same env that hosts the canary segment.",
      );
    }

    if (!Number.isFinite(CANARY_SENT_AT_MS)) {
      throw new Error(
        "[backfillCanary250] CANARY_SENT_AT_MS failed Date.parse — check the literal.",
      );
    }

    const stats: BackfillStats = {
      fetched: 0,
      stamped: 0,
      alreadyStamped: 0,
      notFound: 0,
      failed: 0,
    };

    let after: string | null = null;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Resend's per-segment contact-listing endpoint is
      // `GET /segments/{id}/contacts` (NOT `/contacts?segment_id=...`).
      // The `/contacts` endpoint exists but its `segment_id` param is
      // documented inconsistently across Resend's docs pages — only
      // the `/segments/{id}/contacts` route is canonical.
      const url = new URL(
        `${RESEND_API_BASE}/segments/${encodeURIComponent(CANARY_SEGMENT_ID)}/contacts`,
      );
      url.searchParams.set("limit", String(RESEND_PAGE_SIZE));
      if (after) url.searchParams.set("after", after);

      const res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "User-Agent": USER_AGENT,
        },
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "<no body>");
        throw new Error(
          `[backfillCanary250] Resend list-contacts ${res.status}: ${body}`,
        );
      }

      const json = (await res.json()) as ResendListContactsResponse;
      if (!json || !Array.isArray(json.data)) {
        throw new Error(
          `[backfillCanary250] unexpected Resend response shape: ${JSON.stringify(json).slice(0, 200)}`,
        );
      }

      for (const contact of json.data) {
        stats.fetched++;
        const normalizedEmail = (contact.email ?? "").trim().toLowerCase();
        if (!normalizedEmail) {
          stats.failed++;
          continue;
        }
        try {
          const out = await ctx.runMutation(
            internal.broadcast.backfillCanaryWaveStamps
              ._stampWaveByNormalizedEmail,
            {
              normalizedEmail,
              waveLabel: CANARY_WAVE_LABEL,
              assignedAt: CANARY_SENT_AT_MS,
            },
          );
          if (out.result === "stamped") stats.stamped++;
          else if (out.result === "alreadyStamped") stats.alreadyStamped++;
          else if (out.result === "notFound") {
            stats.notFound++;
            // Some segment members may have been added directly via the
            // Resend dashboard rather than coming through the waitlist
            // (e.g. test addresses, manual additions). Logging masked
            // so the operator can spot unexpected gaps without raw
            // emails landing in the dashboard log.
            console.log(
              `[backfillCanary250] no registration for ${maskEmail(normalizedEmail)}`,
            );
          }
        } catch (err) {
          // sentry-coverage-ok: per-contact stamp failure is counted
          // into `stats.failed` and surfaced in the action's return
          // value — that's the operator's visible surface for partial
          // failures. Re-throwing would abort the loop and leave most
          // contacts unstamped, defeating the point. Convex auto-Sentry
          // still captures the underlying mutation throw inside the
          // mutation itself, before it bubbles up here as a rejection.
          stats.failed++;
          console.error(
            `[backfillCanary250] stamp failed for ${maskEmail(normalizedEmail)}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      if (!json.has_more || json.data.length === 0) break;

      const last = json.data[json.data.length - 1];
      if (!last?.id) break;
      after = last.id;
    }

    console.log(
      `[backfillCanary250] complete: ${JSON.stringify(stats)}`,
    );

    return stats;
  },
});
