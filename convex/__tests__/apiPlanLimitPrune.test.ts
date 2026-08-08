import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");
const pruneFns = (internal as any).apiPlanLimitNotices;

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

function notice(overrides: Record<string, unknown>) {
  return {
    userId: "u",
    planKey: "api_starter",
    dimension: "api_daily_requests",
    state: "over_limit",
    windowKey: "w",
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    usage: 1_500,
    limit: 1_000,
    usageRatio: 1.5,
    current: false,
    emailStatus: "sent",
    ctaKind: "contact_support",
    ...overrides,
  };
}

function makeRollup(overrides: Record<string, unknown>) {
  return {
    userId: "u",
    planKey: "api_starter",
    dimension: "api_daily_requests",
    windowKey: "w",
    windowStart: NOW,
    windowEnd: NOW + DAY,
    limit: 1_000,
    usage: 900,
    usageRatio: 0.9,
    source: "test",
    sourceFreshAt: NOW,
    computedAt: NOW,
    ...overrides,
  };
}

describe("api plan-limit retention prune", () => {
  // The prune self-schedules its continuation via ctx.scheduler.runAfter(0)
  // whenever a full batch is deleted. Under fake timers that continuation is
  // queued but never fires on its own (convex-test can't cleanly execute a
  // self-scheduling mutation's continuation), so tests drive the drain by
  // re-invoking and discard the queued callbacks on teardown.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  test("prunes aged rollups + superseded notices, keeps recent and live rows", async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      // Old + superseded -> pruned.
      await ctx.db.insert("apiPlanLimitNotices", notice({ windowKey: "old", lastSeenAt: NOW - 200 * DAY }));
      // Old but LIVE (current:true) -> kept; an active notice is never pruned.
      await ctx.db.insert("apiPlanLimitNotices", notice({ windowKey: "old-live", lastSeenAt: NOW - 200 * DAY, current: true }));
      // Recent + superseded -> kept.
      await ctx.db.insert("apiPlanLimitNotices", notice({ windowKey: "recent", lastSeenAt: NOW - DAY }));

      await ctx.db.insert("apiUsageRollups", makeRollup({ windowKey: "old", computedAt: NOW - 200 * DAY }));
      await ctx.db.insert("apiUsageRollups", makeRollup({ windowKey: "recent", computedAt: NOW - DAY }));
    });

    const result = await t.mutation(pruneFns.pruneApiPlanLimitData, { now: NOW });
    expect(result).toMatchObject({ noticesDeleted: 1, rollupsDeleted: 1 });

    const notices = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    const rollups = await t.run((ctx) => ctx.db.query("apiUsageRollups").collect());
    expect(notices.map((n) => n.windowKey).sort()).toEqual(["old-live", "recent"]);
    expect(rollups.map((r) => r.windowKey)).toEqual(["recent"]);
  });

  test("deletes at most `limit` per run and drains the rest on the next run", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert("apiPlanLimitNotices", notice({ windowKey: `old-${i}`, lastSeenAt: NOW - 200 * DAY }));
      }
    });

    const first = await t.mutation(pruneFns.pruneApiPlanLimitData, { now: NOW, limit: 2 });
    expect(first.noticesDeleted).toBe(2);
    expect(await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).toHaveLength(1);

    const second = await t.mutation(pruneFns.pruneApiPlanLimitData, { now: NOW, limit: 2 });
    expect(second.noticesDeleted).toBe(1);
    expect(await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).toHaveLength(0);
  });

  test("self-reschedules until the whole aged backlog drains", async () => {
    const t = convexTest(schema, modules);
    // 5 aged rollups, drained 2 at a time. The mutation reschedules itself via
    // runAfter(0) whenever a full batch is deleted; we drive that chain
    // deterministically by re-invoking while `rescheduled` is true. This proves
    // the reschedule DECISION and that it TERMINATES once drained -- so a backlog
    // larger than one batch can't outlive a single cron tick.
    await t.run(async (ctx) => {
      for (let i = 0; i < 5; i++) {
        await ctx.db.insert("apiUsageRollups", makeRollup({ windowKey: `old-${i}`, computedAt: NOW - 200 * DAY }));
      }
    });

    let res = await t.mutation(pruneFns.pruneApiPlanLimitData, { now: NOW, limit: 2 });
    expect(res).toMatchObject({ rollupsDeleted: 2, rescheduled: true });
    let guard = 0;
    while (res.rescheduled) {
      if (++guard > 10) throw new Error("prune did not terminate");
      res = await t.mutation(pruneFns.pruneApiPlanLimitData, { now: NOW, limit: 2 });
    }
    expect(res.rescheduled).toBe(false);
    expect(await t.run((ctx) => ctx.db.query("apiUsageRollups").collect())).toHaveLength(0);
  });

  test("does not reschedule when the backlog fits in one batch", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("apiUsageRollups", makeRollup({ windowKey: "old", computedAt: NOW - 200 * DAY }));
    });
    const result = await t.mutation(pruneFns.pruneApiPlanLimitData, { now: NOW, limit: 500 });
    expect(result).toMatchObject({ rollupsDeleted: 1, rescheduled: false });
  });
});
