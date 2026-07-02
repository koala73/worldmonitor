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
      windowKey: utcMinuteKey(end),
      windowStart: end - (5 * 60_000),
      windowEnd: end,
    };
  }
  const day = new Date(utcDayKey(now));
  const start = day.getTime();
  return {
    windowKey: utcDayKey(now),
    windowStart: start,
    windowEnd: start + DAY_MS,
  };
}

function dodoUpgradeNotice(planKey: string, dimension: PlanLimitDimension): Omit<NoticeInput, "state"> {
  if (planKey === "pro_monthly" || planKey === "pro_annual") {
    return { upgradeTargetPlanKey: "api_starter", ctaKind: "checkout" };
  }
  if (planKey === "api_starter" || planKey === "api_starter_annual") {
    const business = PRODUCT_CATALOG.api_business;
    if (business?.selfServe && business.currentForCheckout) {
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
  return { rows: normalizeAxiomRows(await resp.json(), dimension) };
}

function dailyCounterKey(userId: string, date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `mcp:pro-usage:${userId}:${yyyy}-${mm}-${dd}`;
}

async function readRedisInteger(key: string): Promise<number | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json().catch(() => null) as { result?: unknown } | null;
  const n = Number(data?.result ?? 0);
  return Number.isFinite(n) ? n : 0;
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

async function buildProductionRows(
  active: ActiveEntitlement[],
  now: number,
): Promise<{ rows: ScannerUsageRow[]; blocked: ScannerSummary["blocked"] }> {
  const blocked: ScannerSummary["blocked"] = [];
  const rows: ScannerUsageRow[] = [];
  const day = utcDayKey(now);

  const dailyApl = `['wm_api_usage']
| where event_type == "request" and _time >= datetime(${day}T00:00:00Z)
| where isnotnull(customer_id) and customer_id != ""
| summarize usage = count() by customer_id`;
  const daily = await queryAxiom(dailyApl, "api_daily_requests");
  rows.push(...daily.rows);
  if (daily.blockedReason) blocked.push({ dimension: "api_daily_requests", reason: daily.blockedReason });

  const burstApl = `['wm_api_usage']
| where event_type == "request" and _time > ago(10m)
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

  const mcpDailyApl = `['wm_api_usage']
| where tag == "mcp.toolcall" and ok == true and _time >= datetime(${day}T00:00:00Z)
| where isnotnull(user_id) and user_id != ""
| summarize usage = count() by user_id`;
  const mcpDaily = await queryAxiom(mcpDailyApl, "mcp_daily_calls");
  rows.push(...mcpDaily.rows.map((row) => ({
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
    blocked.push({ dimension: "mcp_daily_calls", reason: "missing_upstash_credentials_for_pro_daily_fallback" });
    return { rows, blocked };
  }

  for (const ent of active) {
    const isPro = ent.planKey === "pro_monthly" || ent.planKey === "pro_annual";
    if (!isPro || !ent.mcpAccess) continue;
    const usage = await readRedisInteger(dailyCounterKey(ent.userId, new Date(now)));
    if (usage == null) {
      blocked.push({ userId: ent.userId, dimension: "mcp_daily_calls", reason: "redis_read_failed" });
      continue;
    }
    rows.push({
      userId: ent.userId,
      planKey: ent.planKey,
      dimension: "mcp_daily_calls",
      usage,
      source: "redis:mcp_pro_daily",
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

  for (const row of source.rows) {
    const ent = byUser.get(row.userId);
    if (!ent) {
      summary.skipped.push({ userId: row.userId, dimension: row.dimension, reason: "unknown_or_inactive_entitlement" });
      continue;
    }
    const planKey = row.planKey ?? ent.planKey;
    const limit = getPlanLimit(planKey, row.dimension);
    const window = windowForDimension(row.dimension, now);
    summary.evaluated += 1;

    const notice = noticeForRow(row, planKey, limit);
    if (notice?.blockedReason) {
      summary.blocked.push({ userId: row.userId, dimension: row.dimension, reason: notice.blockedReason });
    }
    if (notice) summary.wouldNotify += 1;

    if (dryRun) continue;

    await ctx.runMutation(
      (internal as any).apiPlanLimitNotices.recordUsageEvaluation,
      {
        rollup: {
          userId: row.userId,
          planKey,
          dimension: row.dimension,
          windowKey: window.windowKey,
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
