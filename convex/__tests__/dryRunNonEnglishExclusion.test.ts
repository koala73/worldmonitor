import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");

async function seedRegistrations(
  t: ReturnType<typeof convexTest>,
  emails: Array<{ email: string; proLaunchWave?: string }>,
) {
  await t.run(async (ctx) => {
    for (const row of emails) {
      await ctx.db.insert("registrations", {
        email: row.email,
        normalizedEmail: row.email.toLowerCase(),
        registeredAt: Date.now(),
        source: "test",
        proLaunchWave: row.proLaunchWave,
      });
    }
  });
}

describe("_dryRunNonEnglishExclusion", () => {
  test("empty pool → all counters zero", async () => {
    const t = convexTest(schema, modules);
    const result = await t.action(
      internal.broadcast.waveRuns._dryRunNonEnglishExclusion,
      {},
    );
    expect(result.eligibleTotal).toBe(0);
    expect(result.excludedTotal).toBe(0);
    expect(result.excludedByLocale).toEqual({});
    expect(result.sampleExcludedEmails).toEqual([]);
  });

  test("all-English pool → 0 excluded", async () => {
    const t = convexTest(schema, modules);
    await seedRegistrations(t, [
      { email: "a@gmail.com" },
      { email: "b@gmail.com" },
      { email: "c@example.com" },
    ]);
    const result = await t.action(
      internal.broadcast.waveRuns._dryRunNonEnglishExclusion,
      {},
    );
    expect(result.eligibleTotal).toBe(3);
    expect(result.excludedTotal).toBe(0);
    expect(result.excludedByLocale).toEqual({});
  });

  test("mixed pool → counters match expectation, sample populated", async () => {
    const t = convexTest(schema, modules);
    await seedRegistrations(t, [
      { email: "g1@gmail.com" },
      { email: "g2@gmail.com" },
      { email: "g3@gmail.com" },
      { email: "q1@qq.com" },
      { email: "q2@qq.com" },
      { email: "y1@yandex.ru" },
      { email: "y2@yandex.ru" },
      { email: "y3@yandex.ru" },
    ]);
    const result = await t.action(
      internal.broadcast.waveRuns._dryRunNonEnglishExclusion,
      { sampleSize: 5 },
    );
    expect(result.eligibleTotal).toBe(8);
    expect(result.excludedTotal).toBe(5);
    expect(result.excludedByLocale).toEqual({ zh: 2, ru: 3 });
    // Sample should contain only excluded emails (qq.com / yandex.ru), no gmail.
    expect(result.sampleExcludedEmails.length).toBeGreaterThan(0);
    expect(result.sampleExcludedEmails.length).toBeLessThanOrEqual(5);
    expect(
      result.sampleExcludedEmails.every(
        (e) => e.endsWith("@qq.com") || e.endsWith("@yandex.ru"),
      ),
    ).toBe(true);
  });

  test("users-table override beats heuristic in dry-run too", async () => {
    const t = convexTest(schema, modules);
    await seedRegistrations(t, [
      { email: "us-based@qq.com" },
      { email: "regular@qq.com" },
    ]);
    const now = Date.now();
    await t.run(async (ctx) => {
      // Mark us-based@qq.com as English via users table — should be kept.
      await ctx.db.insert("users", {
        userId: "u1",
        normalizedEmail: "us-based@qq.com",
        localeTag: "en-US",
        localePrimary: "en",
        firstSeenAt: now,
        lastSeenAt: now,
      });
    });
    const result = await t.action(
      internal.broadcast.waveRuns._dryRunNonEnglishExclusion,
      {},
    );
    expect(result.eligibleTotal).toBe(2);
    expect(result.excludedTotal).toBe(1); // regular@qq.com only
    expect(result.excludedByLocale).toEqual({ zh: 1 });
  });

  test("does NOT touch waveRuns / wavePickedContacts / Resend", async () => {
    const t = convexTest(schema, modules);
    await seedRegistrations(t, [{ email: "a@qq.com" }, { email: "b@qq.com" }]);
    await t.action(
      internal.broadcast.waveRuns._dryRunNonEnglishExclusion,
      {},
    );
    const waveRuns = await t.run(async (ctx) =>
      await ctx.db.query("waveRuns").collect(),
    );
    const picks = await t.run(async (ctx) =>
      await ctx.db.query("wavePickedContacts").collect(),
    );
    expect(waveRuns).toEqual([]);
    expect(picks).toEqual([]);
  });
});
