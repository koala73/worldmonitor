import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import * as alertRules from "../alertRules";
import { getFeaturesForPlan } from "../lib/entitlements";

const modules = import.meta.glob("../**/*.ts");
const DAY = 86_400_000;

beforeEach(() => {
  vi.stubEnv("CONVEX_NOTIFICATION_RELAY_SECRET", "synthetic-delivery");
});
afterEach(() => vi.unstubAllEnvs());

const delivery = { headers: { Authorization: "Bearer synthetic-delivery" } };

// ~0.9 MiB per row: legacy rows written before the shape bounds existed.
const OVERSIZED_EVENT_TYPES = Array.from({ length: 7000 }, (_, i) => `${i}`.padEnd(128, "x"));

// A paid user with no digest rule used to get no brief at all, while the
// dashboard's Latest Brief panel told them "the editorial team is writing your
// brief" forever (2026-10-27: 251 active paid users, including the owner).
// /relay/brief-only-users lists the paid users the digest cron must compose a
// default brief for; it composes two byte-bounded scans (listPaidUserIds and
// listBriefRuleFlags) through briefOnlyUserIds.
describe("alertRules brief-only users", () => {
  test("both scans are internal: they read every user's entitlement / rules", () => {
    for (const name of ["listPaidUserIds", "listBriefRuleFlags"] as const) {
      const fn = alertRules[name] as unknown as { isQuery?: boolean; isInternal?: boolean; isPublic?: boolean };
      expect([name, fn.isQuery, fn.isInternal, fn.isPublic]).toEqual([name, true, true, undefined]);
    }
  });

  test("lists active paid users without a digest rule or an AI-digest opt-out", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      const ent = (userId: string, planKey: string, validUntil: number) =>
        ctx.db.insert("entitlements", { userId, planKey, features: getFeaturesForPlan(planKey), validUntil, updatedAt: now });
      const rule = (userId: string, extra: Record<string, unknown>) =>
        ctx.db.insert("alertRules", {
          userId, variant: "full", enabled: true, eventTypes: [], sensitivity: "high", channels: [], updatedAt: now, ...extra,
        });

      await ent("user_pro_no_rules", "pro_monthly", now + 30 * DAY);
      await ent("user_pro_realtime_only", "pro_annual", now + 30 * DAY);
      await rule("user_pro_realtime_only", { digestMode: "realtime" });
      await ent("user_pro_disabled_daily", "pro_monthly", now + 30 * DAY);
      await rule("user_pro_disabled_daily", { enabled: false, digestMode: "daily" });

      await ent("user_pro_with_digest", "pro_monthly", now + 30 * DAY);
      await rule("user_pro_with_digest", { digestMode: "daily" });
      await ent("user_pro_opted_out", "pro_monthly", now + 30 * DAY);
      await rule("user_pro_opted_out", { digestMode: "realtime", aiDigestEnabled: false });
      await ent("user_free", "free", now + 30 * DAY);
      await ent("user_pro_expired", "pro_monthly", now - DAY);
    });

    const res = await t.fetch("/relay/brief-only-users", delivery);
    expect(res.status).toBe(200);
    expect(((await res.json()) as string[]).sort()).toEqual([
      "user_pro_disabled_daily",
      "user_pro_no_rules",
      "user_pro_realtime_only",
    ]);
  });

  test("an AI-digest opt-out on the 8th row of an over-cap legacy account is honoured", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("entitlements", { userId: "legacy", planKey: "pro_monthly", features: getFeaturesForPlan("pro_monthly"), validUntil: now + 30 * DAY, updatedAt: now });
      for (let i = 0; i < 8; i++) {
        await ctx.db.insert("alertRules", {
          userId: "legacy", variant: `legacy-${i}`, enabled: true, eventTypes: [], sensitivity: "high", channels: [],
          digestMode: "realtime", aiDigestEnabled: i === 7 ? false : undefined, updatedAt: now + i,
        });
      }
    });
    const res = await t.fetch("/relay/brief-only-users", delivery);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("three paid accounts with seven ~900 KB rows each do not break the read (transactionLimits)", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("entitlements", { userId: "paid-no-rules", planKey: "pro_monthly", features: getFeaturesForPlan("pro_monthly"), validUntil: now + 30 * DAY, updatedAt: now });
      for (const userId of ["heavy-a", "heavy-b", "heavy-c"]) {
        await ctx.db.insert("entitlements", { userId, planKey: "pro_monthly", features: getFeaturesForPlan("pro_monthly"), validUntil: now + 30 * DAY, updatedAt: now });
      }
    });
    for (const userId of ["heavy-a", "heavy-b", "heavy-c"]) {
      for (let i = 0; i < 7; i++) {
        await t.run(async (ctx) => {
          await ctx.db.insert("alertRules", {
            userId, variant: `legacy-${i}`, enabled: i === 0, eventTypes: OVERSIZED_EVENT_TYPES, sensitivity: "high", channels: [],
            digestMode: i === 0 ? "daily" : "realtime", updatedAt: now,
          });
        });
      }
    }
    const res = await t.fetch("/relay/brief-only-users", delivery);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(["paid-no-rules"]);
    // Each flags page is byte-bounded: 21 rows of ~0.9 MiB never fit in one.
    const first = await t.query(internal.alertRules.listBriefRuleFlags, { cursor: null });
    expect(first.isDone).toBe(false);
    expect(first.page.length).toBeLessThan(21);
  }, 180_000);

  // Production has more active entitlements than one 256-row page. The
  // entitlement scan's index range is `validUntil >= now`; when every page
  // read its own Date.now(), page 2 ran a different query than the cursor
  // came from and Convex threw InvalidCursor, so the route 500ed and the
  // digest cron silently composed no default briefs (Sentry WORLDMONITOR-19Z).
  // convex-test does not bind a cursor to its query, so the contract is
  // pinned directly: the range comes from the caller's `now`, not the clock.
  test("the entitlement scan's range comes from the caller's now, not the page's clock", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("entitlements", { userId: "lapsed-mid-scan", planKey: "pro_monthly", features: getFeaturesForPlan("pro_monthly"), validUntil: now + 1_000, updatedAt: now });
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    try {
      const atScanStart = await t.query(internal.alertRules.listPaidUserIds, { cursor: null, now });
      const atClock = await t.query(internal.alertRules.listPaidUserIds, { cursor: null, now: now + 60_000 });
      expect([atScanStart.page, atClock.page]).toEqual([["lapsed-mid-scan"], []]);
    } finally {
      clock.mockRestore();
    }
  });

  test("a multi-page entitlement scan keeps one range while the clock moves between pages", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const paid = Array.from({ length: 300 }, (_, i) => `paid-${String(i).padStart(3, "0")}`);
    await t.run(async (ctx) => {
      for (const userId of paid) {
        await ctx.db.insert("entitlements", { userId, planKey: "pro_monthly", features: getFeaturesForPlan("pro_monthly"), validUntil: now + 30 * DAY, updatedAt: now });
      }
    });
    // convex-test runs `_handler`; wrapping it records the range bound each
    // page was asked for. Results alone cannot show drift here: the index is
    // ascending, so a later bound only drops rows already behind the cursor.
    const fn = alertRules.listPaidUserIds as unknown as { _handler: (ctx: unknown, args: { now: number }) => unknown };
    const pageNows: number[] = [];
    const realHandler = fn._handler;
    const handler = vi.spyOn(fn, "_handler").mockImplementation((ctx, args) => {
      pageNows.push(args.now);
      return realHandler(ctx, args);
    });
    let tick = now;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => (tick += 1_000));
    try {
      const res = await t.fetch("/relay/brief-only-users", delivery);
      expect(res.status).toBe(200);
      expect(((await res.json()) as string[]).sort()).toEqual(paid);
      expect(pageNows.length).toBeGreaterThan(1);
      expect(new Set(pageNows).size).toBe(1);
    } finally {
      clock.mockRestore();
      handler.mockRestore();
    }
  }, 60_000);

  test("briefOnlyUserIds ORs flags across pages and dedupes paid ids", () => {
    const out = alertRules.briefOnlyUserIds(
      ["a", "b", "c", "c", "d"],
      [
        { userId: "a", optedOut: false, hasDigest: false },
        { userId: "a", optedOut: true, hasDigest: false },
        { userId: "b", optedOut: false, hasDigest: true },
        { userId: "zz-not-paid", optedOut: false, hasDigest: false },
      ],
    );
    expect(out).toEqual(["c", "d"]);
  });
});
