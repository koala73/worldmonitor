import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { filterPageForEligibility } from "../broadcast/_poolSelection";

const modules = import.meta.glob("../**/*.ts");

// ───────────────────────────────────────────────────────────────────────────
// Pure helper tests — no Convex runtime, no mocks
// ───────────────────────────────────────────────────────────────────────────

describe("filterPageForEligibility — pure helper", () => {
  test("gmail-only page, excludeNonEnglish=true → all eligible", () => {
    const result = filterPageForEligibility({
      page: [
        { normalizedEmail: "a@gmail.com" },
        { normalizedEmail: "b@gmail.com" },
        { normalizedEmail: "c@gmail.com" },
      ],
      suppressedSet: new Set(),
      paidSet: new Set(),
      usersByEmail: new Map(),
      excludeNonEnglish: true,
    });
    expect(result.eligible).toEqual(["a@gmail.com", "b@gmail.com", "c@gmail.com"]);
    expect(result.pageEligibleCount).toBe(3);
    expect(result.pageExcludedTotal).toBe(0);
    expect(result.pageExcludedByLocale).toEqual({});
  });

  test("users-table beats heuristic — qq.com user with localePrimary=en kept", () => {
    const result = filterPageForEligibility({
      page: [
        { normalizedEmail: "us-based-cn@qq.com" },
        { normalizedEmail: "regular@qq.com" },
      ],
      suppressedSet: new Set(),
      paidSet: new Set(),
      usersByEmail: new Map([
        ["us-based-cn@qq.com", { localePrimary: "en" }],
      ]),
      excludeNonEnglish: true,
    });
    expect(result.eligible).toEqual(["us-based-cn@qq.com"]);
    expect(result.pageExcludedByLocale).toEqual({ zh: 1 });
    expect(result.pageExcludedTotal).toBe(1);
    expect(result.pageEligibleCount).toBe(2);
  });

  test("all locale-excluded → 0 eligible, counts populated", () => {
    const result = filterPageForEligibility({
      page: [
        { normalizedEmail: "u1@qq.com" },
        { normalizedEmail: "u2@qq.com" },
        { normalizedEmail: "u3@yandex.ru" },
        { normalizedEmail: "u4@yandex.ru" },
        { normalizedEmail: "u5@yandex.ru" },
      ],
      suppressedSet: new Set(),
      paidSet: new Set(),
      usersByEmail: new Map(),
      excludeNonEnglish: true,
    });
    expect(result.eligible).toEqual([]);
    expect(result.pageExcludedByLocale).toEqual({ zh: 2, ru: 3 });
    expect(result.pageExcludedTotal).toBe(5);
    expect(result.pageEligibleCount).toBe(5);
  });

  test("suppressed beats locale — qq.com in suppressedSet not counted as locale-excluded", () => {
    const result = filterPageForEligibility({
      page: [
        { normalizedEmail: "bouncer@qq.com" },
        { normalizedEmail: "active@qq.com" },
      ],
      suppressedSet: new Set(["bouncer@qq.com"]),
      paidSet: new Set(),
      usersByEmail: new Map(),
      excludeNonEnglish: true,
    });
    expect(result.eligible).toEqual([]);
    expect(result.pageEligibleCount).toBe(1);
    expect(result.pageExcludedByLocale).toEqual({ zh: 1 });
    expect(result.pageExcludedTotal).toBe(1);
  });

  test("paid beats everything", () => {
    const result = filterPageForEligibility({
      page: [
        { normalizedEmail: "paid-user@gmail.com" },
        { normalizedEmail: "free-user@gmail.com" },
      ],
      suppressedSet: new Set(),
      paidSet: new Set(["paid-user@gmail.com"]),
      usersByEmail: new Map(),
      excludeNonEnglish: true,
    });
    expect(result.eligible).toEqual(["free-user@gmail.com"]);
    expect(result.pageEligibleCount).toBe(1);
  });

  test("already-stamped (proLaunchWave set) skipped", () => {
    const result = filterPageForEligibility({
      page: [
        { normalizedEmail: "stamped@gmail.com", proLaunchWave: "wave-3" },
        { normalizedEmail: "fresh@gmail.com" },
      ],
      suppressedSet: new Set(),
      paidSet: new Set(),
      usersByEmail: new Map(),
      excludeNonEnglish: true,
    });
    expect(result.eligible).toEqual(["fresh@gmail.com"]);
    expect(result.pageEligibleCount).toBe(1);
  });

  test("excludeNonEnglish=false → non-English locales NOT excluded", () => {
    const result = filterPageForEligibility({
      page: [
        { normalizedEmail: "u@qq.com" },
        { normalizedEmail: "u@yandex.ru" },
      ],
      suppressedSet: new Set(),
      paidSet: new Set(),
      usersByEmail: new Map(),
      excludeNonEnglish: false,
    });
    expect(result.eligible).toEqual(["u@qq.com", "u@yandex.ru"]);
    expect(result.pageExcludedTotal).toBe(0);
  });

  test("empty page → empty eligible, all counters zero", () => {
    const result = filterPageForEligibility({
      page: [],
      suppressedSet: new Set(),
      paidSet: new Set(),
      usersByEmail: new Map(),
      excludeNonEnglish: true,
    });
    expect(result.eligible).toEqual([]);
    expect(result.pageEligibleCount).toBe(0);
    expect(result.pageExcludedTotal).toBe(0);
  });

  test("CRITICAL — underfill regression: 800 gmail + 100 qq.com + 100 yandex.ru, only 800 gmail eligible", () => {
    // This is the round-2 Codex finding #1 regression test. Without
    // filter-before-reservoir, the action would have offered all 1000
    // emails to the reservoir, then post-sample-filtered, silently
    // shrinking a 1000-target wave to 800. With filter-before-reservoir
    // (pure helper here), eligible[] contains ONLY English-eligible
    // emails — the reservoir downstream samples from a clean pool.
    const page: Array<{ normalizedEmail: string; proLaunchWave?: string }> = [];
    for (let i = 0; i < 800; i++) page.push({ normalizedEmail: `g${i}@gmail.com` });
    for (let i = 0; i < 100; i++) page.push({ normalizedEmail: `q${i}@qq.com` });
    for (let i = 0; i < 100; i++) page.push({ normalizedEmail: `r${i}@yandex.ru` });

    const result = filterPageForEligibility({
      page,
      suppressedSet: new Set(),
      paidSet: new Set(),
      usersByEmail: new Map(),
      excludeNonEnglish: true,
    });

    expect(result.eligible.length).toBe(800);
    expect(result.eligible.every((e) => e.endsWith("@gmail.com"))).toBe(true);
    expect(result.pageExcludedByLocale).toEqual({ zh: 100, ru: 100 });
    expect(result.pageExcludedTotal).toBe(200);
    expect(result.pageEligibleCount).toBe(1000);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// _getUsersByEmailPage internal query — wire-shape tests
// ───────────────────────────────────────────────────────────────────────────

describe("_getUsersByEmailPage — Convex wire shape", () => {
  test("returns Array<{normalizedEmail, localePrimary?}>; missing emails absent", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        userId: "u1",
        normalizedEmail: "a@gmail.com",
        localeTag: "en-US",
        localePrimary: "en",
        firstSeenAt: now,
        lastSeenAt: now,
      });
      await ctx.db.insert("users", {
        userId: "u2",
        normalizedEmail: "b@qq.com",
        localeTag: "zh-CN",
        localePrimary: "zh",
        firstSeenAt: now,
        lastSeenAt: now,
      });
      // u3 has NO normalizedEmail (e.g., phone-only signup)
      await ctx.db.insert("users", {
        userId: "u3",
        firstSeenAt: now,
        lastSeenAt: now,
      });
    });

    const result: Array<{ normalizedEmail: string; localePrimary?: string }> =
      await t.query(internal.broadcast.waveRuns._getUsersByEmailPage, {
        emails: ["a@gmail.com", "b@qq.com", "missing@example.com"],
      });

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(2); // missing@example.com absent
    const map = new Map(result.map((r) => [r.normalizedEmail, r.localePrimary]));
    expect(map.get("a@gmail.com")).toBe("en");
    expect(map.get("b@qq.com")).toBe("zh");
    expect(map.has("missing@example.com")).toBe(false);
  });

  test("empty input → empty array", async () => {
    const t = convexTest(schema, modules);
    const result = await t.query(
      internal.broadcast.waveRuns._getUsersByEmailPage,
      { emails: [] },
    );
    expect(result).toEqual([]);
  });

  test("1000-email page — parallel lookup contract holds (perf-shape regression)", async () => {
    // Locks in the bulk-page behavior expected from the Promise.all-based
    // implementation. Pre-fix: 1000 sequential awaits (~1s+ on prod
    // network); post-fix: parallel batch (~100ms typical). The test
    // doesn't assert wall-clock but DOES assert correctness over a
    // page-sized input where the implementation matters.
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      // Seed users for half of the emails (so we exercise both hit + miss paths)
      for (let i = 0; i < 500; i++) {
        await ctx.db.insert("users", {
          userId: `u-${i}`,
          normalizedEmail: `bulk-${i}@gmail.com`,
          localeTag: i % 3 === 0 ? "zh-CN" : "en-US",
          localePrimary: i % 3 === 0 ? "zh" : "en",
          firstSeenAt: now,
          lastSeenAt: now,
        });
      }
    });
    const inputEmails: string[] = [];
    for (let i = 0; i < 1000; i++) inputEmails.push(`bulk-${i}@gmail.com`);

    const result = await t.query(
      internal.broadcast.waveRuns._getUsersByEmailPage,
      { emails: inputEmails },
    );

    // Only the seeded half match.
    expect(result.length).toBe(500);
    const map = new Map(result.map((r) => [r.normalizedEmail, r.localePrimary]));
    expect(map.get("bulk-0@gmail.com")).toBe("zh");
    expect(map.get("bulk-1@gmail.com")).toBe("en");
    expect(map.has("bulk-501@gmail.com")).toBe(false); // unseeded
  });
});
