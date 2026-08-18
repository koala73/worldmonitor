import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import { checkUserPrefsWriteRateLimit } from "../userPreferences";
import {
  MAX_PREFS_BLOB_SIZE,
  USER_PREFS_WRITE_RATE_LIMIT,
  USER_PREFS_WRITE_RATE_WINDOW_MS,
} from "../constants";

const modules = import.meta.glob("../**/*.ts");

const TEST_NOW = 1_700_000_000_000;
const TEST_WINDOW_START = Math.floor(TEST_NOW / USER_PREFS_WRITE_RATE_WINDOW_MS) * USER_PREFS_WRITE_RATE_WINDOW_MS;
const TEST_RESET = TEST_WINDOW_START + USER_PREFS_WRITE_RATE_WINDOW_MS;

const USER_A = {
  subject: "user-prefs-rate-a",
  tokenIdentifier: "clerk|user-prefs-rate-a",
};

const USER_B = {
  subject: "user-prefs-rate-b",
  tokenIdentifier: "clerk|user-prefs-rate-b",
};

function makeT() {
  return convexTest(schema, modules);
}

/**
 * A recorded index-range bound, e.g. ["eq", "windowStart", 1699999980000].
 * Convex derives a mutation's OCC read set from the index ranges it scans, so
 * the bounds a query declares ARE the read set — recording them is the direct
 * observation of what #6706 is about, not a proxy for it.
 */
type RecordedBound = [method: string, field: string, value: unknown];
type RecordedRange = { table: string; index: string; bounds: RecordedBound[] };

/**
 * Mirrors the index-range builder handed to `withIndex`, recording each bound
 * and delegating to the real builder. Every call returns the wrapper again so
 * chained bounds (`q.eq(...).eq(...)`) are captured in order.
 */
function recordRange(realRange: any, bounds: RecordedBound[]) {
  const wrap = (method: "eq" | "lt" | "lte" | "gt" | "gte") =>
    (field: string, value: unknown) => {
      bounds.push([method, field, value]);
      return recordRange(realRange[method](field, value), bounds);
    };
  return {
    eq: wrap("eq"),
    lt: wrap("lt"),
    lte: wrap("lte"),
    gt: wrap("gt"),
    gte: wrap("gte"),
    // Convex consumes the builder by calling `export()` exactly once. Delegating
    // it is what keeps the recorded bounds and the range Convex actually scans
    // the same object graph rather than two independent constructions.
    export: () => realRange.export(),
  };
}

/**
 * Wraps a REAL convex-test `ctx.db` so the reads and writes still hit the real
 * in-memory database — only the index ranges are observed on the way through.
 * There is no second implementation of the limiter's storage, so the test
 * cannot pass for a reason the production path would not also produce.
 */
function recordingDb(db: any, recorded: RecordedRange[]) {
  return {
    query: (table: string) => {
      const q = db.query(table);
      return {
        withIndex: (index: string, rangeFn: (rq: any) => any) => {
          const bounds: RecordedBound[] = [];
          const built = q.withIndex(index, (rq: any) => rangeFn(recordRange(rq, bounds)));
          recorded.push({ table, index, bounds });
          return built;
        },
      };
    },
    get: (id: any) => db.get(id),
    insert: (table: string, doc: any) => db.insert(table, doc),
    patch: (id: any, patch: any) => db.patch(id, patch),
    delete: (id: any) => db.delete(id),
  };
}

async function seedLimiterRow(
  t: ReturnType<typeof convexTest>,
  userId: string,
  windowStart: number,
  count: number,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("userPreferenceWriteRateLimits", {
      userId,
      windowStart,
      count,
      updatedAt: windowStart,
    });
  });
}

async function limiterRows(t: ReturnType<typeof convexTest>, userId: string) {
  return await t.run(async (ctx) => {
    return await ctx.db
      .query("userPreferenceWriteRateLimits")
      .withIndex("by_user_window", (q) => q.eq("userId", userId))
      .collect();
  });
}

async function writePref(
  t: ReturnType<typeof convexTest>,
  user: typeof USER_A,
  expectedSyncVersion: number,
) {
  return await t.withIdentity(user).mutation(api.userPreferences.setPreferences, {
    variant: "full",
    data: { theme: `theme-${expectedSyncVersion}` },
    expectedSyncVersion,
    schemaVersion: 1,
  });
}

async function expectRateLimited(promise: Promise<unknown>, reset = TEST_RESET) {
  await expect(promise).resolves.toEqual({
    ok: false,
    reason: "RATE_LIMITED",
    limit: USER_PREFS_WRITE_RATE_LIMIT,
    reset,
  });
}

describe("userPreferences.setPreferences write rate limit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("caps direct Convex writes per authenticated user and fixed window", async () => {
    vi.spyOn(Date, "now").mockReturnValue(TEST_NOW);
    const t = makeT();

    for (let i = 0; i < USER_PREFS_WRITE_RATE_LIMIT; i++) {
      const result = await writePref(t, USER_A, i);
      expect(result).toEqual({ ok: true, syncVersion: i + 1 });
    }

    await expectRateLimited(writePref(t, USER_A, USER_PREFS_WRITE_RATE_LIMIT));

    const row = await t.run(async (ctx) => {
      return await ctx.db
        .query("userPreferences")
        .withIndex("by_user_variant", (q) =>
          q.eq("userId", USER_A.subject).eq("variant", "full"),
        )
        .unique();
    });
    expect(row?.syncVersion).toBe(USER_PREFS_WRITE_RATE_LIMIT);
  });

  test("uses separate buckets per authenticated user", async () => {
    vi.spyOn(Date, "now").mockReturnValue(TEST_NOW);
    const t = makeT();

    for (let i = 0; i < USER_PREFS_WRITE_RATE_LIMIT; i++) {
      await writePref(t, USER_A, i);
    }
    await expectRateLimited(writePref(t, USER_A, USER_PREFS_WRITE_RATE_LIMIT));

    await expect(writePref(t, USER_B, 0)).resolves.toEqual({ ok: true, syncVersion: 1 });
  });

  test("resets the write budget when the fixed window advances", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(TEST_NOW);
    const t = makeT();

    for (let i = 0; i < USER_PREFS_WRITE_RATE_LIMIT; i++) {
      await writePref(t, USER_A, i);
    }
    await expectRateLimited(writePref(t, USER_A, USER_PREFS_WRITE_RATE_LIMIT));

    now.mockReturnValue(TEST_RESET);
    await expect(writePref(t, USER_A, USER_PREFS_WRITE_RATE_LIMIT)).resolves.toEqual({
      ok: true,
      syncVersion: USER_PREFS_WRITE_RATE_LIMIT + 1,
    });
  });

  test("consolidates duplicate counter rows left by concurrent first writes", async () => {
    vi.spyOn(Date, "now").mockReturnValue(TEST_NOW);
    const t = makeT();

    await t.run(async (ctx) => {
      await ctx.db.insert("userPreferenceWriteRateLimits", {
        userId: USER_A.subject,
        windowStart: TEST_WINDOW_START,
        count: 1,
        updatedAt: TEST_NOW - 20,
      });
      await ctx.db.insert("userPreferenceWriteRateLimits", {
        userId: USER_A.subject,
        windowStart: TEST_WINDOW_START,
        count: 2,
        updatedAt: TEST_NOW - 10,
      });
      await ctx.db.insert("userPreferenceWriteRateLimits", {
        userId: USER_A.subject,
        windowStart: TEST_WINDOW_START - USER_PREFS_WRITE_RATE_WINDOW_MS,
        count: 99,
        updatedAt: TEST_NOW - USER_PREFS_WRITE_RATE_WINDOW_MS,
      });
    });

    await expect(writePref(t, USER_A, 0)).resolves.toEqual({ ok: true, syncVersion: 1 });

    const rows = await limiterRows(t, USER_A.subject);

    // Consolidation is scoped to the current window — that is the one range the
    // write path is allowed to touch (#6706). The count is 4 (1 + 2 duplicates,
    // plus this write), NOT 103: the expired window's 99 is neither folded in
    // nor deleted here. It survives until `pruneStaleWriteRateLimits` collects
    // it, which is the whole point of moving that sweep off the write path.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      userId: USER_A.subject,
      windowStart: TEST_WINDOW_START - USER_PREFS_WRITE_RATE_WINDOW_MS,
      count: 99,
    });
    expect(rows[1]).toMatchObject({
      userId: USER_A.subject,
      windowStart: TEST_WINDOW_START,
      count: 4,
      updatedAt: TEST_NOW,
    });
  });

  test("consolidates duplicate counter rows even when the request is rate limited", async () => {
    vi.spyOn(Date, "now").mockReturnValue(TEST_NOW);
    const t = makeT();

    await t.run(async (ctx) => {
      await ctx.db.insert("userPreferenceWriteRateLimits", {
        userId: USER_A.subject,
        windowStart: TEST_WINDOW_START,
        count: 10,
        updatedAt: TEST_NOW - 20,
      });
      await ctx.db.insert("userPreferenceWriteRateLimits", {
        userId: USER_A.subject,
        windowStart: TEST_WINDOW_START,
        count: USER_PREFS_WRITE_RATE_LIMIT - 10,
        updatedAt: TEST_NOW - 10,
      });
    });

    await expectRateLimited(writePref(t, USER_A, 0));

    const rows = await t.run(async (ctx) => {
      return await ctx.db
        .query("userPreferenceWriteRateLimits")
        .withIndex("by_user_window", (q) =>
          q.eq("userId", USER_A.subject).eq("windowStart", TEST_WINDOW_START),
        )
        .collect();
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: USER_A.subject,
      windowStart: TEST_WINDOW_START,
      count: USER_PREFS_WRITE_RATE_LIMIT,
      updatedAt: TEST_NOW,
    });
  });

  test("oversized write attempts consume the direct Convex write budget", async () => {
    vi.spyOn(Date, "now").mockReturnValue(TEST_NOW);
    const t = makeT();
    const data = { payload: "x".repeat(MAX_PREFS_BLOB_SIZE) };

    for (let i = 0; i < USER_PREFS_WRITE_RATE_LIMIT; i++) {
      await expect(
        t.withIdentity(USER_A).mutation(api.userPreferences.setPreferences, {
          variant: "full",
          data,
          expectedSyncVersion: 0,
          schemaVersion: 1,
        }),
      ).resolves.toMatchObject({
        ok: false,
        reason: "BLOB_TOO_LARGE",
        max: MAX_PREFS_BLOB_SIZE,
      });
    }

    await expectRateLimited(writePref(t, USER_A, 0));
  });

  test("rate limit wins before stale-version CONFLICT checks", async () => {
    vi.spyOn(Date, "now").mockReturnValue(TEST_NOW);
    const t = makeT();

    for (let i = 0; i < USER_PREFS_WRITE_RATE_LIMIT; i++) {
      await writePref(t, USER_A, i);
    }

    await expectRateLimited(writePref(t, USER_A, 0));
  });

  test("preserves rolling-deployment fields omitted by an older writer", async () => {
    vi.spyOn(Date, "now").mockReturnValue(TEST_NOW);
    const t = makeT();
    const sourceOwnership = "worldmonitor-free-tier-source-ownership";
    const layerOwnership = "worldmonitor-free-tier-layer-ownership";
    const fontScale = "wm-font-scale";

    await expect(
      t.withIdentity(USER_A).mutation(api.userPreferences.setPreferences, {
        variant: "full",
        data: {
          theme: "dark",
          [sourceOwnership]: '["source-a"]',
          [layerOwnership]: '["resilienceScore"]',
          [fontScale]: "2",
        },
        expectedSyncVersion: 0,
        schemaVersion: 6,
      }),
    ).resolves.toEqual({ ok: true, syncVersion: 1 });

    await expect(
      t.withIdentity(USER_A).mutation(api.userPreferences.setPreferences, {
        variant: "full",
        data: { theme: "light" },
        expectedSyncVersion: 1,
        schemaVersion: 6,
      }),
    ).resolves.toEqual({ ok: true, syncVersion: 2 });

    const preserved = await t.withIdentity(USER_A).query(api.userPreferences.getPreferences, {
      variant: "full",
    });
    expect(preserved?.data).toEqual({
      theme: "light",
      [sourceOwnership]: '["source-a"]',
      [layerOwnership]: '["resilienceScore"]',
      [fontScale]: "2",
    });

    await expect(
      t.withIdentity(USER_A).mutation(api.userPreferences.setPreferences, {
        variant: "full",
        data: {
          theme: "light",
          [sourceOwnership]: "[]",
          [layerOwnership]: "[]",
          [fontScale]: "1",
        },
        expectedSyncVersion: 2,
        schemaVersion: 6,
      }),
    ).resolves.toEqual({ ok: true, syncVersion: 3 });

    const cleared = await t.withIdentity(USER_A).query(api.userPreferences.getPreferences, {
      variant: "full",
    });
    expect(cleared?.data).toMatchObject({
      [sourceOwnership]: "[]",
      [layerOwnership]: "[]",
      [fontScale]: "1",
    });
  });
});

/**
 * #6706 (WORLDMONITOR-ZE). Convex builds a mutation's OCC read set from the
 * index ranges it scans. The limiter used to end every write with a stale-row
 * sweep keyed on `userId` ALONE, which pulled the user's whole row set — across
 * all windows — into the read set of a write that only ever needs the current
 * window. A second concurrent write by the same user (two dashboard tabs, or a
 * dragged slider persisting per change) invalidated that read set, and because
 * the contending writes kept arriving, every retry collided too — Convex
 * exhausted its retries and the preference write FAILED.
 *
 * The bound below is the fix's contract: no query the write path issues against
 * `userPreferenceWriteRateLimits` may leave `windowStart` unbounded.
 */
describe("userPreferences write-path OCC read set (#6706)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("limiter accounting scans only the caller's current window", async () => {
    vi.spyOn(Date, "now").mockReturnValue(TEST_NOW);
    const t = makeT();

    // Rows this user left behind in earlier windows — exactly what the old
    // sweep reached for, and what dragged the read set wide.
    await seedLimiterRow(t, USER_A.subject, TEST_WINDOW_START - USER_PREFS_WRITE_RATE_WINDOW_MS, 7);
    await seedLimiterRow(t, USER_A.subject, TEST_WINDOW_START - 5 * USER_PREFS_WRITE_RATE_WINDOW_MS, 3);
    await seedLimiterRow(t, USER_A.subject, TEST_WINDOW_START, 1);

    const recorded: RecordedRange[] = [];
    const result = await t.run(async (ctx) => {
      return await checkUserPrefsWriteRateLimit(
        { db: recordingDb(ctx.db, recorded) } as unknown as MutationCtx,
        USER_A.subject,
      );
    });

    expect(result).toEqual({ ok: true });

    const limiterScans = recorded.filter((r) => r.table === "userPreferenceWriteRateLimits");
    expect(limiterScans.length).toBeGreaterThan(0);
    for (const scan of limiterScans) {
      expect(scan.bounds).toEqual([
        ["eq", "userId", USER_A.subject],
        ["eq", "windowStart", TEST_WINDOW_START],
      ]);
    }
  });

  test("a write leaves other windows' rows untouched", async () => {
    vi.spyOn(Date, "now").mockReturnValue(TEST_NOW);
    const t = makeT();

    const previousWindow = TEST_WINDOW_START - USER_PREFS_WRITE_RATE_WINDOW_MS;
    await seedLimiterRow(t, USER_A.subject, previousWindow, 7);

    await expect(writePref(t, USER_A, 0)).resolves.toEqual({ ok: true, syncVersion: 1 });

    const rows = await limiterRows(t, USER_A.subject);
    expect(rows.map((row) => ({ windowStart: row.windowStart, count: row.count }))).toEqual([
      { windowStart: previousWindow, count: 7 },
      { windowStart: TEST_WINDOW_START, count: 1 },
    ]);
  });
});

describe("userPreferences.pruneStaleWriteRateLimits", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("collects expired windows and never the live counter", async () => {
    vi.spyOn(Date, "now").mockReturnValue(TEST_NOW);
    const t = makeT();

    await seedLimiterRow(t, USER_A.subject, TEST_WINDOW_START - 10 * USER_PREFS_WRITE_RATE_WINDOW_MS, 4);
    await seedLimiterRow(t, USER_A.subject, TEST_WINDOW_START - USER_PREFS_WRITE_RATE_WINDOW_MS, 7);
    await seedLimiterRow(t, USER_A.subject, TEST_WINDOW_START, 12);
    await seedLimiterRow(t, USER_B.subject, TEST_WINDOW_START - 2 * USER_PREFS_WRITE_RATE_WINDOW_MS, 5);
    await seedLimiterRow(t, USER_B.subject, TEST_WINDOW_START, USER_PREFS_WRITE_RATE_LIMIT);

    await expect(
      t.mutation(internal.userPreferences.pruneStaleWriteRateLimits, {}),
    ).resolves.toMatchObject({ deleted: 3, cutoff: TEST_WINDOW_START, rescheduled: false });

    expect(await limiterRows(t, USER_A.subject)).toMatchObject([
      { windowStart: TEST_WINDOW_START, count: 12 },
    ]);
    // USER_B was at the cap. Had the prune touched the live row, the very next
    // write would have been admitted — a limiter bypass, not just early GC.
    expect(await limiterRows(t, USER_B.subject)).toMatchObject([
      { windowStart: TEST_WINDOW_START, count: USER_PREFS_WRITE_RATE_LIMIT },
    ]);
    await expectRateLimited(writePref(t, USER_B, 0));
  });

  test("self-drains across runs when a batch fills", async () => {
    // The continuation is queued via ctx.scheduler.runAfter(0); convex-test
    // can't cleanly execute a self-scheduling mutation's continuation, so the
    // drain is driven by re-invoking and the queued callbacks are discarded.
    vi.useFakeTimers();
    vi.spyOn(Date, "now").mockReturnValue(TEST_NOW);
    const t = makeT();

    for (let i = 1; i <= 5; i++) {
      await seedLimiterRow(t, USER_A.subject, TEST_WINDOW_START - i * USER_PREFS_WRITE_RATE_WINDOW_MS, i);
    }
    await seedLimiterRow(t, USER_A.subject, TEST_WINDOW_START, 1);

    await expect(
      t.mutation(internal.userPreferences.pruneStaleWriteRateLimits, { limit: 2 }),
    ).resolves.toMatchObject({ deleted: 2, rescheduled: true });
    await expect(
      t.mutation(internal.userPreferences.pruneStaleWriteRateLimits, { limit: 2 }),
    ).resolves.toMatchObject({ deleted: 2, rescheduled: true });
    await expect(
      t.mutation(internal.userPreferences.pruneStaleWriteRateLimits, { limit: 2 }),
    ).resolves.toMatchObject({ deleted: 1, rescheduled: false });

    expect(await limiterRows(t, USER_A.subject)).toMatchObject([
      { windowStart: TEST_WINDOW_START, count: 1 },
    ]);
  });

  test("a zero or non-finite limit falls back instead of rescheduling forever", async () => {
    // Fake timers for the same reason as the drain test above: the first pass
    // below reschedules, and a continuation firing on its own mid-test would
    // open a transaction while this one is still running.
    vi.useFakeTimers();
    vi.spyOn(Date, "now").mockReturnValue(TEST_NOW);
    const t = makeT();

    await seedLimiterRow(t, USER_A.subject, TEST_WINDOW_START - USER_PREFS_WRITE_RATE_WINDOW_MS, 7);

    // limit:0 would make take(0) return [] and read `0 >= 0` as a full batch —
    // an empty reschedule loop that deletes nothing. The floor turns it into a
    // real pass instead.
    await expect(
      t.mutation(internal.userPreferences.pruneStaleWriteRateLimits, { limit: 0 }),
    ).resolves.toMatchObject({ deleted: 1, rescheduled: true });
    await expect(
      t.mutation(internal.userPreferences.pruneStaleWriteRateLimits, { limit: 0 }),
    ).resolves.toMatchObject({ deleted: 0, rescheduled: false });

    await seedLimiterRow(t, USER_A.subject, TEST_WINDOW_START - USER_PREFS_WRITE_RATE_WINDOW_MS, 7);
    await expect(
      t.mutation(internal.userPreferences.pruneStaleWriteRateLimits, { limit: Number.NaN }),
    ).resolves.toMatchObject({ deleted: 1, rescheduled: false });
  });
});
