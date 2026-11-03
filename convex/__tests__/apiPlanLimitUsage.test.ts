import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import { getFeaturesForPlan } from "../lib/entitlements";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");
const usageFns = (internal as any).apiPlanLimitUsage;

const NOW = 1_800_000_000_000;
const FUTURE = NOW + 30 * 86_400_000;
const EMPTY_AXIOM_LEGACY_RESULT = {
  format: "legacy",
  datasetNames: ["wm_api_usage"],
  status: {
    blocksExamined: 0,
    cacheStatus: 0,
    elapsedTime: 1,
    isPartial: false,
    maxBlockTime: "2026-11-02T00:00:00Z",
    minBlockTime: "2026-11-02T00:00:00Z",
    numGroups: 0,
    rowsExamined: 0,
    rowsMatched: 0,
  },
};
const AXIOM_LOW_USAGE_ROW = {
  customer_id: "user-starter",
  minute: new Date(NOW - 60_000).toISOString(),
  usage: 10,
};

// Legacy aggregate shape from @axiomhq/js QueryResult / Timeseries.
function axiomBurstResult(usages: number[], layout: "totals" | "series", minutesAgo = usages.map((_, index) => usages.length - index)) {
  const totals = usages.map((usage, index) => ({
    id: index,
    group: { customer_id: "user-starter", minute: new Date(NOW - minutesAgo[index] * 60_000).toISOString() },
    aggregations: [{ op: "count", value: usage }],
  }));
  return {
    ...EMPTY_AXIOM_LEGACY_RESULT,
    status: { ...EMPTY_AXIOM_LEGACY_RESULT.status, rowsMatched: usages.reduce((sum, usage) => sum + usage, 0), numGroups: totals.length },
    buckets: layout === "totals"
      ? { totals, series: [] }
      : {
        series: totals.map((entry) => ({
          startTime: entry.group.minute,
          endTime: new Date(Date.parse(entry.group.minute) + 60_000).toISOString(),
          groups: [{ ...entry, group: { customer_id: entry.group.customer_id } }],
        })),
        totals: [{ id: 0, group: { customer_id: "user-starter" }, aggregations: [{ op: "count", value: usages.reduce((sum, usage) => sum + usage, 0) }] }],
      },
  };
}

async function seedEntitlement(t: ReturnType<typeof convexTest>, userId: string, planKey: string) {
  await t.run(async (ctx) => {
    await ctx.db.insert("entitlements", {
      userId,
      planKey,
      features: getFeaturesForPlan(planKey),
      validUntil: FUTURE,
      updatedAt: NOW,
    });
  });
}

async function seedCurrentApiBurstNotice(t: ReturnType<typeof convexTest>) {
  await seedEntitlement(t, "user-starter", "api_starter");
  await t.action(usageFns.scanApiPlanLimitUsageInternal, {
    now: NOW,
    rows: [{ userId: "user-starter", dimension: "api_minute_burst", usage: 90, minuteBuckets: [61, 62, 63, 65, 66], source: "axiom:wm_api_usage" }],
  });
}

describe("api plan-limit usage scanner", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  test("a failing Axiom fetch degrades to a blocked source, not an aborted scan", async () => {
    const t = convexTest(schema, modules);
    // Token present so queryAxiom proceeds to fetch (which we make reject).
    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("simulated network failure / AbortSignal timeout");
    }));

    // Production path (no `rows`) -> buildProductionRows -> queryAxiom -> fetch throws.
    // The scan must complete and record the failure as a blocked source rather
    // than letting the rejection abort the whole hourly scan for every user.
    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW });

    expect(summary.blocked.some((b: { reason?: string }) => b.reason === "axiom_query_error")).toBe(true);
    expect(summary.notified).toBe(0);
  });

  test("api daily detection reads the Redis rl:apikey:day meter, keyed by userId", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-api", "api_starter");
    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://upstash.test");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "upstash-token");

    // Route the production path's outbound calls: Axiom returns nothing (so the
    // OLD count() source would yield no daily notice), while the enforcement
    // meter GET returns 1200 (> the 1000/day Starter cap). A daily over_limit
    // notice can therefore only come from reading the meter.
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("api.axiom.co")) {
        return new Response(JSON.stringify({ matches: [] }), { status: 200 });
      }
      if (u.includes("rl%3Aapikey%3Aday")) {
        return new Response(JSON.stringify({ result: "1200" }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: "0" }), { status: 200 });
    }));

    await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW });

    const notices = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    const daily = notices.filter((n) => n.dimension === "api_daily_requests");
    expect(daily).toHaveLength(1);
    expect(daily[0]).toMatchObject({ state: "over_limit", usage: 1200 });

    const rollups = await t.run((ctx) => ctx.db.query("apiUsageRollups").collect());
    const dailyRollup = rollups.find((r) => r.dimension === "api_daily_requests");
    expect(dailyRollup?.usage).toBe(1200);
    expect(dailyRollup?.source).toContain("apikey_day");
  });

  test("a malformed meter body blocks the read instead of false-clearing a live notice", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-api", "api_starter");
    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://upstash.test");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "upstash-token");

    // Scan 1: meter over the 1000/day limit -> current over_limit notice.
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("api.axiom.co")) return new Response(JSON.stringify({ matches: [] }), { status: 200 });
      if (u.includes("rl%3Aapikey%3Aday")) return new Response(JSON.stringify({ result: "1200" }), { status: 200 });
      return new Response(JSON.stringify({ result: "0" }), { status: 200 });
    }));
    await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW });
    let notices = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(notices.filter((n) => n.current)).toHaveLength(1);

    // Scan 2: the meter GET returns a MALFORMED (non-JSON) body. That must be a
    // BLOCKED read (null), not usage:0 -- otherwise the ratio-0 recovery path
    // false-clears a paying customer's live over_limit notice on a Redis hiccup.
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("api.axiom.co")) return new Response(JSON.stringify({ matches: [] }), { status: 200 });
      if (u.includes("rl%3Aapikey%3Aday")) return new Response("<html>bad gateway</html>", { status: 200 });
      return new Response(JSON.stringify({ result: "0" }), { status: 200 });
    }));
    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW + 3_600_000 });

    notices = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(notices.filter((n) => n.current)).toHaveLength(1); // NOT false-cleared
    expect(summary.blocked.some((b: { reason?: string }) => b.reason === "redis_read_failed")).toBe(true);
  });

  test("dry run reports would-notify without mutating notice state", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-api", "api_starter");

    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, {
      dryRun: true,
      now: NOW,
      rows: [{
        userId: "user-api",
        dimension: "api_daily_requests",
        usage: 850,
        source: "test",
      }],
    });

    expect(summary).toMatchObject({
      dryRun: true,
      evaluated: 1,
      wouldNotify: 1,
      notified: 0,
    });
    const notices = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(notices).toHaveLength(0);
  });

  test("records over-limit API Starter notice with a self-serve billing_portal CTA", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-api", "api_starter");

    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, {
      now: NOW,
      rows: [{
        userId: "user-api",
        dimension: "api_daily_requests",
        usage: 1_200,
        source: "test",
      }],
    });

    expect(summary.notified).toBe(1);
    // Self-serve upgrade is live (#4634): an over-cap Starter customer now gets a
    // billing_portal CTA (→ the Dodo collection upgrade), so the notice is NOT
    // recorded as blocked-for-no-self-serve-path.
    expect(summary.blocked).not.toContainEqual({
      userId: "user-api",
      dimension: "api_daily_requests",
      reason: "api_business_not_self_serve",
    });

    const notices = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      state: "over_limit",
      ctaKind: "billing_portal",
      upgradeTargetPlanKey: "api_business",
    });
    expect(notices[0].blockedReason).toBeUndefined();
  });

  test("an over-limit annual API Starter notice routes to contact_support, not a portal dead-end", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-annual", "api_starter_annual");

    // api_starter_annual carries API_STARTER_FEATURES (planLimits: 1000/day), so it
    // IS scanner-reachable. Its self-serve portal upgrade path to Business is
    // unverified, so the CTA must be contact_support (never a billing_portal
    // dead-end), matching the Settings button that renders only for 'api_starter'.
    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, {
      now: NOW,
      rows: [{
        userId: "user-annual",
        dimension: "api_daily_requests",
        usage: 1_200,
        source: "test",
      }],
    });

    expect(summary.notified).toBe(1);
    const notices = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      planKey: "api_starter_annual",
      state: "over_limit",
      ctaKind: "contact_support",
      blockedReason: "api_business_not_self_serve",
      upgradeTargetPlanKey: "api_business",
    });
  });

  test("does not emit MCP minute notices without durable limiter-hit buckets", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");

    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, {
      now: NOW,
      rows: [{
        userId: "user-pro",
        dimension: "mcp_minute_burst",
        usage: 75,
        source: "test",
      }],
    });

    expect(summary).toMatchObject({
      evaluated: 1,
      wouldNotify: 0,
      notified: 0,
    });
    const notices = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(notices).toHaveLength(0);
  });

  test("emits MCP minute notices from durable limiter-hit buckets", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");

    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, {
      now: NOW,
      rows: [{
        userId: "user-pro",
        dimension: "mcp_minute_burst",
        usage: 90,
        minuteBuckets: [61, 62, 10, 65, 20],
        source: "axiom:mcp_rate_limit_hit",
      }],
    });

    expect(summary).toMatchObject({
      evaluated: 1,
      wouldNotify: 1,
      notified: 1,
    });
    const notices = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      dimension: "mcp_minute_burst",
      state: "sustained_burst",
      ctaKind: "checkout",
      upgradeTargetPlanKey: "api_starter",
    });
  });

  test("recovers a lingering burst notice once the burst stops", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");

    // Trip a sustained burst so a current notice exists.
    await t.action(usageFns.scanApiPlanLimitUsageInternal, {
      now: NOW,
      rows: [{
        userId: "user-pro",
        dimension: "mcp_minute_burst",
        usage: 90,
        minuteBuckets: [61, 62, 63, 65, 66],
        source: "axiom:mcp_rate_limit_hit",
      }],
    });
    let notices = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(notices.filter((notice) => notice.current)).toHaveLength(1);

    // Next scan: the burst is gone so no row is produced for this user. The
    // stale-notice sweep must clear the lingering current notice; the per-row
    // recovery path never would (there is no row to recover from).
    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, {
      now: NOW + 3_600_000,
      rows: [],
    });
    expect(summary.recovered).toBe(1);
    notices = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(notices.filter((notice) => notice.current)).toHaveLength(0);
  });

  test("a continuing burst reuses one notice across hourly scans and holds the 6h email cadence", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");
    const noticeFns = (internal as any).apiPlanLimitNotices;

    const burstRow = {
      userId: "user-pro",
      dimension: "mcp_minute_burst",
      usage: 90,
      minuteBuckets: [61, 62, 63, 65, 66],
      source: "axiom:mcp_rate_limit_hit",
    };

    // Scan 1: burst tripped -> one pending sustained_burst notice.
    await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW, rows: [burstRow] });
    let notices = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(notices).toHaveLength(1);
    const noticeId = notices[0]._id;

    // Simulate the email-delivery cron sending it.
    await t.mutation(noticeFns.markEmailStatus, { noticeId, emailStatus: "sent", emailedAt: NOW });

    // Scan 2, one hour later, burst still active. The scanner runs HOURLY, so a
    // minute-grained notice window would mint a fresh pending notice every scan
    // (bypassing the 6h cadence + losing dismiss/attempt state). The notice must
    // instead REUSE the same document so lastEmailedAt/emailStatus carry forward.
    await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW + 3_600_000, rows: [burstRow] });

    notices = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(notices).toHaveLength(1); // reused, not re-minted
    expect(String(notices[0]._id)).toBe(String(noticeId));
    expect(notices[0].current).toBe(true);
    expect(notices[0].emailStatus).toBe("sent"); // not flipped back to pending
    expect(notices[0].lastEmailedAt).toBe(NOW); // preserved

    // Cadence: not due again within BURST_EMAIL_CADENCE_MS (6h).
    const due = await t.query(noticeFns.listEmailDue, { now: NOW + 3_600_000 });
    expect(due.map((n: { _id: unknown }) => String(n._id))).not.toContain(String(noticeId));

    // Audit granularity preserved: rollups keep the minute-grained windowKey
    // while the notice carries only the coarse (day) dedupe key.
    const rollups = await t.run((ctx) => ctx.db.query("apiUsageRollups").collect());
    expect(rollups.some((r) => r.windowKey.includes("T"))).toBe(true);
    expect(notices[0].windowKey).not.toContain("T");
  });

  test("a dismissed burst notice stays dismissed across an hourly rescan", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");

    const burstRow = {
      userId: "user-pro",
      dimension: "mcp_minute_burst",
      usage: 90,
      minuteBuckets: [61, 62, 63, 65, 66],
      source: "axiom:mcp_rate_limit_hit",
    };

    await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW, rows: [burstRow] });
    const before = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(before).toHaveLength(1);
    // Simulate the user dismissing it (acknowledgeNotice sets acknowledgedAt).
    await t.run((ctx) => ctx.db.patch(before[0]._id, { acknowledgedAt: NOW }));

    // Burst continues; the hourly rescan must NOT resurrect the dismissed notice.
    await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW + 3_600_000, rows: [burstRow] });
    const after = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(after).toHaveLength(1);
    expect(after[0].acknowledgedAt).toBe(NOW); // dismiss survived
  });

  test("per-row recovery clears a daily notice when usage drops below the recovery floor", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-api", "api_starter");

    // Over the 1000/day Starter limit -> a current over_limit notice.
    await t.action(usageFns.scanApiPlanLimitUsageInternal, {
      now: NOW,
      rows: [{ userId: "user-api", dimension: "api_daily_requests", usage: 1_200, source: "test" }],
    });
    let notices = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(notices.filter((n) => n.current)).toHaveLength(1);

    // Next scan: usage falls below the 0.5x recovery floor (200/1000 = 0.2) while
    // the user STILL produces a row -> the PER-ROW recovery path (shouldRecoverNotice
    // -> clearRecoveredCurrentNotices) clears it. This is distinct from the
    // stale-notice sweep (which fires only when the user produces no row at all).
    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, {
      now: NOW + 3_600_000,
      rows: [{ userId: "user-api", dimension: "api_daily_requests", usage: 200, source: "test" }],
    });
    expect(summary.recovered).toBe(1);
    notices = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(notices.filter((n) => n.current)).toHaveLength(0);
  });

  test("bounded-concurrency reads attribute each user's meter to their own notice", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-a", "api_starter");
    await seedEntitlement(t, "user-b", "api_starter");
    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://upstash.test");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "upstash-token");
    // Two concurrent meter reads in one batch, distinct values keyed by userId.
    // A misattribution bug (result paired to the wrong `read`) would blame the
    // wrong customer -- assert the over_limit user carries their OWN usage and
    // the below-threshold user is not flagged (and writes no rollup).
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("api.axiom.co")) return new Response(JSON.stringify({ matches: [] }), { status: 200 });
      if (u.includes("user-a")) return new Response(JSON.stringify({ result: "400" }), { status: 200 });
      if (u.includes("user-b")) return new Response(JSON.stringify({ result: "1500" }), { status: 200 });
      return new Response(JSON.stringify({ result: "0" }), { status: 200 });
    }));

    await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW });

    // user-b (1500 > 1000) is flagged over_limit carrying its OWN 1500; user-a
    // (400, below the 800 warning floor) is not flagged and writes no rollup.
    // A swap would flag user-a and drop user-b's notice to 400 (never over).
    const dailyCurrent = (await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect()))
      .filter((n) => n.current && n.dimension === "api_daily_requests");
    expect(dailyCurrent.map((n) => n.userId)).toEqual(["user-b"]);
    expect(dailyCurrent[0]).toMatchObject({ state: "over_limit", usage: 1_500 });
  });

  test("dead-zone refresh then recovery: over -> dead zone -> recovered clears the notice", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-api", "api_starter");
    const scan = (usage: number, at: number) =>
      t.action(usageFns.scanApiPlanLimitUsageInternal, {
        now: at,
        rows: [{ userId: "user-api", dimension: "api_daily_requests", usage, source: "test" }],
      });

    await scan(1_200, NOW); // over_limit -> current notice
    await scan(700, NOW + 3_600_000); // dead zone (0.7): U4 refresh, notice stays current
    const live = (await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).filter((n) => n.current);
    expect(live).toHaveLength(1);
    expect(live[0].lastSeenAt).toBe(NOW + 3_600_000); // refreshed
    expect(live[0].usage).toBe(700);

    const summary = await scan(300, NOW + 7_200_000); // 0.3 < 0.5 -> per-row recovery
    expect(summary.recovered).toBe(1);
    const stillCurrent = (await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).filter((n) => n.current);
    expect(stillCurrent).toHaveLength(0);
  });

  test("does not notify a Pro (no apiAccess) account on an api_* dimension", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");

    // Pro has apiAccess:false and apiBurstRequestsPerMinute:0. Its ordinary
    // Clerk-session dashboard traffic can still surface as an api_minute_burst
    // row keyed by the user (via the Axiom customer_id read). Without the
    // apiAccess gate, limit=0 would classify five active minutes as a phantom
    // sustained_burst and fire an "over API plan limit" upsell email.
    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, {
      now: NOW,
      rows: [{
        userId: "user-pro",
        dimension: "api_minute_burst",
        usage: 500,
        minuteBuckets: [500, 500, 500, 500, 500],
        source: "test",
      }],
    });

    expect(summary.evaluated).toBe(0);
    expect(summary.wouldNotify).toBe(0);
    expect(summary.notified).toBe(0);
    expect(summary.skipped).toContainEqual({
      userId: "user-pro",
      dimension: "api_minute_burst",
      reason: "no_api_access",
    });
    const notices = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(notices).toHaveLength(0);
  });

  test("an HTTP-200 Axiom error body blocks api burst recovery", async () => {
    const t = convexTest(schema, modules);
    await seedCurrentApiBurstNotice(t);
    expect((await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).filter((n) => n.current)).toHaveLength(1);

    // Scan 2 (production path): Axiom answers HTTP 200 but with a non-result body
    // (an error object, no matches/tables/rows array). normalizeAxiomRows would
    // yield [] -- indistinguishable from a genuinely empty result -- so without
    // the shape guard the recovery sweep reads api_minute_burst as healthy-empty
    // and clears the live notice. It must degrade to a blocked source instead.
    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ ...EMPTY_AXIOM_LEGACY_RESULT, error: "query failed", code: "bad_apl" }), { status: 200 }),
    ));
    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW + 3_600_000 });

    expect(summary.blocked).toContainEqual({ dimension: "api_minute_burst", reason: "axiom_unexpected_body" });
    expect((await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).filter((n) => n.current)).toHaveLength(1);
  });

  test.each(["error", "fatal"])("an Axiom %s status message preserves an active burst notice", async (priority) => {
    const t = convexTest(schema, modules);
    await seedCurrentApiBurstNotice(t);
    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...EMPTY_AXIOM_LEGACY_RESULT,
      status: {
        ...EMPTY_AXIOM_LEGACY_RESULT.status,
        messages: [{ priority: "info", count: 1, msg: "Query started" }, { priority, count: 1, msg: "Query failed" }],
      },
    }), { status: 200 })));

    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW + 60_000 });

    expect(summary.recovered).toBe(0);
    expect(summary.blocked).toContainEqual({ dimension: "api_minute_burst", reason: "axiom_unexpected_body" });
    expect((await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).filter((n) => n.current)).toHaveLength(1);
  });

  test.each(["info", "warn"])("an Axiom %s status message allows valid empty-result recovery", async (priority) => {
    const t = convexTest(schema, modules);
    await seedCurrentApiBurstNotice(t);
    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...EMPTY_AXIOM_LEGACY_RESULT,
      status: {
        ...EMPTY_AXIOM_LEGACY_RESULT.status,
        messages: [{ priority, count: 1, msg: "Query diagnostic" }],
      },
    }), { status: 200 })));

    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW + 60_000 });

    expect(summary.recovered).toBe(1);
    expect(summary.blocked.filter((b: { dimension?: string }) => b.dimension === "api_minute_burst")).toEqual([]);
    expect((await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).filter((n) => n.current)).toHaveLength(0);
  });

  test("an empty {matches: []} Axiom result recovers an idle burst notice", async () => {
    const t = convexTest(schema, modules);
    await seedCurrentApiBurstNotice(t);
    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    // Every Axiom query returns the canonical empty envelope. The common no-burst
    // scan must read as empty, never axiom_unexpected_body — otherwise the sweep
    // would freeze every open burst notice.
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      if (String(url).includes("api.axiom.co")) return new Response(JSON.stringify({ matches: [] }), { status: 200 });
      return new Response(JSON.stringify({ result: "0" }), { status: 200 });
    }));
    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW + 3_600_000 });
    expect(summary.blocked.some((b: { reason?: string }) => b.reason === "axiom_unexpected_body")).toBe(false);
    expect(summary.recovered).toBe(1);
    expect((await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).filter((n) => n.current)).toHaveLength(0);
  });

  test.each([
    { label: "without buckets", body: EMPTY_AXIOM_LEGACY_RESULT },
    { label: "with empty buckets", body: { ...EMPTY_AXIOM_LEGACY_RESULT, buckets: {} } },
    { label: "with empty tables and buckets", body: { ...EMPTY_AXIOM_LEGACY_RESULT, tables: [], buckets: {} } },
  ])("a complete zero-row Axiom result $label recovers an idle burst notice", async ({ body }) => {
    const t = convexTest(schema, modules);
    await seedCurrentApiBurstNotice(t);

    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW + 3_600_000 });

    expect(summary.recovered).toBe(1);
    expect(summary.blocked).not.toContainEqual({ dimension: "api_minute_burst", reason: "axiom_unexpected_body" });
    expect((await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).filter((n) => n.current)).toHaveLength(0);
  });

  test.each(["totals", "series"] as const)("legacy aggregate %s detect and recover a sustained API burst", async (layout) => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-starter", "api_starter");
    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    let body = axiomBurstResult([61, 62, 63, 65, 66], layout);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));

    const detected = await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW });

    expect(detected.blocked.filter((b: { dimension?: string }) => b.dimension === "api_minute_burst")).toEqual([]);
    expect(detected.notified).toBe(1);
    expect((await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).filter((n) => n.current))
      .toMatchObject([{ userId: "user-starter", dimension: "api_minute_burst", state: "sustained_burst", usage: 66 }]);

    body = axiomBurstResult([10, 11, 12, 13, 14], layout);
    const recovered = await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW + 60_000 });

    expect(recovered.recovered).toBe(1);
    expect((await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).filter((n) => n.current)).toHaveLength(0);
  });

  test("legacy aggregate minute groups are evaluated in time order", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-starter", "api_starter");
    const body = axiomBurstResult([90, 90, 90, 90, 90, 10, 10, 10, 10, 10], "totals");
    body.buckets.totals.reverse();
    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));

    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW });

    expect(summary.evaluated).toBe(1);
    expect(summary.notified).toBe(0);
    expect((await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).filter((n) => n.current)).toHaveLength(0);
  });

  test.each(["totals", "series"] as const)("sparse legacy %s use the current five completed minutes", async (layout) => {
    const t = convexTest(schema, modules);
    await seedCurrentApiBurstNotice(t);
    const body = axiomBurstResult([90, 90, 90, 10], layout, [9, 8, 7, 1]);
    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));

    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW });

    expect(summary.notified).toBe(0);
    expect(summary.recovered).toBe(1);
    expect(await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect()))
      .toMatchObject([{ usage: 10, current: false }]);
  });

  test.each(["missing user", "different count"])("legacy series contradicting totals (%s) preserve notices", async (mismatch) => {
    const t = convexTest(schema, modules);
    await seedCurrentApiBurstNotice(t);
    const complete = axiomBurstResult([90, 90, 90, 90, 90], "series");
    const extra = { id: 5, group: { customer_id: "other-user" }, aggregations: [{ op: "count", value: 10 }] };
    const body = {
      ...complete,
      status: { ...complete.status, rowsMatched: mismatch === "missing user" ? 460 : 450 },
      buckets: {
        totals: mismatch === "missing user" ? [...complete.buckets.totals, extra] : complete.buckets.totals,
        series: [{
          startTime: new Date(NOW - 60_000).toISOString(), endTime: new Date(NOW).toISOString(),
          groups: [{ ...extra, group: { customer_id: mismatch === "missing user" ? "other-user" : "user-starter" } }],
        }],
      },
    };
    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));

    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW });

    expect(summary.recovered).toBe(0);
    expect(summary.blocked).toContainEqual({ dimension: "api_minute_burst", reason: "axiom_unexpected_body" });
    expect((await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).filter((n) => n.current)).toHaveLength(1);
  });

  test.each(["totals", "series without totals", "both"])("truncated legacy %s block recovery using matched-row metadata", async (layout) => {
    const t = convexTest(schema, modules);
    await seedCurrentApiBurstNotice(t);
    const short = axiomBurstResult([10], layout === "totals" ? "totals" : "series");
    const body = {
      ...short,
      status: axiomBurstResult([90, 90, 90, 90, 90], "totals").status,
      buckets: layout === "series without totals" ? { series: short.buckets.series } : short.buckets,
    };
    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));

    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW });

    expect(summary.recovered).toBe(0);
    expect(summary.blocked).toContainEqual({ dimension: "api_minute_burst", reason: "axiom_unexpected_body" });
    expect((await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).filter((n) => n.current)).toHaveLength(1);
  });

  test.each([
    { label: "empty bucket object without legacy metadata", body: { status: { isPartial: false, rowsMatched: 0, numGroups: 0 }, buckets: {} } },
    { label: "empty table array without legacy metadata", body: { status: { isPartial: false, rowsMatched: 0, numGroups: 0 }, tables: [], buckets: {} } },
    { label: "empty bucket object with malformed matches", body: { ...EMPTY_AXIOM_LEGACY_RESULT, matches: "invalid", buckets: {} } },
    { label: "empty bucket object with malformed rows", body: { ...EMPTY_AXIOM_LEGACY_RESULT, rows: "invalid", buckets: {} } },
    { label: "empty bucket object with malformed tables", body: { ...EMPTY_AXIOM_LEGACY_RESULT, tables: [{ rows: "invalid" }], buckets: {} } },
    { label: "empty bucket object for another dataset", body: { ...EMPTY_AXIOM_LEGACY_RESULT, datasetNames: ["other_dataset"], buckets: {} } },
    { label: "empty bucket object with invalid block metadata", body: { ...EMPTY_AXIOM_LEGACY_RESULT, status: { ...EMPTY_AXIOM_LEGACY_RESULT.status, minBlockTime: "invalid" }, buckets: {} } },
    { label: "estimated empty result", body: { ...EMPTY_AXIOM_LEGACY_RESULT, status: { ...EMPTY_AXIOM_LEGACY_RESULT.status, isEstimate: true }, buckets: { totals: [], series: [] } } },
    { label: "estimated nonempty result", body: { ...axiomBurstResult([10], "totals"), status: { ...axiomBurstResult([10], "totals").status, isEstimate: true } } },
    { label: "partial status", body: { ...axiomBurstResult([10], "totals"), status: { ...EMPTY_AXIOM_LEGACY_RESULT.status, isPartial: true } } },
    { label: "missing status", body: { buckets: axiomBurstResult([10], "totals").buckets } },
    { label: "non-array totals", body: { ...EMPTY_AXIOM_LEGACY_RESULT, buckets: { totals: {} } } },
    { label: "missing aggregation", body: { ...EMPTY_AXIOM_LEGACY_RESULT, buckets: { totals: [{ group: { customer_id: "user-starter", minute: new Date(NOW).toISOString() } }] } } },
    { label: "whole-window total without minutes", body: { ...EMPTY_AXIOM_LEGACY_RESULT, buckets: { totals: [{ group: { customer_id: "user-starter" }, aggregations: [{ op: "count", value: 10 }] }] } } },
    { label: "malformed minute count", body: { ...EMPTY_AXIOM_LEGACY_RESULT, buckets: { totals: [{ group: { customer_id: "user-starter", minute: new Date(NOW).toISOString() }, aggregations: [{ op: "count", value: "invalid" }] }] } } },
    { label: "malformed series interval", body: { ...EMPTY_AXIOM_LEGACY_RESULT, buckets: { series: [{ startTime: "invalid", groups: [] }] } } },
    { label: "multi-minute series without a minute group", body: { ...EMPTY_AXIOM_LEGACY_RESULT, buckets: { series: [{ startTime: new Date(NOW).toISOString(), endTime: new Date(NOW + 5 * 60_000).toISOString(), groups: [{ group: { customer_id: "user-starter" }, aggregations: [{ op: "count", value: 10 }] }] }] } } },
    { label: "empty groups contradict matched rows", body: { ...axiomBurstResult([10], "totals"), buckets: { series: [], totals: [] } } },
  ])("legacy aggregate $label preserves an existing notice", async ({ body }) => {
    const t = convexTest(schema, modules);
    await seedCurrentApiBurstNotice(t);
    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));

    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW + 60_000 });

    expect(summary.recovered).toBe(0);
    expect(summary.blocked).toContainEqual({ dimension: "api_minute_burst", reason: "axiom_unexpected_body" });
    expect((await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).filter((n) => n.current)).toHaveLength(1);
  });

  test.each([
    { label: "matches", fields: { matches: "invalid" } },
    { label: "null matches", fields: { matches: null } },
    { label: "rows", fields: { rows: "invalid" } },
    { label: "null rows", fields: { rows: null } },
    { label: "tables", fields: { tables: "invalid" } },
    { label: "null tables", fields: { tables: null } },
    { label: "table rows", fields: { tables: [{ rows: "invalid" }] } },
    { label: "table record", fields: { tables: [null] } },
    { label: "missing table rows", fields: { tables: [{}] } },
    { label: "later table rows", fields: { tables: [{ rows: [] }, { rows: "invalid" }] } },
    { label: "rows alongside valid empty matches", fields: { matches: [], rows: "invalid" } },
    { label: "invalid rows hidden by empty matches", fields: { matches: [], rows: [null] } },
    { label: "invalid row objects hidden by empty matches", fields: { matches: [], rows: [{}] } },
    { label: "invalid table rows hidden by empty matches", fields: { matches: [], tables: [{ rows: [null] }] } },
    { label: "invalid rows in a later table", fields: { tables: [{ rows: [] }, { rows: [null] }] } },
    { label: "invalid later table after valid usage", fields: { tables: [{ rows: [AXIOM_LOW_USAGE_ROW] }, { rows: [null] }], status: { ...EMPTY_AXIOM_LEGACY_RESULT.status, rowsMatched: 10, numGroups: 1 } } },
    { label: "invalid rows alongside valid matches", fields: { matches: [{ data: AXIOM_LOW_USAGE_ROW }], rows: [null], status: { ...EMPTY_AXIOM_LEGACY_RESULT.status, rowsMatched: 10, numGroups: 1 } } },
    { label: "conflicting populated row layouts", fields: { matches: [{ data: AXIOM_LOW_USAGE_ROW }], rows: [{ ...AXIOM_LOW_USAGE_ROW, usage: 11 }], status: { ...EMPTY_AXIOM_LEGACY_RESULT.status, rowsMatched: 10, numGroups: 1 } } },
    { label: "same totals for different users", fields: { matches: [{ data: AXIOM_LOW_USAGE_ROW }], rows: [{ ...AXIOM_LOW_USAGE_ROW, customer_id: "other-user" }], status: { ...EMPTY_AXIOM_LEGACY_RESULT.status, rowsMatched: 10, numGroups: 1 } } },
    { label: "same totals for different minutes", fields: { matches: [{ data: AXIOM_LOW_USAGE_ROW }], rows: [{ ...AXIOM_LOW_USAGE_ROW, minute: new Date(NOW - 120_000).toISOString() }], status: { ...EMPTY_AXIOM_LEGACY_RESULT.status, rowsMatched: 10, numGroups: 1 } } },
  ].flatMap(({ label, fields }) => [
    { label: `${label} with empty totals`, fields, buckets: { totals: [] } },
    { label: `${label} with empty series`, fields, buckets: { series: [] } },
    { label: `${label} with both empty aggregates`, fields, buckets: { totals: [], series: [] } },
  ]))("malformed $label preserves an existing notice", async ({ fields, buckets }) => {
    const t = convexTest(schema, modules);
    await seedCurrentApiBurstNotice(t);
    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...EMPTY_AXIOM_LEGACY_RESULT, ...fields, buckets,
    }), { status: 200 })));

    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW + 60_000 });

    expect(summary.recovered).toBe(0);
    expect(summary.blocked).toContainEqual({ dimension: "api_minute_burst", reason: "axiom_unexpected_body" });
    expect((await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).filter((n) => n.current)).toHaveLength(1);
  });

  test.each([
    { label: "rows after empty matches", fields: { matches: [], rows: [AXIOM_LOW_USAGE_ROW] } },
    { label: "rows in a later table", fields: { tables: [{ rows: [] }, { rows: [AXIOM_LOW_USAGE_ROW] }] } },
    { label: "matching populated layouts", fields: { matches: [{ data: AXIOM_LOW_USAGE_ROW }], rows: [AXIOM_LOW_USAGE_ROW], tables: [{ rows: [AXIOM_LOW_USAGE_ROW] }] } },
  ])("valid $label recover an idle burst notice", async ({ fields }) => {
    const t = convexTest(schema, modules);
    await seedCurrentApiBurstNotice(t);
    const aggregate = axiomBurstResult([10], "totals");
    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...aggregate, ...fields,
    }), { status: 200 })));

    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW });

    expect(summary.recovered).toBe(1);
    expect(summary.blocked.filter((b: { dimension?: string }) => b.dimension === "api_minute_burst")).toEqual([]);
    expect((await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).filter((n) => n.current)).toHaveLength(0);
  });

  test("matching populated representations may use different row orders", async () => {
    const t = convexTest(schema, modules);
    await seedCurrentApiBurstNotice(t);
    const usages = [10, 11, 12, 13, 14];
    const rows = usages.map((usage, index) => ({
      ...AXIOM_LOW_USAGE_ROW,
      minute: new Date(NOW - (usages.length - index) * 60_000).toISOString(),
      usage,
    }));
    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...axiomBurstResult(usages, "totals"),
      matches: rows.map((data) => ({ data })),
      rows: [...rows].reverse(),
      tables: [{ rows }],
    }), { status: 200 })));

    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW });

    expect(summary.evaluated).toBe(1);
    expect(summary.recovered).toBe(1);
    expect(summary.blocked.filter((b: { dimension?: string }) => b.dimension === "api_minute_burst")).toEqual([]);
    expect((await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).filter((n) => n.current)).toHaveLength(0);
  });

  test.each([
    { label: "bucket object", buckets: null },
    { label: "aggregate array", buckets: { totals: null } },
    { label: "aggregate row", buckets: { totals: [null] } },
  ])("valid rows cannot hide a malformed $label", async ({ buckets }) => {
    const t = convexTest(schema, modules);
    await seedCurrentApiBurstNotice(t);
    const aggregate = axiomBurstResult([10], "totals");
    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...aggregate, rows: [AXIOM_LOW_USAGE_ROW], buckets,
    }), { status: 200 })));

    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW });

    expect(summary.recovered).toBe(0);
    expect(summary.blocked).toContainEqual({ dimension: "api_minute_burst", reason: "axiom_unexpected_body" });
    expect((await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).filter((n) => n.current)).toHaveLength(1);
  });

  test.each([
    { label: "matches", fields: { matches: [] } },
    { label: "rows", fields: { rows: [] } },
    { label: "table rows", fields: { tables: [{ rows: [] }] } },
    { label: "tables", fields: { tables: [] } },
  ])("valid empty $label alongside aggregates recovers an idle burst notice", async ({ fields }) => {
    const t = convexTest(schema, modules);
    await seedCurrentApiBurstNotice(t);
    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...EMPTY_AXIOM_LEGACY_RESULT, ...fields, buckets: { totals: [], series: [] },
    }), { status: 200 })));

    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW + 60_000 });

    expect(summary.recovered).toBe(1);
    expect(summary.blocked.filter((b: { dimension?: string }) => b.dimension === "api_minute_burst")).toEqual([]);
    expect((await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).filter((n) => n.current)).toHaveLength(0);
  });

  test.each([
    { label: "totals", buckets: { totals: [] } },
    { label: "series", buckets: { series: [] } },
    { label: "totals and series", buckets: { totals: [], series: [] } },
  ])("an empty legacy aggregate result with $label recovers an idle burst notice", async ({ buckets }) => {
    const t = convexTest(schema, modules);
    await seedCurrentApiBurstNotice(t);
    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...EMPTY_AXIOM_LEGACY_RESULT, buckets,
    }), { status: 200 })));

    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW + 60_000 });

    expect(summary.recovered).toBe(1);
    expect(summary.blocked.filter((b: { dimension?: string }) => b.dimension === "api_minute_burst")).toEqual([]);
  });

  test.each([
    {
      label: "missing required status fields",
      body: { format: "legacy", datasetNames: ["wm_api_usage"], status: { rowsMatched: 0, isPartial: false } },
    },
    {
      label: "nonzero group count",
      body: { ...EMPTY_AXIOM_LEGACY_RESULT, status: { ...EMPTY_AXIOM_LEGACY_RESULT.status, numGroups: 1 } },
    },
    {
      label: "invalid block timestamp",
      body: { ...EMPTY_AXIOM_LEGACY_RESULT, status: { ...EMPTY_AXIOM_LEGACY_RESULT.status, minBlockTime: "garbage" } },
    },
    {
      label: "impossible block date",
      body: { ...EMPTY_AXIOM_LEGACY_RESULT, status: { ...EMPTY_AXIOM_LEGACY_RESULT.status, maxBlockTime: "2026-02-30T00:00:00Z" } },
    },
    {
      label: "non-array matches in a zero-row result",
      body: { ...EMPTY_AXIOM_LEGACY_RESULT, matches: "invalid" },
    },
    {
      label: "missing usage in a match",
      body: { matches: [{ data: { user_id: "user-starter" } }] },
    },
    {
      label: "missing user ID in a match",
      body: { matches: [{ data: { usage: 90 } }] },
    },
    {
      label: "non-boolean partial status with matches",
      body: { matches: [], status: { isPartial: "true" } },
    },
    {
      label: "non-object status with matches",
      body: { matches: [], status: [] },
    },
    {
      label: "non-string error message with matches",
      body: { matches: [], message: { error: "query failed" } },
    },
    {
      label: "empty matches contradict a nonzero group count",
      body: { matches: [], status: { isPartial: false, numGroups: 1, rowsMatched: 100 } },
    },
  ])("a malformed Axiom result ($label) preserves a burst notice", async ({ body }) => {
    const t = convexTest(schema, modules);
    await seedCurrentApiBurstNotice(t);

    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW + 3_600_000 });

    expect(summary.recovered).toBe(0);
    expect(summary.blocked).toContainEqual({ dimension: "api_minute_burst", reason: "axiom_unexpected_body" });
    expect((await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).filter((n) => n.current)).toHaveLength(1);
  });

  test("a partial Axiom result with empty matches does not recover a burst notice", async () => {
    const t = convexTest(schema, modules);
    await seedCurrentApiBurstNotice(t);

    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...EMPTY_AXIOM_LEGACY_RESULT,
      status: { ...EMPTY_AXIOM_LEGACY_RESULT.status, isPartial: true },
      matches: [],
    }), { status: 200 })));
    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW + 3_600_000 });

    expect(summary.recovered).toBe(0);
    expect(summary.blocked).toContainEqual({ dimension: "api_minute_burst", reason: "axiom_unexpected_body" });
    expect((await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).filter((n) => n.current)).toHaveLength(1);
  });

  test("an unrecognized error-free Axiom body blocks and preserves an api burst notice", async () => {
    const t = convexTest(schema, modules);
    await seedCurrentApiBurstNotice(t);
    expect((await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).filter((n) => n.current)).toHaveLength(1);

    // An unknown HTTP-200 shape has no trustworthy rows, even without an error
    // field. Treating it as empty would false-clear this live notice.
    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: { rowsMatched: 0 } }), { status: 200 })));
    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW + 3_600_000 });

    expect(summary.recovered).toBe(0);
    expect((await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).filter((n) => n.current)).toHaveLength(1);
    expect(summary.blocked).toContainEqual({ dimension: "api_minute_burst", reason: "axiom_unexpected_body" });
  });

  test("burst detection counts rate-limit rejections so it survives enforce mode", async () => {
    const t = convexTest(schema, modules);
    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    let burstApl = "";
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.axiom.co")) {
        const apl = JSON.parse(String(init?.body)).apl as string;
        // The api burst query is the one keyed by customer_id + minute buckets.
        if (apl.includes("customer_id") && apl.includes("bin(_time, 1m)")) burstApl = apl;
        return new Response(JSON.stringify({ matches: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: "0" }), { status: 200 });
    }));
    await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW });
    // Both shadow and enforce evidence are counted, so detection doesn't blind
    // itself once API_RATE_LIMIT_ENFORCE flips over-limit requests to 429s.
    expect(burstApl).toContain("rl_min_429");
    expect(burstApl).toContain("rl_min_shadow");
  });

  test("mcp_daily_calls for a Pro account uses the Redis counter, dropping the dual Axiom row", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");
    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://upstash.test");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "upstash-token");

    // The Axiom mcp.toolcall count reads 80 (it also tallies quota-exempt calls);
    // the authoritative enforcement Redis counter reads 60. Both exceed the 50/day
    // Pro cap, but only ONE mcp_daily row must be evaluated and it must carry the
    // Redis 60, not the Axiom 80 -- the dual row otherwise flaps the notice.
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.axiom.co")) {
        const apl = JSON.parse(String(init?.body)).apl as string;
        if (apl.includes("mcp.toolcall")) {
          return new Response(JSON.stringify({ matches: [{ data: { user_id: "user-pro", usage: 80 } }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ matches: [] }), { status: 200 });
      }
      if (u.includes("mcp%3Apro-usage")) return new Response(JSON.stringify({ result: "60" }), { status: 200 });
      return new Response(JSON.stringify({ result: "0" }), { status: 200 });
    }));

    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW });

    // Exactly one mcp_daily row -> the Axiom duplicate was dropped for the Pro user.
    expect(summary.evaluated).toBe(1);
    const mcp = (await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect()))
      .filter((n) => n.dimension === "mcp_daily_calls" && n.current);
    expect(mcp).toHaveLength(1);
    expect(mcp[0].state).toBe("over_limit");
    expect(mcp[0].usage).toBe(60); // Redis counter, not the Axiom 80
  });

  test("mcp_daily_calls for a Pro Business account also uses the Redis counter, not the Axiom row", async () => {
    // Same single-source invariant as the Pro case above. Pro Business is
    // metered by the SAME `mcp:pro-usage` counter (it rides the pro context in
    // api/mcp/dispatch.ts), so leaving it out of the isPro set would dual-source
    // its usage and flap the notice within one scan.
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro-business", "pro_business_monthly");
    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://upstash.test");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "upstash-token");

    // Axiom reads 400 (it also tallies quota-exempt calls); the authoritative
    // Redis counter reads 300. Both exceed the 250/day Pro Business cap, so the
    // usage value on the single notice is what identifies the winning source.
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.axiom.co")) {
        const apl = JSON.parse(String(init?.body)).apl as string;
        if (apl.includes("mcp.toolcall")) {
          return new Response(JSON.stringify({ matches: [{ data: { user_id: "user-pro-business", usage: 400 } }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ matches: [] }), { status: 200 });
      }
      if (u.includes("mcp%3Apro-usage")) return new Response(JSON.stringify({ result: "300" }), { status: 200 });
      return new Response(JSON.stringify({ result: "0" }), { status: 200 });
    }));

    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW });

    expect(summary.evaluated).toBe(1);
    const mcp = (await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect()))
      .filter((n) => n.dimension === "mcp_daily_calls" && n.current);
    expect(mcp).toHaveLength(1);
    expect(mcp[0].state).toBe("over_limit");
    expect(mcp[0].usage).toBe(300); // Redis counter, not the Axiom 400
    expect(mcp[0].limit).toBe(250); // the Pro Business allowance, not Pro's 50
  });

  test("a capped Pro Business account is offered API Starter, not a dead-end notice", async () => {
    // AE6 tail: without a dodoUpgradeNotice branch, pro_business falls through
    // to `{ctaKind: 'none'}` — the user is told they hit the cap with no way out.
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro-business", "pro_business_monthly");

    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, {
      now: NOW,
      rows: [{
        userId: "user-pro-business",
        dimension: "mcp_daily_calls",
        usage: 300,
        source: "test",
      }],
    });

    expect(summary.notified).toBe(1);
    const notices = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      planKey: "pro_business_monthly",
      dimension: "mcp_daily_calls",
      state: "over_limit",
      ctaKind: "checkout",
      upgradeTargetPlanKey: "api_starter",
    });
  });

  test("the annual Pro Business plan gets the same API Starter CTA as monthly", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro-business-annual", "pro_business_annual");

    await t.action(usageFns.scanApiPlanLimitUsageInternal, {
      now: NOW,
      rows: [{
        userId: "user-pro-business-annual",
        dimension: "mcp_daily_calls",
        usage: 300,
        source: "test",
      }],
    });

    const notices = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      planKey: "pro_business_annual",
      ctaKind: "checkout",
      upgradeTargetPlanKey: "api_starter",
    });
  });

  test("clears a stale api_* notice for a non-apiAccess account instead of wedging it", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");
    // A pre-existing current api_minute_burst notice — e.g. minted before the
    // no_api_access gate existed, or left behind after an api_starter→pro
    // downgrade. Insert it directly.
    await t.run(async (ctx) => {
      await ctx.db.insert("apiPlanLimitNotices", {
        userId: "user-pro",
        planKey: "api_starter",
        dimension: "api_minute_burst",
        state: "sustained_burst",
        windowKey: "2020-01-01",
        usage: 100,
        limit: 60,
        usageRatio: null,
        current: true,
        firstSeenAt: NOW - 86_400_000,
        lastSeenAt: NOW - 86_400_000,
        emailStatus: "sent",
        ctaKind: "checkout",
      });
    });

    // A source row for this non-apiAccess user is gated (no_api_access) and NOT
    // evaluated, so the recovery sweep must still process the pair and clear the
    // stale notice — not treat the gated row as "handled" and wedge it forever.
    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, {
      now: NOW,
      rows: [{
        userId: "user-pro",
        dimension: "api_minute_burst",
        usage: 500,
        minuteBuckets: [500, 500, 500, 500, 500],
        source: "test",
      }],
    });

    expect(summary.skipped).toContainEqual({
      userId: "user-pro",
      dimension: "api_minute_burst",
      reason: "no_api_access",
    });
    expect(summary.recovered).toBe(1);
    const current = (await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect()))
      .filter((n) => n.current);
    expect(current).toHaveLength(0);
  });

  test("skips rows that cannot be joined to an active entitlement", async () => {
    const t = convexTest(schema, modules);

    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, {
      now: NOW,
      rows: [{
        userId: "unknown-user",
        dimension: "api_daily_requests",
        usage: 2_000,
        source: "test",
      }],
    });

    expect(summary.skipped).toContainEqual({
      userId: "unknown-user",
      dimension: "api_daily_requests",
      reason: "unknown_or_inactive_entitlement",
    });
  });
});
