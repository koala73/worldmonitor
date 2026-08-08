import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
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

    const rows = await t.run(async (ctx) => {
      return await ctx.db
        .query("userPreferenceWriteRateLimits")
        .withIndex("by_user_window", (q) => q.eq("userId", USER_A.subject))
        .collect();
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
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
});
