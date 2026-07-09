import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import { getFeaturesForPlan } from "../lib/entitlements";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");
const usageFns = (internal as any).apiPlanLimitUsage;

const NOW = 1_800_000_000_000;
const FUTURE = NOW + 30 * 86_400_000;

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

  test("an HTTP-200 Axiom body with no result envelope blocks the dimension, not false-clears", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");

    // Scan 1 (injected): trip a sustained mcp burst so a live notice exists.
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
    expect((await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).filter((n) => n.current)).toHaveLength(1);

    // Scan 2 (production path): Axiom answers HTTP 200 but with a non-result body
    // (an error object, no matches/tables/rows array). normalizeAxiomRows would
    // yield [] -- indistinguishable from a genuinely empty result -- so without
    // the shape guard the recovery sweep reads mcp_minute_burst as healthy-empty
    // and clears the live notice. It must degrade to a blocked source instead.
    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "query failed", code: "bad_apl" }), { status: 200 }),
    ));
    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW + 3_600_000 });

    expect(summary.blocked.some((b: { reason?: string }) => b.reason === "axiom_unexpected_body")).toBe(true);
    expect((await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).filter((n) => n.current)).toHaveLength(1);
  });

  test("an empty {matches: []} Axiom result does not block the dimension", async () => {
    const t = convexTest(schema, modules);
    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    // Every Axiom query returns the canonical empty envelope. The common no-burst
    // scan must read as empty, never axiom_unexpected_body — otherwise the sweep
    // would freeze every open burst notice.
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      if (String(url).includes("api.axiom.co")) return new Response(JSON.stringify({ matches: [] }), { status: 200 });
      return new Response(JSON.stringify({ result: "0" }), { status: 200 });
    }));
    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW });
    expect(summary.blocked.some((b: { reason?: string }) => b.reason === "axiom_unexpected_body")).toBe(false);
  });

  test("a non-array error-free Axiom body reads as empty and still recovers the notice", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");
    // Trip a live mcp burst notice (injected).
    await t.action(usageFns.scanApiPlanLimitUsageInternal, {
      now: NOW,
      rows: [{ userId: "user-pro", dimension: "mcp_minute_burst", usage: 90, minuteBuckets: [61, 62, 63, 65, 66], source: "axiom:mcp_rate_limit_hit" }],
    });
    expect((await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).filter((n) => n.current)).toHaveLength(1);

    // The EMPTY summarize response drifts to a shape WITHOUT the result arrays and
    // WITHOUT an error field. It must be treated as empty (not blocked) so a shape
    // drift can't freeze notices — the burst is genuinely gone, so the sweep clears it.
    vi.stubEnv("AXIOM_QUERY_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: { rowsMatched: 0 } }), { status: 200 })));
    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, { now: NOW + 3_600_000 });

    expect(summary.blocked.some((b: { reason?: string }) => b.reason === "axiom_unexpected_body")).toBe(false);
    expect((await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).filter((n) => n.current)).toHaveLength(0);
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
