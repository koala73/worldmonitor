import { ConvexError, v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { ResendSendError, sendResendEmail } from "./lib/resendEmail";
import { assertAccountWritable } from "./accountDeletion/guard";
import {
  agentFeedbackKindValidator,
  agentFeedbackStatusValidator,
} from "./lib/agentFeedbackValidators";

// Storage for the agent feedback channel (#8721). The edge validates,
// sanitizes, redacts, and hashes every report before it reaches this module;
// the bounds here are a second line, as in contactMessages.ts. Report text is
// attacker-controlled: it is stored as data and never reaches a log line, an
// error payload, or an email (docs/architecture/agent-feedback-threat-model.md,
// Decision 7).

const ADMIN_EMAIL = "elie@worldmonitor.app";

// Field bounds in code points (threat model, "The accepted input").
export const FEEDBACK_MAX_SUMMARY = 300;
export const FEEDBACK_MAX_DETAIL = 2000;
export const FEEDBACK_MAX_SURFACE_NAME = 120;
export const FEEDBACK_MAX_CLIENT_NAME = 80;
export const FEEDBACK_MAX_REQUEST_ID = 128;
const MAX_PRINCIPAL_ID = 128;
const MAX_DISMISS_REASON = 200;

const HASH_RE = /^[0-9a-f]{64}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9:_-]+$/;
const REPORTER_KEY_RE = /^(principal:.{1,128}|ip:[0-9a-f]{64})$/;

// Decision 3: an identical stored report inside this window returns the
// original row instead of inserting another.
export const FEEDBACK_RETRY_WINDOW_MS = 10 * 60 * 1000;

// Second line behind the edge admission buckets (5/h anonymous per IP, 30/day
// keyed). Neither door can reach this cap while Redis is healthy; it bounds
// storage if the edge limiter is ever bypassed or misconfigured.
export const FEEDBACK_REPORTER_HOURLY_CAP = 30;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Decision 12: notification emails per UTC day. Past the cap, rows wait for
// the daily digest.
export const FEEDBACK_SECURITY_EMAILS_PER_DAY = 20;
// A scheduled send older than this without `notifiedAt` is treated as failed
// and picked up by the digest.
export const FEEDBACK_NOTIFY_GRACE_MS = HOUR_MS;
// At the edge's 30 security reports a day this covers a month of failed
// sends in one digest. A larger backlog is reported and drains the next day.
const DIGEST_BATCH = 1000;

// Decision 10: retention from `receivedAt` for every status.
export const FEEDBACK_RETENTION_MS: Record<Doc<"agentFeedback">["status"], number> = {
  received: 30 * DAY_MS,
  triaged: 30 * DAY_MS,
  duplicate: 30 * DAY_MS,
  dismissed: 30 * DAY_MS,
  filed: 365 * DAY_MS,
  private: 180 * DAY_MS,
  closed: 180 * DAY_MS,
};
const PRUNE_BATCH = 200;

function clip(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const points = Array.from(trimmed);
  return points.length > max ? points.slice(0, max).join("") : trimmed;
}

function invalid(field: string): never {
  // Names the field, never its value (Decision 7).
  throw new ConvexError({ kind: "INVALID_FEEDBACK", field });
}

const SECURITY_EMAIL_COUNTER_PREFIX = "agentFeedback:securityEmails:";
const FILED_TOMBSTONE = "filed";

export function securityEmailCounterName(now: number): string {
  return `${SECURITY_EMAIL_COUNTER_PREFIX}${new Date(now).toISOString().slice(0, 10)}`;
}

/**
 * Takes one notification slot for today if any remain. Runs inside the insert
 * mutation, so a retry cannot double-send and two concurrent reports cannot
 * both take the last slot (Decision 11).
 */
async function takeSecurityEmailSlot(ctx: MutationCtx, now: number): Promise<boolean> {
  const name = securityEmailCounterName(now);
  const counter = await ctx.db
    .query("counters")
    .withIndex("by_name", (q) => q.eq("name", name))
    .first();
  const used = counter?.value ?? 0;
  if (used >= FEEDBACK_SECURITY_EMAILS_PER_DAY) return false;
  if (counter) await ctx.db.patch(counter._id, { value: used + 1 });
  else await ctx.db.insert("counters", { name, value: 1 });
  return true;
}

const submitArgs = {
  kind: agentFeedbackKindValidator,
  surfaceType: v.union(v.literal("mcp_tool"), v.literal("rpc"), v.literal("other")),
  surfaceName: v.string(),
  summary: v.string(),
  expected: v.optional(v.string()),
  actual: v.optional(v.string()),
  requestId: v.optional(v.string()),
  clientName: v.optional(v.string()),
  redacted: v.boolean(),
  fingerprint: v.string(),
  retryKey: v.string(),
  reporterKey: v.string(),
  authKind: v.union(v.literal("anonymous"), v.literal("keyed")),
  principalId: v.optional(v.string()),
  ipHash: v.optional(v.string()),
  uaHash: v.optional(v.string()),
};

export type SubmitFeedbackResult = {
  reportId: Id<"agentFeedback">;
  status: Doc<"agentFeedback">["status"];
  retried: boolean;
};

async function findRecentRetry(
  ctx: { db: QueryCtx["db"] },
  retryKey: string,
  now: number,
): Promise<Doc<"agentFeedback"> | null> {
  return ctx.db
    .query("agentFeedback")
    .withIndex("by_retryKey_received", (q) =>
      q.eq("retryKey", retryKey).gte("receivedAt", now - FEEDBACK_RETRY_WINDOW_MS),
    )
    .first();
}

/**
 * Lets the edge answer a retry before it charges the caller's admission
 * budget (Decision 3: a retry costs no budget). `submit` repeats the check, so
 * a race between two identical requests still inserts one row.
 */
export const findRetry = internalQuery({
  args: { retryKey: v.string() },
  handler: async (ctx, { retryKey }) => {
    if (!HASH_RE.test(retryKey)) invalid("retryKey");
    const row = await findRecentRetry(ctx, retryKey, Date.now());
    return row ? { reportId: row._id, status: row.status } : null;
  },
});

export const submit = internalMutation({
  args: submitArgs,
  handler: async (ctx, args): Promise<SubmitFeedbackResult> => {
    const now = Date.now();

    if (!HASH_RE.test(args.fingerprint)) invalid("fingerprint");
    if (!HASH_RE.test(args.retryKey)) invalid("retryKey");
    if (!REPORTER_KEY_RE.test(args.reporterKey)) invalid("reporterKey");
    if (args.ipHash !== undefined && !HASH_RE.test(args.ipHash)) invalid("ipHash");
    if (args.uaHash !== undefined && !HASH_RE.test(args.uaHash)) invalid("uaHash");
    if (args.authKind === "keyed" && !args.principalId) invalid("principalId");
    if (args.authKind === "anonymous" && args.principalId !== undefined) invalid("principalId");
    // The reporter key must name the same identity as the reporter fields, or
    // the hourly cap splits and account deletion orphans the row.
    const expectedReporterKey = args.authKind === "keyed"
      ? `principal:${args.principalId}`
      : `ip:${args.ipHash ?? ""}`;
    if (args.reporterKey !== expectedReporterKey) invalid("reporterKey");

    const summary = clip(args.summary, FEEDBACK_MAX_SUMMARY);
    if (!summary) invalid("summary");
    const surfaceName = clip(args.surfaceName, FEEDBACK_MAX_SURFACE_NAME);
    if (!surfaceName) invalid("surfaceName");
    const requestId = clip(args.requestId, FEEDBACK_MAX_REQUEST_ID);
    if (requestId !== undefined && !REQUEST_ID_RE.test(requestId)) invalid("requestId");
    const principalId = clip(args.principalId, MAX_PRINCIPAL_ID);
    // The deletion cascade visits this table once and completed deletions keep
    // the fence, so a keyed write reads it in this transaction. Otherwise a
    // report admitted before deletion could land after the cascade passed.
    if (principalId !== undefined) await assertAccountWritable(ctx, principalId);

    const retry = await findRecentRetry(ctx, args.retryKey, now);
    if (retry) return { reportId: retry._id, status: retry.status, retried: true };

    const recent = await ctx.db
      .query("agentFeedback")
      .withIndex("by_reporter_received", (q) =>
        q.eq("reporterKey", args.reporterKey).gte("receivedAt", now - HOUR_MS),
      )
      .take(FEEDBACK_REPORTER_HOURLY_CAP);
    if (recent.length >= FEEDBACK_REPORTER_HOURLY_CAP) {
      throw new ConvexError({ kind: "rate_limited" });
    }

    const isSecurity = args.kind === "security";
    const status = isSecurity ? "private" : "received";
    const notify = isSecurity && (await takeSecurityEmailSlot(ctx, now));

    const reportId = await ctx.db.insert("agentFeedback", {
      kind: args.kind,
      surfaceType: args.surfaceType,
      surfaceName,
      summary,
      expected: clip(args.expected, FEEDBACK_MAX_DETAIL),
      actual: clip(args.actual, FEEDBACK_MAX_DETAIL),
      requestId,
      clientName: clip(args.clientName, FEEDBACK_MAX_CLIENT_NAME),
      redacted: args.redacted,
      fingerprint: args.fingerprint,
      retryKey: args.retryKey,
      reporterKey: args.reporterKey,
      authKind: args.authKind,
      principalId,
      ipHash: args.ipHash,
      uaHash: args.uaHash,
      status,
      receivedAt: now,
      updatedAt: now,
      notifyScheduledAt: notify ? now : undefined,
    });

    if (notify) {
      await ctx.scheduler.runAfter(0, internal.agentFeedback.notifySecurityReport, {
        reportId,
      });
    }
    return { reportId, status, retried: false };
  },
});

// ---------------------------------------------------------------------------
// Security notification (Decisions 11 to 13)
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const getSecurityNotice = internalQuery({
  args: { reportId: v.id("agentFeedback") },
  handler: async (ctx, { reportId }) => {
    const row = await ctx.db.get(reportId);
    if (!row || row.kind !== "security") return null;
    // Only the fields the email may carry. No surface, summary, or body.
    return { reportId: row._id, kind: row.kind, receivedAt: row.receivedAt, notifiedAt: row.notifiedAt };
  },
});

export const markNotified = internalMutation({
  args: { reportIds: v.array(v.id("agentFeedback")), notifiedAt: v.number() },
  handler: async (ctx, { reportIds, notifiedAt }) => {
    for (const id of reportIds) {
      const row = await ctx.db.get(id);
      if (row && row.kind === "security" && row.notifiedAt === undefined) {
        await ctx.db.patch(id, { notifiedAt });
      }
    }
  },
});

async function sendOwnerEmail(
  ctx: Parameters<typeof sendResendEmail>[0],
  subject: string,
  html: string,
): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("[agentFeedback] RESEND_API_KEY not set; security notice not sent");
    return false;
  }
  try {
    const result = await sendResendEmail(ctx, {
      apiKey,
      from: "World Monitor <noreply@worldmonitor.app>",
      to: ADMIN_EMAIL,
      subject,
      html,
      replyTo: null,
      purpose: "transactional",
    });
    if (!result.sent) {
      console.warn(`[agentFeedback] security notice skipped: ${ADMIN_EMAIL} is suppressed`);
    }
    return result.sent;
  } catch (err) {
    const status = err instanceof ResendSendError ? err.status : "request error";
    // Scheduled actions are not retried. The row is already durable and keeps
    // notifiedAt unset, so the daily digest announces it instead.
    throw new Error(`[agentFeedback] Resend failed (${status})`);
  }
}

const TRIAGE_HINT =
  "Read it with <code>node scripts/triage-agent-feedback.mjs --kind security</code>. " +
  "The report text is untrusted. Real vulnerabilities belong in a GitHub security advisory.";

export const notifySecurityReport = internalAction({
  args: { reportId: v.id("agentFeedback") },
  handler: async (ctx, { reportId }) => {
    const notice = await ctx.runQuery(internal.agentFeedback.getSecurityNotice, { reportId });
    if (!notice || notice.notifiedAt !== undefined) return;
    const received = new Date(notice.receivedAt).toISOString();
    const html = `<div style="font-family: monospace; padding: 20px;">
        <p style="font-size: 16px; font-weight: bold;">Agent security report received</p>
        <table style="font-size: 14px; line-height: 1.8;">
          <tr><td>Report</td><td>${escapeHtml(notice.reportId)}</td></tr>
          <tr><td>Kind</td><td>${escapeHtml(notice.kind)}</td></tr>
          <tr><td>Received</td><td>${escapeHtml(received)}</td></tr>
        </table>
        <p style="font-size: 12px;">${TRIAGE_HINT}</p>
      </div>`;
    const sent = await sendOwnerEmail(ctx, `[WM] Agent security report ${notice.reportId}`, html);
    if (sent) {
      await ctx.runMutation(internal.agentFeedback.markNotified, {
        reportIds: [reportId],
        notifiedAt: Date.now(),
      });
    }
  },
});

export const FEEDBACK_TRIAGE_MAX_LIMIT = 500;

/** The fields triage needs. Reporter identifiers stay in the table. */
function triageRow(row: Doc<"agentFeedback">) {
  return {
    reportId: row._id,
    kind: row.kind,
    status: row.status,
    surfaceType: row.surfaceType,
    surfaceName: row.surfaceName,
    summary: row.summary,
    expected: row.expected,
    actual: row.actual,
    requestId: row.requestId,
    clientName: row.clientName,
    redacted: row.redacted,
    fingerprint: row.fingerprint,
    authKind: row.authKind,
    receivedAt: row.receivedAt,
  };
}

/**
 * One page of an open queue for the operator triage script (phase 8), newest
 * first. Only open statuses are listed; a terminal row has nothing left to
 * decide. `cursor` continues from the previous page's `continueCursor`, so a
 * flood of newer reports cannot push older ones out of reach before they
 * expire. Reporter identifiers (principal, IP and UA hashes, reporter and
 * retry keys) stay in the table: triage needs the report, not who sent it.
 * Every returned text field is attacker-controlled; the script escapes it.
 */
export const listForTriage = internalQuery({
  args: {
    status: v.union(v.literal("received"), v.literal("triaged"), v.literal("private")),
    limit: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { status, limit = 200, cursor = null }) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > FEEDBACK_TRIAGE_MAX_LIMIT) invalid("limit");
    const page = await ctx.db
      .query("agentFeedback")
      .withIndex("by_status_received", (q) => q.eq("status", status))
      .order("desc")
      .paginate({ numItems: limit, cursor });
    return {
      more: !page.isDone,
      continueCursor: page.isDone ? null : page.continueCursor,
      rows: page.page.map(triageRow),
    };
  },
});

/**
 * One open, public report by id, for drafting a GitHub issue. A security
 * report (`private`) or a closed row returns null: a security report's
 * details never go into a public issue.
 */
export const getForTriage = internalQuery({
  args: { reportId: v.id("agentFeedback") },
  handler: async (ctx, { reportId }) => {
    const row = await ctx.db.get(reportId);
    if (!row || row.kind === "security" || (row.status !== "received" && row.status !== "triaged")) return null;
    return triageRow(row);
  },
});

/**
 * Security rows nobody has been told about: held back by the daily cap, or
 * scheduled more than FEEDBACK_NOTIFY_GRACE_MS ago and never delivered.
 */
export const listUnannouncedSecurity = internalQuery({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const pending: Array<{ reportId: Id<"agentFeedback">; receivedAt: number }> = [];
    let more = false;
    // Streams the index instead of taking a fixed prefix, so rows that are
    // not eligible (inside the grace window) never hide later ones.
    for await (const row of ctx.db
      .query("agentFeedback")
      .withIndex("by_kind_notified_received", (q) =>
        q.eq("kind", "security").eq("notifiedAt", undefined),
      )) {
      // Closing sets notifiedAt; this also skips rows closed before it did.
      if (row.status !== "private") continue;
      if (row.notifyScheduledAt !== undefined && row.notifyScheduledAt >= now - FEEDBACK_NOTIFY_GRACE_MS) continue;
      if (pending.length === DIGEST_BATCH) {
        more = true;
        break;
      }
      pending.push({ reportId: row._id, receivedAt: row.receivedAt });
    }
    return { pending, more };
  },
});

export const sendSecurityDigest = internalAction({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ listed: number }> => {
    const { pending, more }: {
      pending: Array<{ reportId: Id<"agentFeedback">; receivedAt: number }>;
      more: boolean;
    } = await ctx.runQuery(internal.agentFeedback.listUnannouncedSecurity, { now: args.now });
    if (pending.length === 0) return { listed: 0 };
    const rows = pending
      .map((p) => `<tr><td>${escapeHtml(p.reportId)}</td><td>${escapeHtml(new Date(p.receivedAt).toISOString())}</td></tr>`)
      .join("");
    const html = `<div style="font-family: monospace; padding: 20px;">
        <p style="font-size: 16px; font-weight: bold;">${pending.length} agent security report(s) not yet announced</p>
        <p style="font-size: 12px;">Held back by the daily email cap, or the first notice failed.</p>
        <table style="font-size: 14px; line-height: 1.8;">${rows}</table>
        ${more ? `<p style="font-size: 12px;">More reports are waiting. They will be listed in tomorrow's digest.</p>` : ""}
        <p style="font-size: 12px;">${TRIAGE_HINT}</p>
      </div>`;
    const sent = await sendOwnerEmail(
      ctx,
      `[WM] Agent security digest: ${pending.length} unannounced report(s)`,
      html,
    );
    if (!sent) return { listed: 0 };
    await ctx.runMutation(internal.agentFeedback.markNotified, {
      reportIds: pending.map((p) => p.reportId),
      notifiedAt: Date.now(),
    });
    return { listed: pending.length };
  },
});

// ---------------------------------------------------------------------------
// Status changes (operator only, via the phase 8 triage script)
// ---------------------------------------------------------------------------

const ALLOWED_TRANSITIONS: Record<Doc<"agentFeedback">["status"], ReadonlyArray<Doc<"agentFeedback">["status"]>> = {
  received: ["triaged", "filed", "duplicate", "dismissed"],
  triaged: ["filed", "duplicate", "dismissed"],
  filed: [],
  duplicate: [],
  dismissed: [],
  private: ["closed"],
  closed: [],
};

export const transition = internalMutation({
  args: {
    reportId: v.id("agentFeedback"),
    to: agentFeedbackStatusValidator,
    issueNumber: v.optional(v.number()),
    duplicateOf: v.optional(v.id("agentFeedback")),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.reportId);
    if (!row) throw new ConvexError({ kind: "NOT_FOUND" });
    if (!ALLOWED_TRANSITIONS[row.status].includes(args.to)) {
      throw new ConvexError({ kind: "INVALID_TRANSITION", from: row.status, to: args.to });
    }
    const now = Date.now();
    if (args.to === "filed") {
      if (!args.issueNumber || !Number.isInteger(args.issueNumber) || args.issueNumber < 1) {
        invalid("issueNumber");
      }
      // Decision 10: a filed row keeps id, kind, surface, fingerprint, and the
      // issue number for a year. The text now lives in the GitHub issue, and
      // every reporter identifier goes with it, so the row holds nothing that
      // account deletion would need to find.
      await ctx.db.patch(row._id, {
        status: "filed",
        issueNumber: args.issueNumber,
        summary: undefined,
        expected: undefined,
        actual: undefined,
        clientName: undefined,
        requestId: undefined,
        principalId: undefined,
        ipHash: undefined,
        uaHash: undefined,
        reporterKey: FILED_TOMBSTONE,
        retryKey: FILED_TOMBSTONE,
        updatedAt: now,
      });
      return { status: "filed" as const };
    }
    if (args.to === "duplicate") {
      if (!args.duplicateOf || args.duplicateOf === row._id) invalid("duplicateOf");
      if (!(await ctx.db.get(args.duplicateOf))) invalid("duplicateOf");
      await ctx.db.patch(row._id, { status: "duplicate", duplicateOf: args.duplicateOf, updatedAt: now });
      return { status: "duplicate" as const };
    }
    if (args.to === "dismissed") {
      await ctx.db.patch(row._id, {
        status: "dismissed",
        dismissReason: clip(args.reason, MAX_DISMISS_REASON),
        updatedAt: now,
      });
      return { status: "dismissed" as const };
    }
    // Closing a private row means the owner has seen it: stamp notifiedAt so
    // closed rows leave the digest index instead of accumulating there.
    await ctx.db.patch(row._id, {
      status: args.to,
      updatedAt: now,
      ...(args.to === "closed" && row.notifiedAt === undefined ? { notifiedAt: now } : {}),
    });
    return { status: args.to };
  },
});

// ---------------------------------------------------------------------------
// Retention (Decision 10)
// ---------------------------------------------------------------------------

export const prune = internalMutation({
  args: { now: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const batch = Math.max(1, Math.floor(args.limit ?? PRUNE_BATCH));
    let deleted = 0;
    let full = false;
    for (const [status, retention] of Object.entries(FEEDBACK_RETENTION_MS) as Array<
      [Doc<"agentFeedback">["status"], number]
    >) {
      const stale = await ctx.db
        .query("agentFeedback")
        .withIndex("by_status_received", (q) =>
          q.eq("status", status).lt("receivedAt", now - retention),
        )
        .take(batch);
      for (const row of stale) await ctx.db.delete(row._id);
      deleted += stale.length;
      if (stale.length >= batch) full = true;
    }
    // Daily email counters are only read on their own UTC day.
    const staleCounters = await ctx.db
      .query("counters")
      .withIndex("by_name", (q) =>
        q.gte("name", SECURITY_EMAIL_COUNTER_PREFIX)
          .lt("name", securityEmailCounterName(now - 2 * DAY_MS)),
      )
      .take(batch);
    for (const counter of staleCounters) await ctx.db.delete(counter._id);
    if (staleCounters.length >= batch) full = true;

    // Keep the same `now` across the chain so the cutoff stays fixed.
    if (full) {
      await ctx.scheduler.runAfter(0, internal.agentFeedback.prune, { now, limit: batch });
    }
    return { deleted, rescheduled: full };
  },
});
