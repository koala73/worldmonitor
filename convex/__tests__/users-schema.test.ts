/**
 * Schema-invariant locks for the `users` table. Catches accidental
 * regressions if a future edit breaks required-field enforcement, optional
 * field handling, or one of the three indexes.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

describe("users schema invariants", () => {
  test("required fields only — userId, firstSeenAt, lastSeenAt are sufficient to insert", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        userId: "u-required-only",
        firstSeenAt: now,
        lastSeenAt: now,
      });
    });
    const row = await t.run(async (ctx) =>
      await ctx.db
        .query("users")
        .withIndex("by_userId", (q) => q.eq("userId", "u-required-only"))
        .unique(),
    );
    expect(row).not.toBeNull();
    expect(row?.email).toBeUndefined();
    expect(row?.localeTag).toBeUndefined();
    expect(row?.country).toBeUndefined();
  });

  test("all fields populated — round-trip preserves all values", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        userId: "u-full",
        email: "alice@example.com",
        normalizedEmail: "alice@example.com",
        localeTag: "zh-Hant-TW",
        localePrimary: "zh",
        timezone: "Asia/Taipei",
        country: "TW",
        firstSeenAt: now,
        lastSeenAt: now,
      });
    });
    const row = await t.run(async (ctx) =>
      await ctx.db
        .query("users")
        .withIndex("by_userId", (q) => q.eq("userId", "u-full"))
        .unique(),
    );
    expect(row?.email).toBe("alice@example.com");
    expect(row?.localeTag).toBe("zh-Hant-TW");
    expect(row?.localePrimary).toBe("zh");
    expect(row?.timezone).toBe("Asia/Taipei");
    expect(row?.country).toBe("TW");
  });

  test("by_normalizedEmail index returns row by email", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        userId: "u-email-index",
        normalizedEmail: "lookup@example.com",
        firstSeenAt: now,
        lastSeenAt: now,
      });
    });
    const row = await t.run(async (ctx) =>
      await ctx.db
        .query("users")
        .withIndex("by_normalizedEmail", (q) =>
          q.eq("normalizedEmail", "lookup@example.com"),
        )
        .unique(),
    );
    expect(row?.userId).toBe("u-email-index");
  });

  test("by_localePrimary index returns matches", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        userId: "u-zh-1",
        localePrimary: "zh",
        firstSeenAt: now,
        lastSeenAt: now,
      });
      await ctx.db.insert("users", {
        userId: "u-zh-2",
        localePrimary: "zh",
        firstSeenAt: now,
        lastSeenAt: now,
      });
      await ctx.db.insert("users", {
        userId: "u-en-1",
        localePrimary: "en",
        firstSeenAt: now,
        lastSeenAt: now,
      });
    });
    const zhRows = await t.run(async (ctx) =>
      await ctx.db
        .query("users")
        .withIndex("by_localePrimary", (q) => q.eq("localePrimary", "zh"))
        .collect(),
    );
    expect(zhRows.length).toBe(2);
    expect(zhRows.every((r) => r.localePrimary === "zh")).toBe(true);
  });

  test("localeTag and localePrimary independently optional", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    // localeTag set, localePrimary unset
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        userId: "u-tag-only",
        localeTag: "fr-CA",
        firstSeenAt: now,
        lastSeenAt: now,
      });
      // localePrimary set, localeTag unset
      await ctx.db.insert("users", {
        userId: "u-primary-only",
        localePrimary: "en",
        firstSeenAt: now,
        lastSeenAt: now,
      });
    });
    const tagOnly = await t.run(async (ctx) =>
      await ctx.db
        .query("users")
        .withIndex("by_userId", (q) => q.eq("userId", "u-tag-only"))
        .unique(),
    );
    const primaryOnly = await t.run(async (ctx) =>
      await ctx.db
        .query("users")
        .withIndex("by_userId", (q) => q.eq("userId", "u-primary-only"))
        .unique(),
    );
    expect(tagOnly?.localeTag).toBe("fr-CA");
    expect(tagOnly?.localePrimary).toBeUndefined();
    expect(primaryOnly?.localeTag).toBeUndefined();
    expect(primaryOnly?.localePrimary).toBe("en");
  });
});
