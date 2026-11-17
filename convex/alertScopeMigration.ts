/**
 * One-time realtime alert scope migration (#10873).
 *
 * A realtime rule with no countries used to receive every critical event in
 * the world. The relay's tier gate narrows such a rule to global critical
 * events only, and delivers local events (weather, airports, sirens,
 * conflict) only to rules that list the event's country. Before that gate
 * takes effect, this migration copies each user's followed countries into
 * their unscoped realtime rules, so they keep local alerts for the places
 * they already said they care about, and queues one notice email per user.
 *
 * Run order (operator, after the relay tier gate is deployed):
 *   1. npx convex run alertScopeMigration:migrateUnscopedRealtimeRules '{"dryRun":true}'
 *      → counts only; repeat with the returned cursor until isDone.
 *   2. The same with dryRun:false.
 *   3. npx convex run alertScopeMigration:sendAlertScopeNotices '{"live":true}'
 *      (or set ALERT_SCOPE_NOTICE_LIVE=1); without it the action is a dry run.
 *
 * Invariants:
 *  - One-time per rule: an alertScopeNotices row marks every rule visited, so
 *    a re-run never re-scopes a rule whose owner has since cleared its
 *    countries on purpose (the failure mode of the free-rule disable script
 *    retired in #10303).
 *  - Clamped to the account's current plan cap: this internal write bypasses
 *    the capability validators, so a lapsed account gets at most the free
 *    ladder's countries, not the paid 50.
 *  - Realtime and enabled only: digest rules and disabled rules are untouched.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "./_generated/server";
import { loadAlertCapabilities } from "./lib/alertCapabilities";
import { isValidIso2 } from "./lib/iso2";
import { ResendSendError, sendResendEmail } from "./lib/resendEmail";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 200;
// More followed countries than any plan's cap; only the oldest maxCountries
// are copied.
const FOLLOWED_READ_LIMIT = 300;
const MAX_EMAIL_ATTEMPTS = 3;
const FROM = "World Monitor <noreply@worldmonitor.app>";
export const ALERT_SETTINGS_URL = "https://www.worldmonitor.app/dashboard?settings=notifications";

type RuleOutcome = "scoped" | "global_only";

function isUnscopedRealtime(rule: Doc<"alertRules">): boolean {
  if (!rule.enabled) return false;
  if ((rule.digestMode ?? "realtime") !== "realtime") return false;
  return !Array.isArray(rule.countries) || rule.countries.length === 0;
}

/** The user's followed countries, oldest first, as canonical ISO-2 codes. */
async function followedCountriesFor(ctx: QueryCtx, userId: string): Promise<string[]> {
  const rows = await ctx.db
    .query("followedCountries")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(FOLLOWED_READ_LIMIT);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of [...rows].sort((a, b) => a.addedAt - b.addedAt)) {
    const code = String(row.country).trim().toUpperCase();
    if (!isValidIso2(code) || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

export const migrateUnscopedRealtimeRules = internalMutation({
  args: {
    dryRun: v.boolean(),
    cursor: v.optional(v.union(v.string(), v.null())),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const numItems = Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(args.batchSize ?? DEFAULT_BATCH_SIZE)));
    const page = await ctx.db
      .query("alertRules")
      .withIndex("by_enabled", (q) => q.eq("enabled", true))
      .paginate({ numItems, cursor: args.cursor ?? null });

    const summary = {
      dryRun: args.dryRun,
      scanned: page.page.length,
      unscopedRealtime: 0,
      alreadyMigrated: 0,
      scoped: 0,
      globalOnly: 0,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
    const now = Date.now();

    for (const rule of page.page) {
      if (!isUnscopedRealtime(rule)) continue;
      summary.unscopedRealtime += 1;
      const marker = await ctx.db
        .query("alertScopeNotices")
        .withIndex("by_rule", (q) => q.eq("ruleId", rule._id))
        .first();
      if (marker) {
        summary.alreadyMigrated += 1;
        continue;
      }
      const caps = await loadAlertCapabilities(ctx, rule.userId);
      const countries = (await followedCountriesFor(ctx, rule.userId)).slice(0, caps.maxCountries);
      const outcome: RuleOutcome = countries.length > 0 ? "scoped" : "global_only";
      if (outcome === "scoped") summary.scoped += 1;
      else summary.globalOnly += 1;
      if (args.dryRun) continue;

      if (outcome === "scoped") await ctx.db.patch(rule._id, { countries, updatedAt: now });
      await ctx.db.insert("alertScopeNotices", {
        userId: rule.userId,
        ruleId: rule._id,
        variant: rule.variant,
        outcome,
        countries,
        createdAt: now,
        emailStatus: "pending",
      });
    }
    // Aggregate counts only: no user ids in the log line.
    console.log(`[alertScopeMigration] ${JSON.stringify(summary)}`);
    return summary;
  },
});

type PendingNotice = {
  _id: Id<"alertScopeNotices">;
  userId: string;
  outcome: RuleOutcome;
  countries: string[];
  emailAttempts?: number;
};

export const listPendingNotices = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, args): Promise<PendingNotice[]> => {
    const rows = await ctx.db
      .query("alertScopeNotices")
      .withIndex("by_emailStatus", (q) => q.eq("emailStatus", "pending"))
      .take(Math.max(1, Math.min(500, Math.floor(args.limit))));
    return rows.map((r) => ({
      _id: r._id,
      userId: r.userId,
      outcome: r.outcome,
      countries: r.countries,
      ...(r.emailAttempts !== undefined ? { emailAttempts: r.emailAttempts } : {}),
    }));
  },
});

export const markNoticeStatus = internalMutation({
  args: {
    noticeIds: v.array(v.id("alertScopeNotices")),
    emailStatus: v.union(
      v.literal("pending"),
      v.literal("sent"),
      v.literal("skipped"),
      v.literal("suppressed"),
      v.literal("failed"),
    ),
    emailedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    for (const id of args.noticeIds) {
      const row = await ctx.db.get(id);
      if (!row) continue;
      if (args.emailStatus === "pending") {
        // A failed attempt: count it and keep the row pending until the cap.
        const attempts = (row.emailAttempts ?? 0) + 1;
        await ctx.db.patch(id, {
          emailAttempts: attempts,
          emailStatus: attempts >= MAX_EMAIL_ATTEMPTS ? "failed" : "pending",
        });
        continue;
      }
      await ctx.db.patch(id, {
        emailStatus: args.emailStatus,
        ...(args.emailedAt !== undefined ? { emailedAt: args.emailedAt } : {}),
      });
    }
  },
});

let regionNames: Intl.DisplayNames | null = null;
function countryName(code: string): string {
  try {
    regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Countries named in the email: the union across the user's migrated rows. */
function noticeCountries(rows: readonly PendingNotice[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) for (const c of row.countries) seen.add(c);
  return [...seen];
}

export function alertScopeNoticeContent(countries: readonly string[]): {
  subject: string;
  text: string;
  html: string;
} {
  const global =
    "Global critical events, such as a market crash, a shipping shock or a national airspace shutdown, still reach you wherever they happen.";
  if (countries.length === 0) {
    const subject = "Add countries to keep getting local alerts";
    const lines = [
      "We've changed how realtime alerts work.",
      "Local events, such as severe weather, airport disruption, sirens and conflict, now reach you only for the countries you choose. You don't follow any countries yet, so for now your realtime alerts send global critical events only.",
      global,
      `Choose your countries: ${ALERT_SETTINGS_URL}`,
    ];
    return { subject, text: lines.join("\n\n"), html: htmlFor(lines.slice(0, 3), "Choose your countries") };
  }
  const names = countries.map(countryName);
  const subject = "Your realtime alerts now follow your countries";
  const lines = [
    "We've changed how realtime alerts work.",
    `Local events, such as severe weather, airport disruption, sirens and conflict, now reach you only for the countries you follow: ${names.join(", ")}.`,
    global,
    `Edit your countries: ${ALERT_SETTINGS_URL}`,
  ];
  return { subject, text: lines.join("\n\n"), html: htmlFor(lines.slice(0, 3), "Edit your countries") };
}

function htmlFor(paragraphs: readonly string[], cta: string): string {
  const body = paragraphs
    .map((p) => `<p style="font-size:15px;line-height:1.6;margin:0 0 16px;">${escapeHtml(p)}</p>`)
    .join("");
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;max-width:560px;">${body}<p style="margin:24px 0 0;"><a href="${ALERT_SETTINGS_URL}" style="color:#15803d;font-weight:600;">${escapeHtml(cta)}</a></p></div>`;
}

type Recipient = { email: string | null; suppressed: boolean };

export const sendAlertScopeNotices = internalAction({
  args: {
    // Delivery kill-switch: without live:true or ALERT_SCOPE_NOTICE_LIVE=1 the
    // action reports what it would send and touches nothing.
    live: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const live = args.live ?? process.env.ALERT_SCOPE_NOTICE_LIVE === "1";
    const pending = (await ctx.runQuery(internal.alertScopeMigration.listPendingNotices, {
      limit: args.limit ?? 200,
    })) as PendingNotice[];
    const byUser = new Map<string, PendingNotice[]>();
    for (const row of pending) {
      const rows = byUser.get(row.userId) ?? [];
      rows.push(row);
      byUser.set(row.userId, rows);
    }
    const summary = { live, users: byUser.size, sent: 0, skipped: 0, failed: 0 };
    if (!live) {
      console.log(`[alertScopeMigration] notice dry-run: ${byUser.size} user(s) pending, none sent`);
      return summary;
    }
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error("[alertScopeMigration] RESEND_API_KEY not configured; no notice sent");

    const now = Date.now();
    const failures: string[] = [];
    for (const [userId, rows] of byUser) {
      const noticeIds = rows.map((r) => r._id);
      const recipient = (await ctx.runQuery(internal.apiPlanLimitEmails.getNoticeRecipient, {
        userId,
      })) as Recipient;
      if (!recipient.email || recipient.suppressed) {
        await ctx.runMutation(internal.alertScopeMigration.markNoticeStatus, {
          noticeIds,
          emailStatus: recipient.email ? "suppressed" : "skipped",
          emailedAt: now,
        });
        summary.skipped += 1;
        continue;
      }
      const content = alertScopeNoticeContent(noticeCountries(rows));
      try {
        const result = await sendResendEmail(ctx, {
          apiKey,
          from: FROM,
          to: recipient.email,
          subject: content.subject,
          html: content.html,
          text: content.text,
          purpose: "transactional",
          idempotencyKey: `alert-scope-notice:${userId}`,
        });
        await ctx.runMutation(internal.alertScopeMigration.markNoticeStatus, {
          noticeIds,
          emailStatus: result.sent ? "sent" : "suppressed",
          emailedAt: now,
        });
        if (result.sent) summary.sent += 1;
        else summary.skipped += 1;
      } catch (err) {
        await ctx.runMutation(internal.alertScopeMigration.markNoticeStatus, {
          noticeIds,
          emailStatus: "pending",
        });
        summary.failed += 1;
        failures.push(err instanceof ResendSendError ? `Resend ${err.status}` : "send error");
      }
    }
    console.log(`[alertScopeMigration] notices ${JSON.stringify(summary)}`);
    // Every row is marked before this throw, so a re-run retries only the
    // failed users; throwing hands the failure to Convex's Sentry capture.
    if (failures.length > 0) {
      throw new Error(`[alertScopeMigration] ${failures.length} notice send failure(s): ${failures.slice(0, 3).join(" | ")}`);
    }
    return summary;
  },
});
