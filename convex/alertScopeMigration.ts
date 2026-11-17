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
 *    ladder's countries, not the paid 50, counted across all its enabled
 *    rules as the free ladder counts them.
 *  - Realtime and enabled only: digest rules and disabled rules are untouched.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { seedCountriesForRule } from "./lib/alertScopeSeed";
import { ResendSendError, sendResendEmail } from "./lib/resendEmail";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 200;
const MAX_EMAIL_ATTEMPTS = 3;
const FROM = "World Monitor <noreply@worldmonitor.app>";
export const ALERT_SETTINGS_URL = "https://www.worldmonitor.app/dashboard?settings=notifications";

type RuleOutcome = "scoped" | "global_only";

function isUnscopedRealtime(rule: Doc<"alertRules">): boolean {
  if (!rule.enabled) return false;
  if ((rule.digestMode ?? "realtime") !== "realtime") return false;
  return !Array.isArray(rule.countries) || rule.countries.length === 0;
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
      // Within the plan cap; a free account's cap spans all its enabled rules.
      const countries = await seedCountriesForRule(ctx, rule.userId, rule.variant);
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
    const head = await ctx.db
      .query("alertScopeNotices")
      .withIndex("by_emailStatus", (q) => q.eq("emailStatus", "pending"))
      .take(Math.max(1, Math.min(500, Math.floor(args.limit))));
    // Every pending row of each selected user, so one email covers all their
    // variants: a user split across runs would get a second email once
    // Resend's 24h idempotency window has passed.
    const rows: Doc<"alertScopeNotices">[] = [];
    for (const userId of new Set(head.map((r) => r.userId))) {
      const userRows = await ctx.db
        .query("alertScopeNotices")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();
      rows.push(...userRows.filter((r) => r.emailStatus === "pending"));
    }
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
      // Only a pending row moves: a concurrent run's late failure must not
      // reset a notice another run already sent.
      if (!row || row.emailStatus !== "pending") continue;
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
  const intro = "We've changed how realtime alerts work.";
  const global =
    "Global critical events, such as a market crash, a shipping shock or a national airspace shutdown, still reach you wherever they happen.";
  if (countries.length === 0) {
    const subject = "Add countries to keep getting local alerts";
    const local =
      "Local events, such as severe weather, airport disruption, sirens and conflict, now reach you only for the countries you choose. You don't follow any countries yet, so for now your realtime alerts send global critical events, plus any opt-in alerts you turned on.";
    const cta = "Choose your countries";
    return {
      subject,
      text: [intro, local, global, `${cta}: ${ALERT_SETTINGS_URL}`].join("\n\n"),
      html: noticeHtml({ heading: subject, intro, local, countries: [], global, cta }),
    };
  }
  const names = countries.map(countryName);
  const subject = "Your realtime alerts now follow your countries";
  const local = `Local events, such as severe weather, airport disruption, sirens and conflict, now reach you only for the countries you follow: ${names.join(", ")}.`;
  const cta = "Edit your countries";
  return {
    subject,
    text: [intro, local, global, `${cta}: ${ALERT_SETTINGS_URL}`].join("\n\n"),
    html: noticeHtml({
      heading: subject,
      intro,
      local: "Local events, such as severe weather, airport disruption, sirens and conflict, now reach you only for the countries you follow:",
      countries: names,
      global,
      cta,
    }),
  };
}

// The frame the relay's alert emails use (scripts/lib/notification-email-html.cjs):
// accent bar, logo header with a kicker, cards, accent button, footer. Inline
// styles only, no <style> block or flex, so it renders the same across clients.
const NOTICE_LOGO_URL = "https://www.worldmonitor.app/favico/android-chrome-192x192.png";
const NOTICE_ACCENT = "#4ade80";
const NOTICE_FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function noticeCard(label: string, color: string, inner: string): string {
  return `<div style="background: #111; border: 1px solid #1a1a1a; border-left: 3px solid ${color}; padding: 16px 20px; margin-bottom: 12px;">
        <div style="font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 1.5px; font-weight: 700; margin-bottom: 8px;">${escapeHtml(label)}</div>
        ${inner}
      </div>`;
}

function noticeHtml(args: {
  heading: string;
  intro: string;
  local: string;
  countries: readonly string[];
  global: string;
  cta: string;
}): string {
  const chips = args.countries
    .map((name) => `<span style="display: inline-block; margin: 8px 6px 0 0; padding: 4px 10px; border: 1px solid #2a2a2a; background: #161616; color: #e0e0e0; font-size: 12px; border-radius: 3px;">${escapeHtml(name)}</span>`)
    .join("");
  const paragraph = (text: string) =>
    `<div style="font-size: 14px; color: #ccc; line-height: 1.6;">${escapeHtml(text)}</div>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>WorldMonitor</title>
</head>
<body style="margin: 0; padding: 0; background: #111;">
<div style="display: none; max-height: 0; overflow: hidden; opacity: 0; color: #111;">${escapeHtml(args.heading)}</div>
<div style="font-family: ${NOTICE_FONT_STACK}; background: #111; color: #e0e0e0; padding: 0;">
  <div style="max-width: 680px; margin: 0 auto;">
    <div style="background: ${NOTICE_ACCENT}; height: 3px;"></div>
    <div style="background: #0d0d0d; padding: 32px 36px 8px;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="margin-bottom: 28px;">
        <tr>
          <td style="vertical-align: middle;">
            <table cellpadding="0" cellspacing="0" border="0" role="presentation">
              <tr>
                <td style="width: 36px; height: 36px; vertical-align: middle;">
                  <img src="${NOTICE_LOGO_URL}" width="36" height="36" alt="WorldMonitor" style="border-radius: 50%; display: block;" />
                </td>
                <td style="padding-left: 10px;">
                  <div style="font-size: 15px; font-weight: 800; color: #fff; letter-spacing: -0.3px;">WORLD MONITOR</div>
                </td>
              </tr>
            </table>
          </td>
          <td style="text-align: right; vertical-align: middle;">
            <span style="font-size: 11px; color: #555; text-transform: uppercase; letter-spacing: 1px;">Alert settings</span>
          </td>
        </tr>
      </table>
      <div style="font-size: 20px; font-weight: 700; color: #fff; margin-bottom: 8px; line-height: 1.35;">${escapeHtml(args.heading)}</div>
      <div style="font-size: 14px; color: #888; line-height: 1.5; margin-bottom: 20px;">${escapeHtml(args.intro)}</div>
      ${noticeCard("Local events", NOTICE_ACCENT, `${paragraph(args.local)}${chips ? `<div>${chips}</div>` : ""}`)}
      ${noticeCard("Everywhere", "#ef4444", paragraph(args.global))}
      <div style="padding: 16px 0 28px;"><a href="${ALERT_SETTINGS_URL}" style="display: inline-block; background: ${NOTICE_ACCENT}; color: #0a0a0a; padding: 12px 28px; text-decoration: none; font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: 1.5px; border-radius: 3px;">${escapeHtml(args.cta)}</a></div>
    </div>
    <div style="background: #0a0a0a; border-top: 1px solid #1a1a1a; padding: 20px 36px; text-align: center;">
      <div style="margin-bottom: 12px;">
        <a href="https://x.com/worldmonitorai" style="color: #555; text-decoration: none; font-size: 11px; margin: 0 10px;">X / Twitter</a>
        <a href="https://github.com/koala73/worldmonitor" style="color: #555; text-decoration: none; font-size: 11px; margin: 0 10px;">GitHub</a>
      </div>
      <p style="font-size: 10px; color: #444; margin: 0; line-height: 1.5;">
        <a href="https://worldmonitor.app" style="color: ${NOTICE_ACCENT}; text-decoration: none;">worldmonitor.app</a>
      </p>
      <p style="font-size: 10px; color: #444; margin: 8px 0 0; line-height: 1.5;">You're receiving this because realtime alerts are on for your account.</p>
    </div>
  </div>
</div>
</body>
</html>`;
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
