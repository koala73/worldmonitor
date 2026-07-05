import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  PRODUCT_CATALOG,
  getPlanLimit,
  type PlanLimitDimension,
} from "./config/productCatalog";
import {
  classifyUsageThreshold,
  getUsageRatio,
  shouldRecoverNotice,
  type ApiPlanLimitCtaKind,
  type ApiPlanLimitNoticeState,
} from "./apiPlanLimitNotices";

type ActiveEntitlement = {
  userId: string;
  planKey: string;
  tier: number;
  apiAccess: boolean;
  mcpAccess: boolean;
};

type ScannerUsageRow = {
  userId: string;
  planKey?: string;
  dimension: PlanLimitDimension;
  usage: number;
  minuteBuckets?: number[];
  source: string;
  sourceFreshAt?: number;
};

type NoticeInput = {
  state: ApiPlanLimitNoticeState;
  upgradeTargetPlanKey?: string;
  ctaKind: ApiPlanLimitCtaKind;
  blockedReason?: string;
};

type ScannerSummary = {
  dryRun: boolean;
  evaluated: number;
  wouldNotify: number;
  notified: number;
  recovered: number;
  skipped: Array<{ userId?: string; dimension?: string; reason: string }>;
  blocked: Array<{ userId?: string; dimension?: string; reason: string }>;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const AXIOM_QUERY_URL = "https://api.axiom.co/v1/datasets/_apl?format=legacy";

const dimensionValidator = v.union(
  v.literal("api_daily_requests"),
  v.literal("api_minute_burst"),
  v.literal("mcp_daily_calls"),
  v.literal("mcp_minute_burst"),
);

const scannerUsageRowValidator = v.object({
  userId: v.string(),
  planKey: v.optional(v.string()),
  dimension: dimensionValidator,
  usage: v.number(),
  minuteBuckets: v.optional(v.array(v.number())),
  source: v.string(),
  sourceFreshAt: v.optional(v.number()),
});

function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function utcMinuteKey(now: number): string {
  return new Date(now).toISOString().slice(0, 16);
}

function windowForDimension(dimension: PlanLimitDimension, now: number) {
  if (dimension === "api_minute_burst" || dimension === "mcp_minute_burst") {
    const end = Math.floor(now / 60_000) * 60_000;
    return {
      // Rollup window keeps minute granularity for audit.
      windowKey: utcMinuteKey(end),
      windowStart: end - (5 * 60_000),
      windowEnd: end,
      // Notice identity is COARSE (UTC day) so a burst that continues across the
      // hourly scan boundary dedupes to one notice instead of minting a fresh
      // pending row every scan (which would bypass the 6h email cadence and drop
      // dismiss / attempt state). A sustained_burst is an ongoing condition, not
      // a single minute — a per-day notice identity matches the daily dims.
      noticeWindowKey: utcDayKey(now),
    };
  }
  const day = new Date(utcDayKey(now));
  const start = day.getTime();
  return {
    windowKey: utcDayKey(now),
    windowStart: start,
    windowEnd: start + DAY_MS,
    noticeWindowKey: utcDayKey(now),
  };
}

function dodoUpgradeNotice(planKey: string, dimension: PlanLimitDimension): Omit<NoticeInput, "state"> {
  if (planKey === "pro_monthly" || planKey === "pro_annual") {
    return { upgradeTargetPlanKey: "api_starter", ctaKind: "checkout" };
  }
  if (planKey === "api_starter" || planKey === "api_starter_annual") {
    const business = PRODUCT_CATALOG.api_business;
    // Gate billing_portal on a real self-serve plan-CHANGE surface, not on
    // currentForCheckout ("purchasable at all"). The Dodo customer portal
    // surfaces the prorated Starter→Business change only for MONTHLY api_starter:
    // it shares a product collection with "Allow Subscription Updates" enabled
    // (#4634). api_starter_annual DOES carry planLimits (API_STARTER_FEATURES),
    // so it IS scanner-reachable — but its membership in that upgradeable
    // collection is unverified, so routing it to the portal risks a dead-end
    // (open portal, no upgrade path). Send annual to contact_support until that
    // is confirmed. This also keeps parity with the Settings "Upgrade to
    // Business" button, which renders only for exact 'api_starter'.
    if (planKey === "api_starter" && business?.canChangePlanSelfServe) {
      return { upgradeTargetPlanKey: "api_business", ctaKind: "billing_portal" };
    }
    return {
      upgradeTargetPlanKey: "api_business",
      ctaKind: "contact_support",
      blockedReason: "api_business_not_self_serve",
    };
  }
  if (dimension === "api_daily_requests" || dimension === "api_minute_burst") {
    return { ctaKind: "contact_support", blockedReason: "no_self_serve_higher_api_plan" };
  }
  return { ctaKind: "none" };
}

function noticeForRow(
  row: ScannerUsageRow,
  planKey: string,
  limit: number | null,
): NoticeInput | null {
  const state = classifyUsageThreshold({
    dimension: row.dimension,
    usage: row.usage,
    limit,
    minuteBuckets: row.minuteBuckets,
  });
  if (!state) return null;
  return { state, ...dodoUpgradeNotice(planKey, row.dimension) };
}

// A recognized Axiom `?format=legacy` result envelope carries its rows under one
// of these array fields — an EMPTY array is a valid "no rows" result. Keep the
// branches in sync with normalizeAxiomRows.
function isRecognizedAxiomResultShape(data: unknown): boolean {
  const d = data as any;
  return (
    Array.isArray(d?.matches) ||
    Array.isArray(d?.tables?.[0]?.rows) ||
    Array.isArray(d?.rows)
  );
}

// Decide whether an HTTP-200 body that ISN'T a recognized result envelope should
// BLOCK the dimension (a genuine Axiom error) or be read as an EMPTY result.
// Block only when the body is a non-object or carries an explicit Axiom error
// signature (error / message / code). An unrecognized-but-error-free object is
// treated as empty (normalizeAxiomRows yields []): this is deliberately biased
// toward "empty" so a drift in the shape of the EMPTY summarize response can't
// classify every routine no-burst scan as axiom_unexpected_body and freeze every
// open burst notice via the recovery sweep. A real Axiom failure still carries an
// error field and blocks, and a genuine outage rejects the fetch (axiom_query_error).
function isAxiomErrorBody(data: unknown): boolean {
  if (data == null || typeof data !== "object") return true;
  if (isRecognizedAxiomResultShape(data)) return false;
  const d = data as any;
  return typeof d.error !== "undefined" || typeof d.message === "string" || typeof d.code !== "undefined";
}

function normalizeAxiomRows(data: unknown, dimension: PlanLimitDimension): ScannerUsageRow[] {
  const rawRows =
    Array.isArray((data as any)?.matches)
      ? (data as any).matches.map((match: any) => match.data ?? match)
      : Array.isArray((data as any)?.tables?.[0]?.rows)
        ? (data as any).tables[0].rows
        : Array.isArray((data as any)?.rows)
          ? (data as any).rows
          : [];

  return rawRows.flatMap((row: any) => {
    const userId = row.customer_id ?? row.customerId ?? row.user_id ?? row.userId;
    const usage = Number(row.usage ?? row.requests ?? row.count ?? 0);
    if (typeof userId !== "string" || userId.length === 0 || !Number.isFinite(usage) || usage < 0) return [];
    const minuteBuckets = Array.isArray(row.minuteBuckets)
      ? row.minuteBuckets.map(Number).filter(Number.isFinite)
      : undefined;
    return [{
      userId,
      planKey: typeof row.planKey === "string" ? row.planKey : undefined,
      dimension,
      usage,
      minuteBuckets,
      source: "axiom:wm_api_usage",
      sourceFreshAt: Date.now(),
    }];
  });
}

async function queryAxiom(apl: string, dimension: PlanLimitDimension): Promise<{
  rows: ScannerUsageRow[];
  blockedReason?: string;
}> {
  const token = process.env.AXIOM_QUERY_TOKEN ?? process.env.AXIOM_API_TOKEN;
  if (!token) return { rows: [], blockedReason: "missing_axiom_query_token" };

  // A timeout (AbortSignal), DNS/network failure, or malformed JSON REJECTS the
  // fetch/json promise -- which the `!resp.ok` branch below does NOT cover. An
  // uncaught rejection here propagates through buildProductionRows and aborts
  // the ENTIRE hourly scan for every user/dimension, so catch it and degrade to
  // a blocked source (which the recovery sweep already refuses to false-clear).
  try {
    const resp = await fetch(process.env.AXIOM_QUERY_URL ?? AXIOM_QUERY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "worldmonitor-convex-plan-limit-scanner/1.0",
      },
      body: JSON.stringify({ apl }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      return { rows: [], blockedReason: `axiom_query_http_${resp.status}` };
    }
    const json = await resp.json();
    if (isAxiomErrorBody(json)) {
      // HTTP 200 carrying an Axiom error signature (or a non-object body). Block
      // the dimension instead of letting normalizeAxiomRows yield an empty [] that
      // reads identically to a genuinely-empty result. A recognized-or-plausibly-
      // empty body falls through and normalizes (to [] when it has no rows).
      return { rows: [], blockedReason: "axiom_unexpected_body" };
    }
    return { rows: normalizeAxiomRows(json, dimension) };
  } catch {
    return { rows: [], blockedReason: "axiom_query_error" };
  }
}

function dailyCounterKey(userId: string, date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `mcp:pro-usage:${userId}:${yyyy}-${mm}-${dd}`;
}

// The SAME per-account daily meter #3199 enforcement authoritatively increments
// (server/_shared/api-key-rate-limit.ts `apiKeyDailyKey`) so a warning matches
// what is (or will be) enforced, instead of a lossy Axiom count() on a different
// identity. Keyed by the Clerk userId (== the gateway's `sessionUserId` identity
// for user API keys == entitlements.userId), which also removes the Axiom
// customer_id join for the daily axis. Un-prefixed: `getKeyPrefix()` is empty in
// production (VERCEL_ENV), matching the existing un-prefixed mcp pro-daily read.
function apiDailyMeterKey(userId: string, date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `rl:apikey:day:${userId}:${yyyy}-${mm}-${dd}`;
}

async function readRedisInteger(key: string): Promise<number | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  // Same rejection risk as queryAxiom: a timeout/network error on the fetch must
  // not escape and abort the scan. `null` signals a blocked read to the caller.
  try {
    const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    // Let a JSON-parse failure propagate to the outer catch -> null (BLOCKED),
    // not a silent 0. A false 0 here reads as "genuinely zero usage" and would
    // false-clear a live over_limit notice on a corrupt Upstash body.
    const data = await resp.json() as { result?: unknown } | null;
    const raw = data?.result;
    // Upstash returns result:null for a missing key -> genuinely 0 usage today.
    if (raw == null) return 0;
    const n = Number(raw);
    // A present-but-non-numeric value is corruption, not zero -> block it.
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export const listActivePaidEntitlements = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, args): Promise<ActiveEntitlement[]> => {
    const rows = await ctx.db
      .query("entitlements")
      .withIndex("by_validUntil", (q) => q.gte("validUntil", args.now))
      .collect();
    return rows
      .filter((row) => row.features.tier > 0)
      .map((row) => ({
        userId: row.userId,
        planKey: row.planKey,
        tier: row.features.tier,
        apiAccess: row.features.apiAccess,
        mcpAccess: row.features.mcpAccess === true,
      }));
  },
});

// Bounded-concurrency map: runs `fn` over `items` in fixed-size batches so a
// large active-customer set doesn't serialize hundreds of Upstash round trips
// (nor fire them all at once). Order-independent -- callers key results by row.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    results.push(...(await Promise.all(chunk.map(fn))));
  }
  return results;
}

const REDIS_READ_CONCURRENCY = 10;

async function buildProductionRows(
  active: ActiveEntitlement[],
  now: number,
): Promise<{ rows: ScannerUsageRow[]; blocked: ScannerSummary["blocked"] }> {
  const blocked: ScannerSummary["blocked"] = [];
  const rows: ScannerUsageRow[] = [];
  const day = utcDayKey(now);

  // api_daily_requests is now sourced from the enforcement Redis meter, keyed by
  // userId, in the Upstash-gated block below (not an Axiom count() by customer_id).
  // The per-minute burst axis stays Axiom-derived: the rl:apikey:min meter is a
  // single counter with no 5-bucket history to express sustained_burst.
  //
  // Count real API traffic: successful requests AND per-minute rate-limit
  // rejections. In shadow mode (API_RATE_LIMIT_ENFORCE off) an over-limit request
  // is served 200 with reason rl_min_shadow, so `status < 400` alone catches it —
  // but once enforcement flips on, over-limit requests become 429 (rl_min_429) and
  // a bare `status < 400` would DROP exactly the excess traffic that defines a
  // sustained burst, capping the per-minute count at the limit so the notice
  // silently dies at enforcement. Include the rl_min_* reasons so burst detection
  // survives the shadow→enforce transition. Genuine errors (auth 401/403,
  // malformed) stay excluded — they are not usage.
  const burstApl = `['wm_api_usage']
| where event_type == "request" and _time > ago(10m)
| where auth_kind in ("user_api_key", "enterprise_api_key") and (status < 400 or reason in ("rl_min_429", "rl_min_shadow"))
| where isnotnull(customer_id) and customer_id != ""
| summarize usage = count() by customer_id, minute = bin(_time, 1m)`;
  const burst = await queryAxiom(burstApl, "api_minute_burst");
  if (burst.blockedReason) {
    blocked.push({ dimension: "api_minute_burst", reason: burst.blockedReason });
  } else {
    const byUser = new Map<string, number[]>();
    for (const row of burst.rows) {
      const buckets = byUser.get(row.userId) ?? [];
      buckets.push(row.usage);
      byUser.set(row.userId, buckets);
    }
    for (const [userId, minuteBuckets] of byUser) {
      rows.push({
        userId,
        dimension: "api_minute_burst",
        usage: Math.max(...minuteBuckets, 0),
        minuteBuckets,
        source: "axiom:wm_api_usage",
        sourceFreshAt: now,
      });
    }
  }

  // mcp_daily_calls for Pro accounts is authoritatively metered by the Redis
  // mcp:pro-usage counter (read in the Upstash block below), NOT the Axiom
  // mcp.toolcall count. The Axiom count also tallies quota-EXEMPT calls, so it
  // reads structurally higher, and dual-sourcing mints a second row that flaps
  // the same-dimension notice within one scan. Drop the Axiom row for those
  // users so the Redis read (or its blocked entry) is their single source; the
  // Axiom row still stands for api-tier mcpAccess plans that have no Redis
  // counter. Mirrors the U8 api_daily_requests move to a single Redis source.
  const redisMcpDailyUsers = new Set(
    active
      .filter((e) => (e.planKey === "pro_monthly" || e.planKey === "pro_annual") && e.mcpAccess)
      .map((e) => e.userId),
  );
  const mcpDailyApl = `['wm_api_usage']
| where tag == "mcp.toolcall" and ok == true and _time >= datetime(${day}T00:00:00Z)
| where isnotnull(user_id) and user_id != ""
| summarize usage = count() by user_id`;
  const mcpDaily = await queryAxiom(mcpDailyApl, "mcp_daily_calls");
  rows.push(...mcpDaily.rows
    .filter((row) => !redisMcpDailyUsers.has(row.userId))
    .map((row) => ({
      ...row,
      source: "axiom:mcp_toolcall",
    })));
  if (mcpDaily.blockedReason) blocked.push({ dimension: "mcp_daily_calls", reason: mcpDaily.blockedReason });

  const mcpBurstApl = `['wm_api_usage']
| where tag == "mcp.rate_limit_hit" and dimension == "mcp_minute_burst" and _time > ago(10m)
| where isnotnull(user_id) and user_id != ""
| summarize hits = count(), observed_limit = max(todouble(limit)) by user_id, minute = bin(_time, 1m)
| extend usage = coalesce(observed_limit, 60) + hits`;
  const mcpBurst = await queryAxiom(mcpBurstApl, "mcp_minute_burst");
  if (mcpBurst.blockedReason) {
    blocked.push({ dimension: "mcp_minute_burst", reason: mcpBurst.blockedReason });
  } else {
    const byUser = new Map<string, number[]>();
    for (const row of mcpBurst.rows) {
      const buckets = byUser.get(row.userId) ?? [];
      buckets.push(row.usage);
      byUser.set(row.userId, buckets);
    }
    for (const [userId, minuteBuckets] of byUser) {
      rows.push({
        userId,
        dimension: "mcp_minute_burst",
        usage: Math.max(...minuteBuckets, 0),
        minuteBuckets,
        source: "axiom:mcp_rate_limit_hit",
        sourceFreshAt: now,
      });
    }
  }

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    blocked.push({ dimension: "api_daily_requests", reason: "missing_upstash_credentials_for_daily_meter" });
    blocked.push({ dimension: "mcp_daily_calls", reason: "missing_upstash_credentials_for_pro_daily_fallback" });
    return { rows, blocked };
  }

  const meterDate = new Date(now);
  type DailyRead = {
    userId: string;
    planKey: string;
    dimension: PlanLimitDimension;
    source: string;
  };
  const reads: DailyRead[] = [];
  for (const ent of active) {
    // api_daily_requests: read the SAME per-account daily meter #3199 enforces
    // on, keyed by userId. Skip unlimited plans (null limit == enterprise; the
    // gateway never meters them, so the key is absent anyway).
    if (ent.apiAccess && getPlanLimit(ent.planKey, "api_daily_requests") != null) {
      reads.push({ userId: ent.userId, planKey: ent.planKey, dimension: "api_daily_requests", source: "redis:apikey_day" });
    }
    // mcp_daily_calls: existing Pro daily-counter fallback (unchanged).
    const isPro = ent.planKey === "pro_monthly" || ent.planKey === "pro_annual";
    if (isPro && ent.mcpAccess) {
      reads.push({ userId: ent.userId, planKey: ent.planKey, dimension: "mcp_daily_calls", source: "redis:mcp_pro_daily" });
    }
  }

  // Read the per-user daily counters in bounded-concurrency batches instead of
  // one sequential round trip per user, so the hourly scan's wall-clock doesn't
  // grow linearly with the paid-customer count.
  const readResults = await mapWithConcurrency(reads, REDIS_READ_CONCURRENCY, async (read) => {
    const key = read.dimension === "api_daily_requests"
      ? apiDailyMeterKey(read.userId, meterDate)
      : dailyCounterKey(read.userId, meterDate);
    return { read, usage: await readRedisInteger(key) };
  });

  for (const { read, usage } of readResults) {
    if (usage == null) {
      blocked.push({ userId: read.userId, dimension: read.dimension, reason: "redis_read_failed" });
      continue;
    }
    rows.push({
      userId: read.userId,
      planKey: read.planKey,
      dimension: read.dimension,
      usage,
      source: read.source,
      sourceFreshAt: now,
    });
  }

  return { rows, blocked };
}

async function scanHandler(ctx: any, args: {
  dryRun?: boolean;
  now?: number;
  rows?: ScannerUsageRow[];
}): Promise<ScannerSummary> {
  const now = args.now ?? Date.now();
  const dryRun = args.dryRun === true;
  const active = await ctx.runQuery(
    (internal as any).apiPlanLimitUsage.listActivePaidEntitlements,
    { now },
  ) as ActiveEntitlement[];
  const byUser = new Map(active.map((ent) => [ent.userId, ent]));
  const summary: ScannerSummary = {
    dryRun,
    evaluated: 0,
    wouldNotify: 0,
    notified: 0,
    recovered: 0,
    skipped: [],
    blocked: [],
  };

  const source = args.rows
    ? { rows: args.rows, blocked: [] as ScannerSummary["blocked"] }
    : await buildProductionRows(active, now);
  summary.blocked.push(...source.blocked);

  // (user::dimension) pairs the loop actually EVALUATED this scan. The recovery
  // sweep below keys off this set — NOT all source.rows — so a row that was gated
  // out (no_api_access) or couldn't be joined to an entitlement stays sweep-
  // eligible. Otherwise its (user, dimension) would count as "handled" and a
  // stale api_* notice on a now-non-apiAccess account (downgrade, or a legacy
  // notice minted before this gate) would never clear.
  const evaluated = new Set<string>();

  for (const row of source.rows) {
    const ent = byUser.get(row.userId);
    if (!ent) {
      summary.skipped.push({ userId: row.userId, dimension: row.dimension, reason: "unknown_or_inactive_entitlement" });
      continue;
    }
    // An api_* dimension only applies to accounts that actually hold API access.
    // Pro (and free) entitlements have apiAccess:false but a 0 planLimit for the
    // api dims, and their ordinary Clerk-session dashboard traffic still lands in
    // wm_api_usage with a customer_id — so without this gate the Axiom burst read
    // would attribute those requests to the Pro user and mint a false
    // "over API plan limit" notice + upsell email. Mirrors the daily read, which
    // only pushes api_daily_requests rows for apiAccess entitlements.
    const isApiDimension = row.dimension === "api_daily_requests" || row.dimension === "api_minute_burst";
    if (isApiDimension && !ent.apiAccess) {
      summary.skipped.push({ userId: row.userId, dimension: row.dimension, reason: "no_api_access" });
      continue;
    }
    const planKey = row.planKey ?? ent.planKey;
    const limit = getPlanLimit(planKey, row.dimension);
    const window = windowForDimension(row.dimension, now);
    summary.evaluated += 1;
    evaluated.add(`${row.userId}::${row.dimension}`);

    const notice = noticeForRow(row, planKey, limit);
    if (notice?.blockedReason) {
      summary.blocked.push({ userId: row.userId, dimension: row.dimension, reason: notice.blockedReason });
    }
    if (notice) summary.wouldNotify += 1;

    if (dryRun) continue;

    // Contain a per-row mutation failure: one row hitting a Convex write/read
    // limit (or any transient error) must not abort the whole hourly scan and
    // starve every other user of notices/recovery this cycle.
    try {
      await ctx.runMutation(
        (internal as any).apiPlanLimitNotices.recordUsageEvaluation,
        {
          rollup: {
            userId: row.userId,
            planKey,
            dimension: row.dimension,
            windowKey: window.windowKey,
            noticeWindowKey: window.noticeWindowKey,
            windowStart: window.windowStart,
            windowEnd: window.windowEnd,
            limit,
            usage: row.usage,
            source: row.source,
            sourceFreshAt: row.sourceFreshAt ?? now,
            computedAt: now,
          },
          notice: notice ?? undefined,
        },
      );

      if (notice) {
        summary.notified += 1;
        continue;
      }

      if (shouldRecoverNotice({
        dimension: row.dimension,
        usage: row.usage,
        limit,
        usageRatio: getUsageRatio(row.usage, limit),
      })) {
        const result = await ctx.runMutation(
          (internal as any).apiPlanLimitNotices.clearRecoveredCurrentNotices,
          { userId: row.userId, dimension: row.dimension, recoveredAt: now },
        ) as { cleared: number };
        summary.recovered += result.cleared;
      }
    } catch {
      summary.blocked.push({ userId: row.userId, dimension: row.dimension, reason: "record_usage_failed" });
      continue;
    }
  }

  // Stale-notice recovery sweep. The per-row loop above only recovers notices
  // for users who appear in THIS scan's usage rows. Burst notices — and any
  // notice belonging to a user who has since gone idle — never reappear in a
  // later scan, so without this sweep they stay `current: true` forever. For
  // every open notice whose (user, dimension) produced no row this scan AND
  // whose data source is healthy, clear it: no usage row from a healthy source
  // means the user has fallen back under the threshold.
  if (!dryRun) {
    // Source-level outages (missing token, HTTP error, absent Upstash creds)
    // land in `source.blocked` WITHOUT a userId. Never treat a blocked source
    // as "recovered" — a transient Axiom/Redis failure must not silently clear
    // every open notice for that dimension.
    const blockedDimensions = new Set(
      source.blocked.filter((b) => !b.userId && b.dimension).map((b) => b.dimension),
    );
    const blockedUserDimensions = new Set(
      source.blocked
        .filter((b) => b.userId && b.dimension)
        .map((b) => `${b.userId}::${b.dimension}`),
    );
    const openKeys = await ctx.runQuery(
      (internal as any).apiPlanLimitNotices.listCurrentNoticeKeys,
      {},
    ) as Array<{ userId: string; dimension: PlanLimitDimension }>;
    for (const key of openKeys) {
      const pair = `${key.userId}::${key.dimension}`;
      if (evaluated.has(pair)) continue; // evaluated this scan — handled by the loop above
      if (blockedDimensions.has(key.dimension)) continue;
      if (blockedUserDimensions.has(pair)) continue;
      const result = await ctx.runMutation(
        (internal as any).apiPlanLimitNotices.clearRecoveredCurrentNotices,
        { userId: key.userId, dimension: key.dimension, recoveredAt: now },
      ) as { cleared: number };
      summary.recovered += result.cleared;
    }
  }

  return summary;
}

export const scanApiPlanLimitUsageInternal = internalAction({
  args: {
    dryRun: v.optional(v.boolean()),
    now: v.optional(v.number()),
    rows: v.optional(v.array(scannerUsageRowValidator)),
  },
  handler: scanHandler,
});
