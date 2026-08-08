import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");

const USER_A = {
  subject: "user-test-a",
  tokenIdentifier: "clerk|user-test-a",
  email: "alice@example.com",
};
const USER_B = {
  subject: "user-test-b",
  tokenIdentifier: "clerk|user-test-b",
  email: "bob@example.com",
};

describe("users:ensureRecord — auth gate", () => {
  test("unauthenticated → returns {ok:false, reason:'unauthenticated'}", async () => {
    const t = convexTest(schema, modules);
    const result = await t.mutation(api.users.ensureRecord, {
      localeTag: "en-US",
      localePrimary: "en",
    });
    expect(result).toEqual({ ok: false, reason: "unauthenticated" });
  });
});

describe("users:ensureRecord — happy paths", () => {
  test("first call inserts row with all fields + firstSeenAt === lastSeenAt", async () => {
    const t = convexTest(schema, modules);
    const asA = t.withIdentity(USER_A);
    const result = await asA.mutation(api.users.ensureRecord, {
      localeTag: "en-US",
      localePrimary: "en",
      timezone: "America/New_York",
      country: "US",
    });
    expect(result.ok).toBe(true);
    expect(result.action).toBe("inserted");

    const row = await t.run(async (ctx) =>
      await ctx.db
        .query("users")
        .withIndex("by_userId", (q) => q.eq("userId", USER_A.subject))
        .unique(),
    );
    expect(row).not.toBeNull();
    expect(row?.userId).toBe(USER_A.subject);
    expect(row?.email).toBe(USER_A.email);
    expect(row?.normalizedEmail).toBe(USER_A.email.toLowerCase());
    expect(row?.localeTag).toBe("en-US");
    expect(row?.localePrimary).toBe("en");
    expect(row?.timezone).toBe("America/New_York");
    expect(row?.country).toBe("US");
    expect(row?.firstSeenAt).toBe(row?.lastSeenAt);
  });

  test("second call patches locale + lastSeenAt; preserves firstSeenAt", async () => {
    const t = convexTest(schema, modules);
    const asA = t.withIdentity(USER_A);
    await asA.mutation(api.users.ensureRecord, {
      localeTag: "en-US",
      localePrimary: "en",
      timezone: "America/New_York",
    });
    const before = await t.run(async (ctx) =>
      await ctx.db
        .query("users")
        .withIndex("by_userId", (q) => q.eq("userId", USER_A.subject))
        .unique(),
    );

    // Brief pause to ensure now() advances.
    await new Promise((r) => setTimeout(r, 5));

    const result = await asA.mutation(api.users.ensureRecord, {
      localeTag: "zh-CN",
      localePrimary: "zh",
    });
    expect(result.ok).toBe(true);
    expect(result.action).toBe("patched");

    const after = await t.run(async (ctx) =>
      await ctx.db
        .query("users")
        .withIndex("by_userId", (q) => q.eq("userId", USER_A.subject))
        .unique(),
    );
    expect(after?.localeTag).toBe("zh-CN");
    expect(after?.localePrimary).toBe("zh");
    // timezone NOT in second call → preserved
    expect(after?.timezone).toBe("America/New_York");
    expect(after?.firstSeenAt).toBe(before?.firstSeenAt);
    expect(after?.lastSeenAt).toBeGreaterThan(before?.lastSeenAt ?? 0);
  });

  test("partial args (only locale) inserts without timezone/country", async () => {
    const t = convexTest(schema, modules);
    const asA = t.withIdentity(USER_A);
    await asA.mutation(api.users.ensureRecord, {
      localeTag: "fr-FR",
      localePrimary: "fr",
    });
    const row = await t.run(async (ctx) =>
      await ctx.db
        .query("users")
        .withIndex("by_userId", (q) => q.eq("userId", USER_A.subject))
        .unique(),
    );
    expect(row?.localeTag).toBe("fr-FR");
    expect(row?.timezone).toBeUndefined();
    expect(row?.country).toBeUndefined();
  });
});

describe("users:ensureRecord — validation rejects malformed input", () => {
  test("invalid localeTag → invalid-input, no row created", async () => {
    const t = convexTest(schema, modules);
    const asA = t.withIdentity(USER_A);
    const result = await asA.mutation(api.users.ensureRecord, {
      localeTag: "../etc/passwd",
      localePrimary: "en",
    });
    expect(result).toEqual({ ok: false, reason: "invalid-input", field: "localeTag" });
    const row = await t.run(async (ctx) =>
      await ctx.db
        .query("users")
        .withIndex("by_userId", (q) => q.eq("userId", USER_A.subject))
        .unique(),
    );
    expect(row).toBeNull();
  });

  test("invalid localePrimary → invalid-input", async () => {
    const t = convexTest(schema, modules);
    const asA = t.withIdentity(USER_A);
    const result = await asA.mutation(api.users.ensureRecord, {
      localeTag: "en-US",
      localePrimary: "EN", // uppercase rejected
    });
    expect(result).toEqual({ ok: false, reason: "invalid-input", field: "localePrimary" });
  });

  test("invalid timezone → invalid-input", async () => {
    const t = convexTest(schema, modules);
    const asA = t.withIdentity(USER_A);
    const result = await asA.mutation(api.users.ensureRecord, {
      localeTag: "en-US",
      localePrimary: "en",
      timezone: "Mars/Olympus",
    });
    expect(result).toEqual({ ok: false, reason: "invalid-input", field: "timezone" });
  });

  test("invalid country (3 chars) → invalid-input", async () => {
    const t = convexTest(schema, modules);
    const asA = t.withIdentity(USER_A);
    const result = await asA.mutation(api.users.ensureRecord, {
      localeTag: "en-US",
      localePrimary: "en",
      country: "USA",
    });
    expect(result).toEqual({ ok: false, reason: "invalid-input", field: "country" });
  });

  test("oversized localeTag (>64 chars) → invalid-input (length-bound BEFORE regex)", async () => {
    const t = convexTest(schema, modules);
    const asA = t.withIdentity(USER_A);
    const giant = "en" + "-" + "x".repeat(80);
    const result = await asA.mutation(api.users.ensureRecord, {
      localeTag: giant,
      localePrimary: "en",
    });
    expect(result).toEqual({ ok: false, reason: "invalid-input", field: "localeTag" });
  });
});

describe("users:ensureRecord — email policy", () => {
  test("email refresh on identity change (refresh on non-empty)", async () => {
    const t = convexTest(schema, modules);
    const asOldEmail = t.withIdentity({
      subject: USER_A.subject,
      tokenIdentifier: USER_A.tokenIdentifier,
      email: "old@a.com",
    });
    await asOldEmail.mutation(api.users.ensureRecord, {
      localeTag: "en-US",
      localePrimary: "en",
    });

    const asNewEmail = t.withIdentity({
      subject: USER_A.subject,
      tokenIdentifier: USER_A.tokenIdentifier,
      email: "new@b.com",
    });
    await asNewEmail.mutation(api.users.ensureRecord, {
      localeTag: "en-US",
      localePrimary: "en",
    });

    const row = await t.run(async (ctx) =>
      await ctx.db
        .query("users")
        .withIndex("by_userId", (q) => q.eq("userId", USER_A.subject))
        .unique(),
    );
    expect(row?.email).toBe("new@b.com");
    expect(row?.normalizedEmail).toBe("new@b.com");
  });

  test("email empty in identity → does NOT blank existing email", async () => {
    const t = convexTest(schema, modules);
    const asWithEmail = t.withIdentity({
      subject: USER_A.subject,
      tokenIdentifier: USER_A.tokenIdentifier,
      email: "alice@example.com",
    });
    await asWithEmail.mutation(api.users.ensureRecord, {
      localeTag: "en-US",
      localePrimary: "en",
    });

    // Second call with empty email (transient gap during email-change flow).
    const asEmptyEmail = t.withIdentity({
      subject: USER_A.subject,
      tokenIdentifier: USER_A.tokenIdentifier,
      email: "",
    });
    await asEmptyEmail.mutation(api.users.ensureRecord, {
      localeTag: "en-US",
      localePrimary: "en",
    });

    const row = await t.run(async (ctx) =>
      await ctx.db
        .query("users")
        .withIndex("by_userId", (q) => q.eq("userId", USER_A.subject))
        .unique(),
    );
    expect(row?.email).toBe("alice@example.com");
    expect(row?.normalizedEmail).toBe("alice@example.com");
  });

  test("identity with no email at insert → row created without email; later call fills it", async () => {
    const t = convexTest(schema, modules);
    const asNoEmail = t.withIdentity({
      subject: USER_A.subject,
      tokenIdentifier: USER_A.tokenIdentifier,
      // no email
    });
    await asNoEmail.mutation(api.users.ensureRecord, {
      localeTag: "en-US",
      localePrimary: "en",
    });

    const rowBefore = await t.run(async (ctx) =>
      await ctx.db
        .query("users")
        .withIndex("by_userId", (q) => q.eq("userId", USER_A.subject))
        .unique(),
    );
    expect(rowBefore?.email).toBeUndefined();

    const asWithEmail = t.withIdentity({
      subject: USER_A.subject,
      tokenIdentifier: USER_A.tokenIdentifier,
      email: "alice@example.com",
    });
    await asWithEmail.mutation(api.users.ensureRecord, {
      localeTag: "en-US",
      localePrimary: "en",
    });

    const rowAfter = await t.run(async (ctx) =>
      await ctx.db
        .query("users")
        .withIndex("by_userId", (q) => q.eq("userId", USER_A.subject))
        .unique(),
    );
    expect(rowAfter?.email).toBe("alice@example.com");
  });
});

describe("users:ensureRecord — idempotency invariants", () => {
  test("5 sequential calls for same userId → exactly 1 row", async () => {
    const t = convexTest(schema, modules);
    const asA = t.withIdentity(USER_A);
    for (let i = 0; i < 5; i++) {
      await asA.mutation(api.users.ensureRecord, {
        localeTag: "en-US",
        localePrimary: "en",
      });
    }
    const rows = await t.run(async (ctx) =>
      await ctx.db
        .query("users")
        .withIndex("by_userId", (q) => q.eq("userId", USER_A.subject))
        .collect(),
    );
    expect(rows.length).toBe(1);
  });

  test("different users get separate rows", async () => {
    const t = convexTest(schema, modules);
    await t.withIdentity(USER_A).mutation(api.users.ensureRecord, {
      localeTag: "en-US",
      localePrimary: "en",
    });
    await t.withIdentity(USER_B).mutation(api.users.ensureRecord, {
      localeTag: "fr-FR",
      localePrimary: "fr",
    });
    const all = await t.run(async (ctx) =>
      await ctx.db.query("users").collect(),
    );
    expect(all.length).toBe(2);
    const localesByUserId = Object.fromEntries(
      all.map((r) => [r.userId, r.localePrimary]),
    );
    expect(localesByUserId[USER_A.subject]).toBe("en");
    expect(localesByUserId[USER_B.subject]).toBe("fr");
  });
});
