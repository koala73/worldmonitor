/**
 * Black Friday 2026 send: audience selection and the operator commands.
 *
 * Runbook: convex/broadcast/BLACK_FRIDAY_RUNBOOK.md (exact commands, in order).
 *
 * This module adds the campaign's audience rules on top of the existing wave
 * pipeline (waveRuns.ts): the same lease, picked-contact rows, Resend segment
 * push, failure-rate guard, broadcast create and send, and the same recovery
 * commands. What is specific to the campaign:
 *
 *   - Its own `broadcastRampConfig` row, keyed by the campaign id, so nothing
 *     here advances or deactivates the PRO-launch ramp (key "current").
 *   - One wave per segment: version x locale x recipient type.
 *   - Its own stamp fields on `users` and `registrations` (blackFriday*Wave),
 *     one pair per send, so nobody gets the same send twice.
 *   - A kill gate over ALL the campaign's broadcasts: one segment can be a
 *     handful of contacts, far too few for a per-broadcast rate.
 *
 * SAFE DEFAULTS. `startBlackFridayWave` and `releaseBlackFridayBroadcast` are
 * dry runs unless called with `"dryRun": false`: they return counts, make no
 * Resend call and write nothing. A real wave stops after creating the Resend
 * broadcast (a draft) and is sent only by an explicit release.
 *
 * Eligibility is computed when a wave is picked, straight from the tables:
 * there is no cached audience, so a wave started on 4 December sees every
 * purchase, switch, unsubscribe and bounce up to that minute.
 */
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { isAccountDeleting } from "../accountDeletion/guard";
import { ACTIVE_PROMO } from "../../shared/promo-campaign";
import { createSegment } from "./_resendContacts";
import {
  accountLocale,
  classifyAccount,
  classifyWaitlist,
  SEND_CUTOFF_BEFORE_END_MS,
  groupsFor,
  segmentKey,
  sendFor,
  stampFieldFor,
  versionFor,
  waitlistLocale,
  type AccountGroup,
  type BlackFridaySend,
} from "./_blackFridayAudience";
import {
  BLACK_FRIDAY_LOCALES,
  BLACK_FRIDAY_OFFER,
  BLACK_FRIDAY_VERSIONS,
  type BlackFridayLocale,
  type BlackFridayRecipient,
  type BlackFridayVersion,
} from "./blackFridayEmailContent";
import {
  DEFAULT_BOUNCE_KILL_THRESHOLD,
  DEFAULT_COMPLAINT_KILL_THRESHOLD,
  MIN_DELIVERED_FOR_KILLGATE,
  MIN_HOURS_BETWEEN_WAVES,
} from "./rampRunner";

/** The campaign id, and the key of its `broadcastRampConfig` row. */
export const BLACK_FRIDAY_CONFIG_KEY = BLACK_FRIDAY_OFFER.campaignId;

/** First instant of the offer: a Pro Yearly period starting after it is a conversion. */
const OFFER_STARTS_AT_MS =
  ACTIVE_PROMO?.id === BLACK_FRIDAY_OFFER.campaignId ? ACTIVE_PROMO.startsAtMs : Date.UTC(2026, 10, 26, 0, 0, 0);

export { SEND_CUTOFF_BEFORE_END_MS };
/** The last-day emails say "ends today": they go out in the offer's final 24 hours only. */
export const LAST_DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * A held broadcast is released within this long of being created, or
 * discarded and re-picked: its segment was chosen at pick time, and people
 * who buy or switch afterwards are still in it.
 */
export const MAX_HOLD_MS = 6 * 60 * 60 * 1000;
/** The first waitlist wave is a canary: these addresses have not been emailed in months. */
export const WAITLIST_CANARY_MAX = 500;

/**
 * Scan cost. The audience scan reads every account and every registration,
 * about 50k and 48k in November 2026, from one action. Reading each row's
 * facts with its own indexed lookups, one after another, took about 7
 * sequential reads per account and 15 minutes in all, so the scan now:
 *
 *   - loads the small tables (suppressions, enterprise seats, subscriptions,
 *     entitlements, account deletions, customers) once per scan, a few
 *     thousand rows each, and classifies in the action;
 *   - keeps one indexed lookup per row against the other big table (an
 *     account's registration stamp, a registration's account), batched
 *     LOOKUP_CHUNK_SIZE to a query, LOOKUP_CONCURRENCY chunks at a time;
 *   - fetches the next page while the current page's lookups run.
 *
 * Every query stays far inside Convex's per-transaction limits (4,096 index
 * ranges, 32,000 documents, 16 MiB read): a page is 1 range and
 * SCAN_PAGE_SIZE documents, a lookup chunk is LOOKUP_CHUNK_SIZE ranges. At
 * most LOOKUP_CONCURRENCY + 1 of the scan's queries run at once, a small share
 * of the deployment's concurrent queries (16 on the smallest class).
 */
const SCAN_PAGE_SIZE = 1000;
/** Subscriptions carry the stored Dodo payload, so they come in smaller pages. */
const SUBSCRIPTIONS_PAGE_SIZE = 200;
const LOOKUP_CHUNK_SIZE = 250;
const LOOKUP_CONCURRENCY = 4;
/**
 * `_ineligibleNow` classifies this many emails at once. Each reads up to 6
 * lookups at a time, so at most 300 are in flight, under Convex's 1,000
 * concurrent IO operations per function.
 */
const RECHECK_CONCURRENCY = 50;
const PERSIST_CHUNK_SIZE = 500;
const DEFAULT_BATCH_SIZE = 250;

const sendValidator = v.union(v.literal("launch"), v.literal("last-day"));
const recipientValidator = v.union(v.literal("account"), v.literal("waitlist"));

type RampConfigRow = Doc<"broadcastRampConfig">;

// ───────────────────────────────────────────────────────────────────────────
// Audience rules over rows (shared by the scan and the export re-check)
// ───────────────────────────────────────────────────────────────────────────

/** One scanned row: an email, where it landed, and whether the send is already stamped. */
type AudienceRow = {
  email: string;
  /** "free" | "lapsed" | "monthly" | "waitlist", or "x:<exclusion reason>". */
  outcome: string;
  locale: BlackFridayLocale;
  stamped: boolean;
  /** Waitlist rows only: got the launch email. The last-day reminder needs it. */
  launchStamped: boolean;
};

/** The fields of a `users` row the rules read. */
type ScanUser = Pick<
  Doc<"users">,
  "userId" | "normalizedEmail" | "localeTag" | "localePrimary" | "blackFridayLaunchWave" | "blackFridayLastDayWave"
>;
/** The fields of a `registrations` row the rules read. */
type ScanRegistration = Pick<Doc<"registrations">, "normalizedEmail" | "blackFridayLaunchWave" | "blackFridayLastDayWave">;

/** What the small tables say about one account. */
type AccountReads = {
  suppressed: boolean;
  deleting: boolean;
  enterpriseMemberActive: boolean;
  subscriptions: Doc<"subscriptions">[];
  entitlement: Doc<"entitlements"> | null;
};

/**
 * An account's outcome before the registration-stamp check. `checkRegistration`
 * is set when that check can still change `stamped`: an eligible account
 * whose own row carries no stamp.
 */
function accountOutcome(
  user: ScanUser,
  send: BlackFridaySend,
  now: number,
  reads: AccountReads,
): { row: AudienceRow; checkRegistration: boolean } {
  const field = stampFieldFor(send);
  const email = user.normalizedEmail;
  const locale = accountLocale(user);
  if (!email) {
    return { row: { email: "", outcome: "x:no-email", locale, stamped: false, launchStamped: false }, checkRegistration: false };
  }
  // Every suppression reason excludes: bounce, complaint, manual, unsubscribe.
  // Checked before the rules, so a suppressed row is "suppressed" even when its
  // address would fail the rules' own email check.
  if (reads.suppressed) {
    return { row: { email, outcome: "x:suppressed", locale, stamped: false, launchStamped: false }, checkRegistration: false };
  }
  const result = classifyAccount(
    {
      normalizedEmail: email,
      suppressed: false,
      deleting: reads.deleting,
      enterpriseMemberActive: reads.enterpriseMemberActive,
      subscriptions: reads.subscriptions,
      entitlement: reads.entitlement,
    },
    now,
    OFFER_STARTS_AT_MS,
  );
  const outcome = result.eligible ? result.group : `x:${result.reason}`;
  const stamped = user[field] !== undefined;
  return {
    row: { email, outcome, locale, stamped, launchStamped: false },
    // A waitlist contact who signed up mid-campaign carries the stamp on
    // the registration, not on the new account.
    checkRegistration: !stamped && result.eligible,
  };
}

/** What the other tables say about one registration's email. */
type WaitlistReads = { suppressed: boolean; hasAccount: boolean; isCustomer: boolean };

function waitlistOutcome(registration: ScanRegistration, send: BlackFridaySend, reads: WaitlistReads): AudienceRow {
  const field = stampFieldFor(send);
  const email = registration.normalizedEmail;
  if (!email) return { email: "", outcome: "x:no-email", locale: "en", stamped: false, launchStamped: false };
  const result = classifyWaitlist({ normalizedEmail: email, ...reads });
  return {
    email,
    outcome: result.eligible ? "waitlist" : `x:${result.reason}`,
    locale: waitlistLocale(email),
    stamped: registration[field] !== undefined,
    launchStamped: registration.blackFridayLaunchWave !== undefined,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Export re-check: one row at a time, from indexed lookups
// ───────────────────────────────────────────────────────────────────────────

async function registrationStamped(ctx: QueryCtx, email: string, send: BlackFridaySend): Promise<boolean> {
  const registration = await ctx.db
    .query("registrations")
    .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", email))
    .first();
  return registration !== null && registration[stampFieldFor(send)] !== undefined;
}

async function accountExists(ctx: QueryCtx, email: string): Promise<boolean> {
  const account = await ctx.db
    .query("users")
    .withIndex("by_normalizedEmail", (q) => q.eq("normalizedEmail", email))
    .first();
  return account !== null;
}

/** Classify one `users` row from the live tables. */
async function classifyUserRow(ctx: QueryCtx, user: Doc<"users">, send: BlackFridaySend, now: number): Promise<AudienceRow> {
  const email = user.normalizedEmail;
  const noReads: AccountReads = { suppressed: false, deleting: false, enterpriseMemberActive: false, subscriptions: [], entitlement: null };
  if (!email) return accountOutcome(user, send, now, noReads).row;
  const [suppression, memberByUser, memberByEmail, subscriptions, entitlement, deleting] = await Promise.all([
    ctx.db
      .query("emailSuppressions")
      .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", email))
      .first(),
    ctx.db
      .query("enterpriseMembers")
      .withIndex("by_userId", (q) => q.eq("userId", user.userId))
      .collect(),
    ctx.db
      .query("enterpriseMembers")
      .withIndex("by_email", (q) => q.eq("email", email))
      .collect(),
    ctx.db
      .query("subscriptions")
      .withIndex("by_userId", (q) => q.eq("userId", user.userId))
      // Every row: an on-hold or covering subscription must never fall outside a cap.
      .collect(),
    ctx.db
      .query("entitlements")
      .withIndex("by_userId", (q) => q.eq("userId", user.userId))
      .first(),
    isAccountDeleting(ctx, user.userId),
  ]);
  const { row, checkRegistration } = accountOutcome(user, send, now, {
    suppressed: suppression !== null,
    deleting,
    enterpriseMemberActive: [...memberByUser, ...memberByEmail].some((m) => m.status === "active"),
    subscriptions,
    entitlement,
  });
  if (checkRegistration) row.stamped = await registrationStamped(ctx, email, send);
  return row;
}

/**
 * Emails of `customers` rows that predate `normalizedEmail` (absent from the
 * by_normalized_email index under their address). Mirrors the `email`
 * fallback in waveRuns._getPaidEmails.
 */
async function legacyCustomerEmailSet(ctx: QueryCtx): Promise<ReadonlySet<string>> {
  const rows = await ctx.db
    .query("customers")
    .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", undefined))
    .collect();
  return legacyCustomerEmails(rows);
}

function legacyCustomerEmails(rows: ReadonlyArray<Pick<Doc<"customers">, "email" | "normalizedEmail">>): Set<string> {
  return new Set(
    rows
      .filter((row) => row.normalizedEmail === undefined)
      .map((row) => (row.email ?? "").trim().toLowerCase())
      .filter((email) => email.length > 0),
  );
}

/** Classify one `registrations` row as a waitlist contact, or excluded. */
async function classifyRegistrationRow(
  ctx: QueryCtx,
  registration: Doc<"registrations">,
  send: BlackFridaySend,
  legacyEmails: ReadonlySet<string>,
): Promise<AudienceRow> {
  const email = registration.normalizedEmail;
  if (!email) return waitlistOutcome(registration, send, { suppressed: false, hasAccount: false, isCustomer: false });
  const suppression = await ctx.db
    .query("emailSuppressions")
    .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", email))
    .first();
  const hasAccount = suppression ? false : await accountExists(ctx, email);
  const customer =
    suppression || hasAccount
      ? null
      : await ctx.db
          .query("customers")
          .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", email))
          .first();
  return waitlistOutcome(registration, send, {
    suppressed: suppression !== null,
    hasAccount,
    // `customers` rows written before normalizedEmail existed carry only `email`.
    isCustomer: customer !== null || legacyEmails.has(email),
  });
}

/** `fn` over `items`, at most `concurrency` at a time, results in order. */
async function mapConcurrently<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    out.push(...(await Promise.all(items.slice(i, i + concurrency).map(fn))));
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Scan queries (read-only)
// ───────────────────────────────────────────────────────────────────────────

const smallTableValidator = v.union(
  v.literal("emailSuppressions"),
  v.literal("enterpriseMembers"),
  v.literal("subscriptions"),
  v.literal("entitlements"),
  v.literal("accountDeletions"),
  v.literal("customers"),
);
type SmallTable = "emailSuppressions" | "enterpriseMembers" | "subscriptions" | "entitlements" | "accountDeletions" | "customers";

type TablePage<T> = { page: T[]; isDone: boolean; continueCursor: string };

/** One page of a small table, in creation order. */
export const _smallTablePage = internalQuery({
  args: { table: smallTableValidator, cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { table, cursor }): Promise<TablePage<Doc<SmallTable>>> => {
    const numItems = table === "subscriptions" ? SUBSCRIPTIONS_PAGE_SIZE : SCAN_PAGE_SIZE;
    const page = await ctx.db.query(table).paginate({ cursor, numItems });
    return { page: page.page, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/** One page of `users`, only the fields the rules read. */
export const _scanUsersPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }): Promise<TablePage<ScanUser>> => {
    const page = await ctx.db.query("users").paginate({ cursor, numItems: SCAN_PAGE_SIZE });
    return {
      page: page.page.map((user) => ({
        userId: user.userId,
        normalizedEmail: user.normalizedEmail,
        localeTag: user.localeTag,
        localePrimary: user.localePrimary,
        blackFridayLaunchWave: user.blackFridayLaunchWave,
        blackFridayLastDayWave: user.blackFridayLastDayWave,
      })),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/** One page of `registrations`, only the fields the rules read. */
export const _scanRegistrationsPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }): Promise<TablePage<ScanRegistration>> => {
    const page = await ctx.db.query("registrations").paginate({ cursor, numItems: SCAN_PAGE_SIZE });
    return {
      page: page.page.map((registration) => ({
        normalizedEmail: registration.normalizedEmail,
        blackFridayLaunchWave: registration.blackFridayLaunchWave,
        blackFridayLastDayWave: registration.blackFridayLastDayWave,
      })),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/** For each email, whether its registration carries this send's stamp. In order. */
export const _registrationStamps = internalQuery({
  args: { send: sendValidator, emails: v.array(v.string()) },
  handler: async (ctx, { send, emails }): Promise<boolean[]> => {
    if (emails.length > LOOKUP_CHUNK_SIZE) throw new Error(`[_registrationStamps] at most ${LOOKUP_CHUNK_SIZE} emails`);
    return Promise.all(emails.map((email) => registrationStamped(ctx, email, send)));
  },
});

/** For each email, whether a `users` row has it. In order. */
export const _accountsExist = internalQuery({
  args: { emails: v.array(v.string()) },
  handler: async (ctx, { emails }): Promise<boolean[]> => {
    if (emails.length > LOOKUP_CHUNK_SIZE) throw new Error(`[_accountsExist] at most ${LOOKUP_CHUNK_SIZE} emails`);
    return Promise.all(emails.map((email) => accountExists(ctx, email)));
  },
});

/**
 * The export-time re-check. Called by the shared push step for each batch of
 * a campaign run, just before those contacts go into the Resend segment:
 * returns the emails that are no longer in this run's segment. A large wave
 * takes hours to push, and someone who bought, switched, unsubscribed or
 * bounced since the pick must not be added.
 *
 * Reads at most 8 index ranges per email (2,000 for a 250-contact batch).
 */
export const _ineligibleNow = internalQuery({
  args: {
    send: sendValidator,
    version: v.string(),
    locale: v.string(),
    recipient: recipientValidator,
    emails: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<string[]> => {
    const now = Date.now();
    const groups = groupsFor(args.version as BlackFridayVersion, args.recipient) ?? [];
    const legacy = args.recipient === "waitlist" ? await legacyCustomerEmailSet(ctx) : new Set<string>();
    const rows = await mapConcurrently(args.emails, RECHECK_CONCURRENCY, async (email): Promise<AudienceRow | null> => {
      if (args.recipient === "account") {
        const user = await ctx.db
          .query("users")
          .withIndex("by_normalizedEmail", (q) => q.eq("normalizedEmail", email))
          .first();
        return user ? classifyUserRow(ctx, user, args.send, now) : null;
      }
      const registration = await ctx.db
        .query("registrations")
        .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", email))
        .first();
      return registration ? classifyRegistrationRow(ctx, registration, args.send, legacy) : null;
    });
    return args.emails.filter((_email, i) => {
      const row = rows[i]!;
      const stillInSegment =
        row !== null &&
        (groups as readonly string[]).includes(row.outcome) &&
        row.locale === args.locale &&
        // Stamped by another wave of this send since the pick.
        !row.stamped;
      return !stillInSegment;
    });
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Scan (runs inside an action; no Resend, no writes)
// ───────────────────────────────────────────────────────────────────────────

type SegmentCount = { eligible: number; alreadySent: number; toSend: number };

export type BlackFridayAudienceReport = {
  send: BlackFridaySend;
  scanned: { users: number; registrations: number };
  /** Eligible people per audience group, before the already-sent check. */
  groups: Record<AccountGroup | "waitlist", SegmentCount>;
  /** Keyed "version/locale/recipient". */
  segments: Record<string, SegmentCount>;
  excluded: { accounts: Record<string, number>; waitlist: Record<string, number> };
  /** Waitlist contacts the last-day reminder skips because the launch email never reached them. */
  waitlistNotYetEmailed: number;
};

/** Uniform sample of at most `size` items from a stream (Algorithm R, as in waveRuns.ts). */
export class Reservoir<T> {
  private readonly buf: T[] = [];
  private seen = 0;
  constructor(private readonly size: number) {}
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
}

function bump(counts: Record<string, SegmentCount>, key: string, stamped: boolean): void {
  const entry = (counts[key] ??= { eligible: 0, alreadySent: 0, toSend: 0 });
  entry.eligible++;
  if (stamped) entry.alreadySent++;
  else entry.toSend++;
}

type ScanCtx = {
  runQuery: (ref: any, args: any) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};

/** Every row of a small table, in creation order. */
async function loadSmallTable<T extends SmallTable>(ctx: ScanCtx, table: T): Promise<Doc<T>[]> {
  const rows: Doc<T>[] = [];
  let cursor: string | null = null;
  while (true) {
    const page: TablePage<Doc<T>> = await ctx.runQuery(internal.broadcast.blackFriday._smallTablePage, { table, cursor });
    rows.push(...page.page);
    if (page.isDone) return rows;
    cursor = page.continueCursor;
  }
}

/**
 * The small tables as the indexed lookups would answer them: each map is
 * keyed on the exact field its index uses, and rows keep creation order (an
 * index's order within one key), so "first" is the same row.
 */
type AccountTables = {
  suppressed: ReadonlySet<string>;
  deleting: ReadonlySet<string>;
  activeMemberUserIds: ReadonlySet<string>;
  activeMemberEmails: ReadonlySet<string>;
  subscriptions: ReadonlyMap<string, Doc<"subscriptions">[]>;
  entitlements: ReadonlyMap<string, Doc<"entitlements">>;
};
type WaitlistTables = {
  suppressed: ReadonlySet<string>;
  customerEmails: ReadonlySet<string>;
  legacyCustomerEmails: ReadonlySet<string>;
};

async function loadAccountTables(ctx: ScanCtx, suppressions: Promise<Doc<"emailSuppressions">[]>): Promise<AccountTables> {
  const [suppressionRows, members, subscriptionRows, entitlementRows, deletions] = await Promise.all([
    suppressions,
    loadSmallTable(ctx, "enterpriseMembers"),
    loadSmallTable(ctx, "subscriptions"),
    loadSmallTable(ctx, "entitlements"),
    loadSmallTable(ctx, "accountDeletions"),
  ]);
  const active = members.filter((m) => m.status === "active");
  const subscriptions = new Map<string, Doc<"subscriptions">[]>();
  for (const sub of subscriptionRows) {
    const list = subscriptions.get(sub.userId);
    if (list) list.push(sub);
    else subscriptions.set(sub.userId, [sub]);
  }
  const entitlements = new Map<string, Doc<"entitlements">>();
  for (const row of entitlementRows) if (!entitlements.has(row.userId)) entitlements.set(row.userId, row);
  return {
    suppressed: new Set(suppressionRows.map((row) => row.normalizedEmail)),
    deleting: new Set(deletions.map((row) => row.userId)),
    activeMemberUserIds: new Set(active.flatMap((m) => (m.userId === undefined ? [] : [m.userId]))),
    activeMemberEmails: new Set(active.flatMap((m) => (m.email === undefined ? [] : [m.email]))),
    subscriptions,
    entitlements,
  };
}

async function loadWaitlistTables(ctx: ScanCtx, suppressions: Promise<Doc<"emailSuppressions">[]>): Promise<WaitlistTables> {
  const [suppressionRows, customers] = await Promise.all([suppressions, loadSmallTable(ctx, "customers")]);
  return {
    suppressed: new Set(suppressionRows.map((row) => row.normalizedEmail)),
    customerEmails: new Set(customers.flatMap((row) => (row.normalizedEmail === undefined ? [] : [row.normalizedEmail]))),
    legacyCustomerEmails: legacyCustomerEmails(customers),
  };
}

/**
 * Walk a big table page by page, fetching the next page while `process`
 * handles the current one. Pages reach `process` in order.
 */
async function walkPages<T>(
  ctx: ScanCtx,
  ref: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  process: (rows: T[]) => Promise<void>,
): Promise<void> {
  const fetchPage = (cursor: string | null): Promise<TablePage<T>> => ctx.runQuery(ref, { cursor });
  let next = fetchPage(null);
  while (true) {
    const page = await next;
    if (!page.isDone) {
      next = fetchPage(page.continueCursor);
      // Surfaces on the next await; never as an unhandled rejection if `process` throws first.
      next.catch(() => {});
    }
    await process(page.page);
    if (page.isDone) return;
  }
}

/** One boolean per email from a chunked lookup query, LOOKUP_CONCURRENCY chunks at a time. */
async function lookupAll(
  ctx: ScanCtx,
  ref: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  emails: readonly string[],
  extra: Record<string, unknown> = {},
): Promise<Map<string, boolean>> {
  const unique = [...new Set(emails)];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += LOOKUP_CHUNK_SIZE) chunks.push(unique.slice(i, i + LOOKUP_CHUNK_SIZE));
  const results: boolean[][] = await mapConcurrently(chunks, LOOKUP_CONCURRENCY, (chunk) =>
    ctx.runQuery(ref, { ...extra, emails: chunk }),
  );
  const out = new Map<string, boolean>();
  chunks.forEach((chunk, c) => chunk.forEach((email, i) => out.set(email, results[c]![i]!)));
  return out;
}

/**
 * Walk the audience tables once. `collect` gathers the emails of one segment
 * that have not had this send, through a reservoir of the requested size.
 */
export async function scanAudience(
  ctx: ScanCtx,
  send: BlackFridaySend,
  scope: { accounts: boolean; waitlist: boolean },
  collect?: { key: string; reservoir: Reservoir<string> },
): Promise<BlackFridayAudienceReport> {
  const empty = (): SegmentCount => ({ eligible: 0, alreadySent: 0, toSend: 0 });
  const report: BlackFridayAudienceReport = {
    send,
    scanned: { users: 0, registrations: 0 },
    groups: { free: empty(), lapsed: empty(), monthly: empty(), waitlist: empty() },
    segments: {},
    excluded: { accounts: {}, waitlist: {} },
    waitlistNotYetEmailed: 0,
  };
  const seen = new Set<string>();

  const take = (row: AudienceRow, recipient: BlackFridayRecipient, excluded: Record<string, number>) => {
    if (row.outcome.startsWith("x:")) {
      const reason = row.outcome.slice(2);
      excluded[reason] = (excluded[reason] ?? 0) + 1;
      return;
    }
    if (seen.has(row.email)) {
      excluded["duplicate-email"] = (excluded["duplicate-email"] ?? 0) + 1;
      return;
    }
    seen.add(row.email);
    const group = row.outcome as AccountGroup | "waitlist";
    if (group === "waitlist" && send === "last-day" && !row.launchStamped) {
      // The reminder only goes to waitlist addresses the ramp already reached.
      report.waitlistNotYetEmailed++;
      return;
    }
    bump(report.groups, group, row.stamped);
    const key = segmentKey(versionFor(send, group), row.locale, recipient);
    bump(report.segments, key, row.stamped);
    if (collect && collect.key === key && !row.stamped) collect.reservoir.offer(row.email);
  };

  // The small tables, once per scan. Suppressions serve both walks.
  const suppressions = loadSmallTable(ctx, "emailSuppressions");
  suppressions.catch(() => {});
  const accountTables = scope.accounts ? loadAccountTables(ctx, suppressions) : null;
  accountTables?.catch(() => {});
  const waitlistTables = scope.waitlist ? loadWaitlistTables(ctx, suppressions) : null;
  waitlistTables?.catch(() => {});

  if (accountTables) {
    const tables = await accountTables;
    const now = Date.now();
    await walkPages<ScanUser>(ctx, internal.broadcast.blackFriday._scanUsersPage, async (users) => {
      report.scanned.users += users.length;
      const classified = users.map((user) => {
        const email = user.normalizedEmail ?? "";
        return accountOutcome(user, send, now, {
          suppressed: tables.suppressed.has(email),
          deleting: tables.deleting.has(user.userId),
          enterpriseMemberActive: tables.activeMemberUserIds.has(user.userId) || tables.activeMemberEmails.has(email),
          subscriptions: tables.subscriptions.get(user.userId) ?? [],
          entitlement: tables.entitlements.get(user.userId) ?? null,
        });
      });
      const stamps = await lookupAll(
        ctx,
        internal.broadcast.blackFriday._registrationStamps,
        classified.filter((c) => c.checkRegistration).map((c) => c.row.email),
        { send },
      );
      for (const { row, checkRegistration } of classified) {
        if (checkRegistration) row.stamped = stamps.get(row.email) === true;
        take(row, "account", report.excluded.accounts);
      }
    });
  }
  if (waitlistTables) {
    const tables = await waitlistTables;
    await walkPages<ScanRegistration>(ctx, internal.broadcast.blackFriday._scanRegistrationsPage, async (registrations) => {
      report.scanned.registrations += registrations.length;
      // Only a registration that is not suppressed needs the account lookup.
      const needsAccount = registrations
        .map((registration) => registration.normalizedEmail)
        .filter((email) => email && !tables.suppressed.has(email));
      const accounts = await lookupAll(ctx, internal.broadcast.blackFriday._accountsExist, needsAccount);
      for (const registration of registrations) {
        const email = registration.normalizedEmail;
        const suppressed = !!email && tables.suppressed.has(email);
        const hasAccount = !!email && !suppressed && accounts.get(email) === true;
        const row = waitlistOutcome(registration, send, {
          suppressed,
          hasAccount,
          isCustomer: !!email && (tables.customerEmails.has(email) || tables.legacyCustomerEmails.has(email)),
        });
        take(row, "waitlist", report.excluded.waitlist);
      }
    });
  }
  return report;
}

/**
 * DRY RUN ONLY: every group, every segment and every exclusion reason, as
 * counts. Reads the live tables; no Resend call, no write, no addresses in
 * the result or the logs.
 *
 *   npx convex run broadcast/blackFriday:blackFridayAudience '{"send":"launch"}'
 *   npx convex run broadcast/blackFriday:blackFridayAudience '{"send":"launch","scope":"accounts"}'
 */
export const blackFridayAudience = internalAction({
  args: {
    send: sendValidator,
    /** Scan one table only. Default: both. */
    scope: v.optional(v.union(v.literal("accounts"), v.literal("waitlist"))),
  },
  handler: async (ctx, { send, scope }): Promise<BlackFridayAudienceReport> => {
    return scanAudience(ctx, send, { accounts: scope !== "waitlist", waitlist: scope !== "accounts" });
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Campaign config, status and kill gate
// ───────────────────────────────────────────────────────────────────────────

/**
 * Create the campaign's config row: its lease, thresholds and kill gate. It
 * is never `active`, so the daily PRO-launch cron ignores it.
 */
export const initBlackFriday = internalMutation({
  args: {
    bounceKillThreshold: v.optional(v.number()),
    complaintKillThreshold: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("broadcastRampConfig")
      .withIndex("by_key", (q) => q.eq("key", BLACK_FRIDAY_CONFIG_KEY))
      .first();
    if (existing) return { ok: true as const, created: false as const };
    await ctx.db.insert("broadcastRampConfig", {
      key: BLACK_FRIDAY_CONFIG_KEY,
      active: false,
      rampCurve: [],
      currentTier: -1,
      waveLabelPrefix: "bf",
      waveLabelOffset: 0,
      bounceKillThreshold: args.bounceKillThreshold ?? DEFAULT_BOUNCE_KILL_THRESHOLD,
      complaintKillThreshold: args.complaintKillThreshold ?? DEFAULT_COMPLAINT_KILL_THRESHOLD,
      killGateTripped: false,
    });
    return { ok: true as const, created: true as const };
  },
});

type CampaignRun = {
  runId: string;
  waveLabel: string;
  status: Doc<"waveRuns">["status"];
  failureSubstatus?: string;
  error?: string;
  campaign: NonNullable<Doc<"waveRuns">["campaign"]>;
  segmentId?: string;
  broadcastId?: string;
  requestedCount: number;
  totalCount: number;
  pushedCount: number;
  failedCount: number;
  suppressedCount: number;
  held: boolean;
  /** When the Resend draft was created; no recovery command moves it. */
  broadcastCreatedAt?: number;
  updatedAt: number;
};

type CampaignState = { config: RampConfigRow | null; runs: CampaignRun[] };

async function loadCampaignState(ctx: QueryCtx): Promise<CampaignState> {
  const config = await ctx.db
    .query("broadcastRampConfig")
    .withIndex("by_key", (q) => q.eq("key", BLACK_FRIDAY_CONFIG_KEY))
    .first();
  const rows = await ctx.db
    .query("waveRuns")
    .withIndex("by_configKey", (q) => q.eq("configKey", BLACK_FRIDAY_CONFIG_KEY))
    .collect();
  const runs: CampaignRun[] = [];
  for (const run of rows) {
    if (!run.campaign) continue;
    runs.push({
      runId: run.runId,
      waveLabel: run.waveLabel,
      status: run.status,
      failureSubstatus: run.failureSubstatus,
      error: run.error,
      campaign: run.campaign,
      segmentId: run.segmentId,
      broadcastId: run.broadcastId,
      requestedCount: run.requestedCount,
      totalCount: run.totalCount,
      pushedCount: run.pushedCount,
      failedCount: run.failedCount,
      suppressedCount: run.suppressedCount ?? 0,
      held:
        run.status === "broadcast-created" &&
        run.campaign.holdBeforeSend &&
        run.releaseRequestedAt === undefined,
      broadcastCreatedAt: run.broadcastCreatedAt,
      updatedAt: run.updatedAt,
    });
  }
  return { config, runs };
}

export const _campaignState = internalQuery({
  args: {},
  handler: async (ctx): Promise<CampaignState> => loadCampaignState(ctx),
});

/**
 * Where the campaign stands: the gate, the lease, and every wave.
 *
 *   npx convex run broadcast/blackFriday:getBlackFridayStatus '{}'
 */
export const getBlackFridayStatus = internalQuery({
  args: {},
  handler: async (ctx) => {
    const state = await loadCampaignState(ctx);
    const config = state.config;
    return {
      configured: config !== null,
      killGateTripped: config?.killGateTripped ?? false,
      killGateReason: config?.killGateReason,
      bounceKillThreshold: config?.bounceKillThreshold,
      complaintKillThreshold: config?.complaintKillThreshold,
      leaseHeldBy: config?.pendingRunId,
      offerEndsAt: new Date(BLACK_FRIDAY_OFFER.endsAtMs).toISOString(),
      sendCutoffAt: new Date(BLACK_FRIDAY_OFFER.endsAtMs - SEND_CUTOFF_BEFORE_END_MS).toISOString(),
      runs: state.runs.sort((a, b) => a.updatedAt - b.updatedAt),
    };
  },
});

async function setKillGate(
  ctx: MutationCtx,
  tripped: boolean,
  reason: string,
): Promise<{ ok: true; changed: boolean }> {
  const config = await ctx.db
    .query("broadcastRampConfig")
    .withIndex("by_key", (q) => q.eq("key", BLACK_FRIDAY_CONFIG_KEY))
    .first();
  if (!config) throw new Error("[blackFriday] not initialised: run initBlackFriday first");
  if (tripped) {
    // The first reason stands; later checks must not overwrite it.
    if (config.killGateTripped) return { ok: true as const, changed: false as const };
    await ctx.db.patch(config._id, { killGateTripped: true, killGateReason: reason.slice(0, 500) });
    return { ok: true as const, changed: true as const };
  }
  if (!config.killGateTripped) return { ok: true as const, changed: false as const };
  await ctx.db.patch(config._id, {
    killGateTripped: false,
    killGateReason: undefined,
    lastRunStatus: `kill-gate-cleared: ${reason.slice(0, 200)}`,
  });
  return { ok: true as const, changed: true as const };
}

export const _setKillGate = internalMutation({
  args: { tripped: v.boolean(), reason: v.string() },
  handler: async (ctx, { tripped, reason }) => setKillGate(ctx, tripped, reason),
});

/**
 * Stop the campaign by hand: no wave starts and no held broadcast is released
 * until the gate is cleared. A broadcast Resend is already sending is not
 * recalled.
 *
 *   npx convex run broadcast/blackFriday:stopBlackFriday '{"reason":"..."}'
 */
export const stopBlackFriday = internalMutation({
  args: { reason: v.string() },
  handler: async (ctx, { reason }) => setKillGate(ctx, true, `stopped by operator: ${reason}`),
});

/** Clear the gate after investigating. It never clears itself. */
export const clearBlackFridayKillGate = internalMutation({
  args: { reason: v.string() },
  handler: async (ctx, { reason }) => setKillGate(ctx, false, reason),
});

type RateBlock = {
  broadcasts: number;
  delivered: number;
  bounced: number;
  complained: number;
  bounceRate: number | null;
  complaintRate: number | null;
  /** Enough deliveries for the rates to mean something. */
  trusted: boolean;
  overThreshold: boolean;
};

export type BlackFridayHealth = {
  all: RateBlock;
  waitlist: RateBlock;
  accounts: RateBlock;
  thresholds: { bounce: number; complaint: number; minDelivered: number };
  /** Set when a trusted rate is over its threshold. */
  tripReason: string | null;
};

function rateBlock(
  broadcasts: number,
  counts: { delivered: number; bounced: number; complained: number },
  thresholds: { bounce: number; complaint: number },
): RateBlock {
  const rate = (n: number) => (counts.delivered > 0 ? n / counts.delivered : null);
  const bounceRate = rate(counts.bounced);
  const complaintRate = rate(counts.complained);
  const trusted = counts.delivered >= MIN_DELIVERED_FOR_KILLGATE;
  return {
    broadcasts,
    ...counts,
    bounceRate,
    complaintRate,
    trusted,
    overThreshold:
      trusted &&
      ((bounceRate !== null && bounceRate > thresholds.bounce) ||
        (complaintRate !== null && complaintRate > thresholds.complaint)),
  };
}

async function computeHealth(
  ctx: { runAction: (ref: any, args: any) => Promise<any> }, // eslint-disable-line @typescript-eslint/no-explicit-any
  state: CampaignState,
): Promise<BlackFridayHealth> {
  const thresholds = {
    bounce: state.config?.bounceKillThreshold ?? DEFAULT_BOUNCE_KILL_THRESHOLD,
    complaint: state.config?.complaintKillThreshold ?? DEFAULT_COMPLAINT_KILL_THRESHOLD,
  };
  const sums = {
    account: { broadcasts: 0, delivered: 0, bounced: 0, complained: 0 },
    waitlist: { broadcasts: 0, delivered: 0, bounced: 0, complained: 0 },
  };
  for (const run of state.runs) {
    // Every broadcast that may have gone out: sent, or released with the send in flight or unconfirmed.
    if (!run.broadcastId || run.held) continue;
    const stats: { counts: Record<string, number> } = await ctx.runAction(
      internal.broadcast.metrics.getBroadcastStats,
      { broadcastId: run.broadcastId },
    );
    const bucket = sums[run.campaign.recipient];
    bucket.broadcasts++;
    bucket.delivered += stats.counts["email.delivered"] ?? 0;
    bucket.bounced += stats.counts["email.bounced"] ?? 0;
    bucket.complained += stats.counts["email.complained"] ?? 0;
  }
  const total = {
    delivered: sums.account.delivered + sums.waitlist.delivered,
    bounced: sums.account.bounced + sums.waitlist.bounced,
    complained: sums.account.complained + sums.waitlist.complained,
  };
  const all = rateBlock(sums.account.broadcasts + sums.waitlist.broadcasts, total, thresholds);
  const waitlist = rateBlock(sums.waitlist.broadcasts, sums.waitlist, thresholds);
  const accounts = rateBlock(sums.account.broadcasts, sums.account, thresholds);
  const pct = (n: number | null, digits: number) => (n === null ? "n/a" : `${(n * 100).toFixed(digits)}%`);
  let tripReason: string | null = null;
  for (const [name, block] of [["waitlist", waitlist], ["accounts", accounts], ["all", all]] as const) {
    if (block.overThreshold) {
      tripReason =
        `${name} broadcasts: bounce ${pct(block.bounceRate, 2)} (limit ${pct(thresholds.bounce, 2)}), ` +
        `complaint ${pct(block.complaintRate, 3)} (limit ${pct(thresholds.complaint, 3)}) on ${block.delivered} delivered`;
      break;
    }
  }
  return {
    all,
    waitlist,
    accounts,
    thresholds: { ...thresholds, minDelivered: MIN_DELIVERED_FOR_KILLGATE },
    tripReason,
  };
}

/**
 * Bounce and complaint rates across the campaign's broadcasts, from the
 * webhook events in `broadcastEvents`. Read-only: it reports, it does not trip.
 *
 *   npx convex run broadcast/blackFriday:blackFridayHealth '{}'
 */
export const blackFridayHealth = internalAction({
  args: {},
  handler: async (ctx): Promise<BlackFridayHealth> => {
    const state: CampaignState = await ctx.runQuery(internal.broadcast.blackFriday._campaignState, {});
    return computeHealth(ctx, state);
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Start a wave
// ───────────────────────────────────────────────────────────────────────────

/** Why a wave may not start now, or null. Pure, so the rules are unit-tested. */
export function waveRefusal(args: {
  now: number;
  send: BlackFridaySend;
  recipient: BlackFridayRecipient;
  count: number | undefined;
  settleHours: number;
  configured: boolean;
  killGateTripped: boolean;
  killGateReason?: string;
  leaseHeldBy?: string;
  health: Pick<BlackFridayHealth, "tripReason" | "waitlist">;
  runs: ReadonlyArray<Pick<CampaignRun, "status" | "campaign" | "updatedAt" | "pushedCount">>;
}): string | null {
  if (!args.configured) return "not initialised: run initBlackFriday first";
  if (args.killGateTripped) return `kill gate tripped: ${args.killGateReason ?? "<no reason>"}`;
  if (args.health.tripReason) return `kill gate: ${args.health.tripReason}`;
  if (args.leaseHeldBy) return `another wave holds the lease (${args.leaseHeldBy}); finish, release or discard it first`;
  const end = BLACK_FRIDAY_OFFER.endsAtMs;
  if (args.now >= end - SEND_CUTOFF_BEFORE_END_MS) {
    return "too close to the end of the offer (or past it): no more waves";
  }
  if (args.send === "last-day" && args.now < end - LAST_DAY_WINDOW_MS) {
    return 'the last-day emails say "ends today": they start in the offer\'s final 24 hours';
  }
  if (args.send === "launch" && args.now >= end - LAST_DAY_WINDOW_MS) {
    return "the launch emails stop in the offer's final 24 hours: send the last-day versions";
  }
  if (args.recipient !== "waitlist") return null;

  const sent = args.runs.filter((run) => run.status === "sent");
  if (!sent.some((run) => run.campaign.recipient === "account" && run.campaign.send === args.send)) {
    return "account holders go first: no account wave of this send has been sent yet";
  }
  // The reminder only reaches waitlist addresses the launch ramp already
  // proved, so it is not ramped again.
  if (args.send === "last-day") return null;
  if (args.count === undefined) return "waitlist waves are ramped: pass a count";
  const waitlistSent = sent.filter((run) => run.campaign.recipient === "waitlist");
  if (waitlistSent.length === 0) {
    return args.count > WAITLIST_CANARY_MAX
      ? `the first waitlist wave is a canary: count must be ${WAITLIST_CANARY_MAX} or less`
      : null;
  }
  const lastSentAt = Math.max(...waitlistSent.map((run) => run.updatedAt));
  const hours = (args.now - lastSentAt) / 3_600_000;
  if (hours < args.settleHours) {
    return (
      `only ${hours.toFixed(1)}h since the last waitlist wave; bounces and complaints need ` +
      `${args.settleHours}h to come back before the next one`
    );
  }
  if (!args.health.waitlist.trusted) {
    // A canary that exported too few contacts can never reach the delivery
    // floor. More may go out, but only inside the canary allowance in total.
    const exported = waitlistSent.reduce((sum, run) => sum + run.pushedCount, 0);
    const allowance = WAITLIST_CANARY_MAX - exported;
    if (args.count <= allowance) return null;
    return (
      `the waitlist canary has ${args.health.waitlist.delivered} delivered so far; ` +
      `${MIN_DELIVERED_FOR_KILLGATE} are needed before its bounce and complaint rates are trusted. ` +
      (allowance > 0
        ? `Until then a wave may hold at most ${allowance} (the rest of the ${WAITLIST_CANARY_MAX} canary allowance)`
        : `The ${WAITLIST_CANARY_MAX} canary allowance is used up`)
    );
  }
  return null;
}

function defaultWaveLabel(
  version: BlackFridayVersion,
  locale: BlackFridayLocale,
  recipient: BlackFridayRecipient,
  wave: number,
): string {
  return `bf-${version}-${locale}-${recipient}-${wave}`;
}

type StartResult =
  | {
      dryRun: true;
      segment: string;
      waveLabel: string;
      eligible: number;
      alreadySent: number;
      toSend: number;
      wouldPick: number;
      /** Why a real run would refuse right now, or null. */
      wouldRefuse: string | null;
    }
  | { dryRun: false; runId: string; segment: string; waveLabel: string; segmentId: string; picked: number; toSend: number };

/**
 * Pick one segment's wave and load it into a fresh Resend segment.
 *
 * DRY RUN BY DEFAULT: without `"dryRun": false` this returns counts only.
 *
 *   npx convex run broadcast/blackFriday:startBlackFridayWave \
 *     '{"version":"new-buyer","locale":"en","recipient":"account"}'
 *
 * A real run claims the campaign lease, picks eligible contacts who have not
 * had this send, creates the segment and hands off to the shared push
 * pipeline (waveRuns.pushBatchAction), which stamps each contact as it lands.
 * The pipeline then creates the Resend broadcast and STOPS: nothing is sent
 * until `releaseBlackFridayBroadcast` is called with `"dryRun": false`.
 */
export const startBlackFridayWave = internalAction({
  args: {
    version: v.string(),
    locale: v.string(),
    recipient: recipientValidator,
    /** Cap on contacts in this wave. Required for waitlist launch waves. */
    count: v.optional(v.number()),
    /** Distinguishes waves of one segment; part of the default label. */
    wave: v.optional(v.number()),
    waveLabel: v.optional(v.string()),
    /** Hours since the last waitlist wave before a larger one. Default 18, as the PRO-launch ramp. */
    settleHours: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<StartResult> => {
    if (!(BLACK_FRIDAY_VERSIONS as readonly string[]).includes(args.version)) {
      throw new Error(`[startBlackFridayWave] unknown version "${args.version}"`);
    }
    if (!(BLACK_FRIDAY_LOCALES as readonly string[]).includes(args.locale)) {
      throw new Error(`[startBlackFridayWave] unknown locale "${args.locale}"`);
    }
    const version = args.version as BlackFridayVersion;
    const locale = args.locale as BlackFridayLocale;
    const recipient = args.recipient;
    const groups = groupsFor(version, recipient);
    if (!groups) {
      throw new Error(`[startBlackFridayWave] "${version}" is not sent to ${recipient} contacts`);
    }
    if (args.count !== undefined && (!Number.isInteger(args.count) || args.count <= 0)) {
      throw new Error("[startBlackFridayWave] count must be a positive integer");
    }
    const settleHours = args.settleHours ?? MIN_HOURS_BETWEEN_WAVES;
    if (!(settleHours >= 2)) throw new Error("[startBlackFridayWave] settleHours must be at least 2");
    const wave = args.wave ?? 1;
    const waveLabel = args.waveLabel ?? defaultWaveLabel(version, locale, recipient, wave);
    if (waveLabel.length === 0 || waveLabel.length > 64) {
      throw new Error("[startBlackFridayWave] waveLabel must be 1-64 chars");
    }
    const send = sendFor(version);
    const key = segmentKey(version, locale, recipient);
    // Anything but an explicit `false` is a dry run.
    const dryRun = args.dryRun !== false;

    const state: CampaignState = await ctx.runQuery(internal.broadcast.blackFriday._campaignState, {});
    const health = await computeHealth(ctx, state);
    const refusal = waveRefusal({
      now: Date.now(),
      send,
      recipient,
      count: args.count,
      settleHours,
      configured: state.config !== null,
      killGateTripped: state.config?.killGateTripped ?? false,
      killGateReason: state.config?.killGateReason,
      leaseHeldBy: state.config?.pendingRunId,
      health,
      runs: state.runs,
    });
    const labelTaken = state.runs.some((run) => run.waveLabel === waveLabel);
    const wouldRefuse = refusal ?? (labelTaken ? `wave label "${waveLabel}" is already used: pass a new "wave" number` : null);

    const scope = { accounts: recipient === "account", waitlist: recipient === "waitlist" };

    if (dryRun) {
      const report = await scanAudience(ctx, send, scope);
      const counts = report.segments[key] ?? { eligible: 0, alreadySent: 0, toSend: 0 };
      return {
        dryRun: true,
        segment: key,
        waveLabel,
        ...counts,
        wouldPick: Math.min(args.count ?? counts.toSend, counts.toSend),
        wouldRefuse,
      };
    }

    // ── Real run from here. ──
    if (health.tripReason && state.config && !state.config.killGateTripped) {
      await ctx.runMutation(internal.broadcast.blackFriday._setKillGate, { tripped: true, reason: health.tripReason });
    }
    if (wouldRefuse) throw new Error(`[startBlackFridayWave] refused: ${wouldRefuse}`);
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error("[startBlackFridayWave] RESEND_API_KEY not set");

    const runId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const requestedCount = args.count ?? Number.MAX_SAFE_INTEGER;
    const claim: { ok: boolean; reason?: string; current?: string } = await ctx.runMutation(
      internal.broadcast.waveRuns._claimWaveRunLease,
      {
        waveLabel,
        runId,
        // The run row records the cap; an uncapped wave records 0 until picked.
        requestedCount: args.count ?? 0,
        batchSize: DEFAULT_BATCH_SIZE,
        configKey: BLACK_FRIDAY_CONFIG_KEY,
        campaign: { id: BLACK_FRIDAY_CONFIG_KEY, send, version, locale, recipient, holdBeforeSend: true },
      },
    );
    if (!claim.ok) {
      throw new Error(
        `[startBlackFridayWave] could not claim lease: ${claim.reason}` + (claim.current ? ` (current: ${claim.current})` : ""),
      );
    }

    // Eligibility is read now, after the lease, from the live tables.
    const reservoir = new Reservoir<string>(requestedCount);
    const report = await scanAudience(ctx, send, scope, { key, reservoir });
    const counts = report.segments[key] ?? { eligible: 0, alreadySent: 0, toSend: 0 };
    const picked = reservoir.values();
    if (picked.length === 0) {
      await ctx.runMutation(internal.broadcast.waveRuns._markPickFailed, {
        runId,
        substatus: "empty-pool",
        error: `no one left to send in ${key}`,
      });
      throw new Error(`[startBlackFridayWave] nothing to send in ${key}: everyone eligible already has this send`);
    }

    let segmentId: string;
    try {
      segmentId = await createSegment(apiKey, `black-friday-2026-${waveLabel}`);
    } catch (err) {
      await ctx.runMutation(internal.broadcast.waveRuns._markPickFailed, {
        runId,
        substatus: "segment-create-failed",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    try {
      for (let i = 0; i < picked.length; i += PERSIST_CHUNK_SIZE) {
        await ctx.runMutation(internal.broadcast.waveRuns._persistPickedBatch, {
          runId,
          contacts: picked.slice(i, i + PERSIST_CHUNK_SIZE),
        });
      }
    } catch (err) {
      await ctx.runMutation(internal.broadcast.waveRuns._markPickFailed, {
        runId,
        substatus: "persist-failed",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    await ctx.runMutation(internal.broadcast.waveRuns._markPickComplete, {
      runId,
      segmentId,
      totalCount: picked.length,
      underfilled: args.count !== undefined && picked.length < args.count,
    });
    await ctx.scheduler.runAfter(0, internal.broadcast.waveRuns.pushBatchAction, { runId, batchN: 0 });
    console.log(
      `[startBlackFridayWave] runId=${runId} segment=${key} waveLabel=${waveLabel} picked=${picked.length} toSend=${counts.toSend}`,
    );
    return { dryRun: false, runId, segment: key, waveLabel, segmentId, picked: picked.length, toSend: counts.toSend };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Release a held broadcast (this is the send)
// ───────────────────────────────────────────────────────────────────────────

type ReleaseResult = {
  dryRun: boolean;
  runId: string;
  waveLabel: string;
  segment: string;
  broadcastId: string | undefined;
  recipients: number;
  /** Why a real release would refuse right now, or null. */
  wouldRefuse: string | null;
  released: boolean;
};

/**
 * Send a held broadcast. DRY RUN BY DEFAULT: without `"dryRun": false` this
 * only reports what would be sent and whether the gate would allow it.
 *
 *   npx convex run broadcast/blackFriday:releaseBlackFridayBroadcast '{"runId":"<runId>"}'
 *   npx convex run broadcast/blackFriday:releaseBlackFridayBroadcast '{"runId":"<runId>","dryRun":false}'
 *
 * The kill gate is re-checked here, against every broadcast sent so far.
 */
export const releaseBlackFridayBroadcast = internalAction({
  args: { runId: v.string(), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<ReleaseResult> => {
    const dryRun = args.dryRun !== false;
    const state: CampaignState = await ctx.runQuery(internal.broadcast.blackFriday._campaignState, {});
    const run = state.runs.find((candidate) => candidate.runId === args.runId);
    if (!run) throw new Error(`[releaseBlackFridayBroadcast] no Black Friday run ${args.runId}`);
    const health = await computeHealth(ctx, state);
    const now = Date.now();
    let wouldRefuse: string | null = null;
    if (!run.held) {
      wouldRefuse = `run is ${run.status}${run.failureSubstatus ? `/${run.failureSubstatus}` : ""}, not a held broadcast`;
    } else if (run.pushedCount === 0) {
      wouldRefuse = "the segment is empty: everyone picked became ineligible before export. Discard this run";
    } else if (state.config?.killGateTripped) {
      wouldRefuse = `kill gate tripped: ${state.config.killGateReason ?? "<no reason>"}`;
    } else if (health.tripReason) {
      wouldRefuse = `kill gate: ${health.tripReason}`;
    } else if (now >= BLACK_FRIDAY_OFFER.endsAtMs - SEND_CUTOFF_BEFORE_END_MS) {
      wouldRefuse = "too close to the end of the offer (or past it): discard this run instead";
    } else if (now - (run.broadcastCreatedAt ?? run.updatedAt) > MAX_HOLD_MS) {
      wouldRefuse =
        "held too long: the segment was picked hours ago and may hold people who have since bought. " +
        "Discard it (waveRuns:discardHeldCampaignRun) and start the wave again";
    } else if (run.campaign.send === "last-day" && now < BLACK_FRIDAY_OFFER.endsAtMs - LAST_DAY_WINDOW_MS) {
      wouldRefuse = 'the last-day emails say "ends today": release in the offer\'s final 24 hours';
    }
    const result: ReleaseResult = {
      dryRun,
      runId: run.runId,
      waveLabel: run.waveLabel,
      segment: segmentKey(
        run.campaign.version as BlackFridayVersion,
        run.campaign.locale as BlackFridayLocale,
        run.campaign.recipient,
      ),
      broadcastId: run.broadcastId,
      recipients: run.pushedCount,
      wouldRefuse,
      released: false,
    };
    if (dryRun) return result;

    if (health.tripReason && state.config && !state.config.killGateTripped) {
      await ctx.runMutation(internal.broadcast.blackFriday._setKillGate, { tripped: true, reason: health.tripReason });
    }
    if (wouldRefuse) throw new Error(`[releaseBlackFridayBroadcast] refused: ${wouldRefuse}`);
    await ctx.runMutation(internal.broadcast.waveRuns._requestCampaignRelease, { runId: run.runId });
    return { ...result, released: true };
  },
});
