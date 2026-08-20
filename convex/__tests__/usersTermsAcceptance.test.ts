/**
 * Which Terms did this customer accept, and when? (#6976)
 *
 * Before this, `users` held no answer — an enterprise buyer's counsel asking
 * "where does the user accept this?" got "nowhere". Acceptance is stamped at
 * the two moments a person is actually shown the documents: account creation
 * (Clerk renders the Terms/Privacy links on the sign-up card) and checkout
 * start (the assent line sits immediately above every CTA).
 *
 * The version is read from `shared/legal.ts` INSIDE the mutation rather than
 * passed in, so no caller can record a version that was never in effect.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import { TERMS_VERSION } from "../../shared/legal";

const modules = import.meta.glob("../**/*.ts");

const USER = {
  subject: "user-terms-a",
  tokenIdentifier: "clerk|user-terms-a",
  email: "alice@example.com",
};

const rowFor = (t: ReturnType<typeof convexTest>, userId: string) =>
  t.run(async (ctx) =>
    await ctx.db
      .query("users")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique(),
  );

describe("users:ensureRecord — assent at sign-up", () => {
  test("the first authenticated session stamps acceptance of the current Terms", async () => {
    const t = convexTest(schema, modules);
    const before = Date.now();
    await t.withIdentity(USER).mutation(api.users.ensureRecord, {
      localeTag: "en-US",
      localePrimary: "en",
    });

    const row = await rowFor(t, USER.subject);
    expect(row?.termsVersion).toBe(TERMS_VERSION);
    expect(row?.termsAcceptedAt).toBeGreaterThanOrEqual(before);
  });

  test("a returning session does not re-stamp — signing in is not accepting", async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity(USER);
    await asUser.mutation(api.users.ensureRecord, { localeTag: "en-US", localePrimary: "en" });
    const first = await rowFor(t, USER.subject);

    await new Promise((r) => setTimeout(r, 5));
    // A locale change forces a real patch, so the skip below is the acceptance
    // rule holding, not the no-op debounce hiding it.
    await asUser.mutation(api.users.ensureRecord, { localeTag: "fr-FR", localePrimary: "fr" });

    const second = await rowFor(t, USER.subject);
    expect(second?.localePrimary).toBe("fr");
    expect(second?.termsAcceptedAt).toBe(first?.termsAcceptedAt);
  });

  test("a pre-existing user with no acceptance is not backfilled by signing in", async () => {
    // Claiming assent from someone who was never shown the documents is worse
    // than an empty column.
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        userId: USER.subject,
        localeTag: "en-US",
        localePrimary: "en",
        firstSeenAt: now - 1_000_000,
        lastSeenAt: now - 1_000_000,
      });
    });

    await t.withIdentity(USER).mutation(api.users.ensureRecord, {
      localeTag: "en-US",
      localePrimary: "en",
    });

    const row = await rowFor(t, USER.subject);
    expect(row?.termsAcceptedAt).toBeUndefined();
    expect(row?.termsVersion).toBeUndefined();
  });
});

describe("users:recordTermsAcceptance — assent at checkout start", () => {
  test("stamps a user who has no record yet", async () => {
    // The /pro buyer path: pro-test has no Convex client, so a buyer who signs
    // in on the pricing page and checks out may never have run ensureRecord.
    const t = convexTest(schema, modules);
    const before = Date.now();
    const result = await t.mutation(internal.users.recordTermsAcceptance, {
      userId: "user-checkout-new",
      email: "buyer@example.com",
    });

    expect(result).toMatchObject({ ok: true, action: "inserted" });
    const row = await rowFor(t, "user-checkout-new");
    expect(row?.termsVersion).toBe(TERMS_VERSION);
    expect(row?.termsAcceptedAt).toBeGreaterThanOrEqual(before);
    expect(row?.email).toBe("buyer@example.com");
    expect(row?.normalizedEmail).toBe("buyer@example.com");
  });

  test("stamps an existing user who had never accepted", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        userId: "user-checkout-old",
        localePrimary: "en",
        firstSeenAt: now - 5_000,
        lastSeenAt: now - 5_000,
      });
    });

    const result = await t.mutation(internal.users.recordTermsAcceptance, {
      userId: "user-checkout-old",
    });

    expect(result).toMatchObject({ ok: true, action: "recorded" });
    const row = await rowFor(t, "user-checkout-old");
    expect(row?.termsVersion).toBe(TERMS_VERSION);
    expect(row?.localePrimary).toBe("en");
    expect(row?.firstSeenAt).toBe(now - 5_000);
  });

  test("re-accepting the same version is a read, so repeat checkouts cannot OCC-conflict", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.users.recordTermsAcceptance, { userId: "user-repeat" });
    const first = await rowFor(t, "user-repeat");

    await new Promise((r) => setTimeout(r, 5));
    const result = await t.mutation(internal.users.recordTermsAcceptance, { userId: "user-repeat" });

    expect(result).toMatchObject({ ok: true, action: "unchanged" });
    const second = await rowFor(t, "user-repeat");
    expect(second?.termsAcceptedAt).toBe(first?.termsAcceptedAt);
  });

  test("a stale accepted version is re-stamped to the version now in effect", async () => {
    // The case the whole feature exists for: the Terms changed, the buyer is
    // shown the new ones above the CTA, and the record has to follow.
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        userId: "user-stale-version",
        firstSeenAt: now - 90_000,
        lastSeenAt: now - 90_000,
        termsAcceptedAt: now - 90_000,
        termsVersion: "2020-01-01",
      });
    });

    const result = await t.mutation(internal.users.recordTermsAcceptance, {
      userId: "user-stale-version",
    });

    expect(result).toMatchObject({ ok: true, action: "recorded" });
    const row = await rowFor(t, "user-stale-version");
    expect(row?.termsVersion).toBe(TERMS_VERSION);
    expect(row?.termsAcceptedAt).toBeGreaterThan(now - 90_000);
  });

  test("an empty userId is refused rather than creating an unattributable record", async () => {
    const t = convexTest(schema, modules);
    const result = await t.mutation(internal.users.recordTermsAcceptance, { userId: "" });
    expect(result).toMatchObject({ ok: false, reason: "invalid-input" });

    const rows = await t.run(async (ctx) => await ctx.db.query("users").collect());
    expect(rows).toHaveLength(0);
  });
});

describe("checkout start records assent through the shared funnel", () => {
  /**
   * DODO_API_KEY / DODO_IDENTITY_SIGNING_SECRET are unset in the test env, so
   * `_createCheckoutSession` throws once it reaches the provider. That throw is
   * the proof the call got INTO the shared funnel — and the assent row it left
   * behind is the proof the recording happens before the provider, which is
   * where it belongs: assent is a fact about what the buyer was shown and
   * clicked, not about whether Dodo answered.
   */
  test("a Clerk buyer is stamped even when the provider call then fails", async () => {
    const t = convexTest(schema, modules);
    const before = Date.now();

    await expect(
      t.action(internal.payments.checkout.internalCreateCheckout, {
        userId: "user_assent_checkout",
        email: "buyer@example.com",
        productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      }),
    ).rejects.toThrow();

    const row = await rowFor(t, "user_assent_checkout");
    expect(row?.termsVersion).toBe(TERMS_VERSION);
    expect(row?.termsAcceptedAt).toBeGreaterThanOrEqual(before);
  });

  test("an anonymous buyer leaves no row — users is keyed by Clerk id", async () => {
    // A row keyed by an anon UUID could never be joined to a person. Their
    // assent lands on the first authenticated session after they claim the
    // subscription, via ensureRecord's insert branch.
    const t = convexTest(schema, modules);
    const anonId = "6f1b4f38-0b3f-4a4a-9f0e-2a1c5f8d7e21";

    await expect(
      t.action(internal.payments.checkout.internalCreateCheckout, {
        userId: anonId,
        productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      }),
    ).rejects.toThrow();

    const rows = await t.run(async (ctx) => await ctx.db.query("users").collect());
    expect(rows).toHaveLength(0);
  });

  test("a blocked checkout is refused before the funnel, so nothing is recorded", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: "user_assent_blocked",
        dodoSubscriptionId: "sub_assent_blocked",
        dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: now - 60_000,
        currentPeriodEnd: now + 30 * 24 * 60 * 60_000,
        rawPayload: {},
        updatedAt: now,
      });
    });

    const result = await t.action(internal.payments.checkout.internalCreateCheckout, {
      userId: "user_assent_blocked",
      productId: PRODUCT_CATALOG.pro_annual.dodoProductId!,
    });

    expect(result).toMatchObject({ blocked: true });
    const row = await rowFor(t, "user_assent_blocked");
    expect(row).toBeNull();
  });
});

describe("users:recordTermsAcceptance — first acceptance survives a version bump (#6983)", () => {
  test("sign-up stamps both timestamps to the same instant", async () => {
    const t = convexTest(schema, modules);
    await t.withIdentity(USER).mutation(api.users.ensureRecord, {
      localeTag: "en-US",
      localePrimary: "en",
    });

    const row = await rowFor(t, USER.subject);
    expect(row?.termsFirstAcceptedAt).toBe(row?.termsAcceptedAt);
    expect(row?.termsFirstAcceptedAt).toBeGreaterThan(0);
  });

  test("a new version moves termsAcceptedAt but never termsFirstAcceptedAt", async () => {
    const t = convexTest(schema, modules);
    await t.withIdentity(USER).mutation(api.users.ensureRecord, {
      localeTag: "en-US",
      localePrimary: "en",
    });
    const original = await rowFor(t, USER.subject);

    // Simulate the deploy that bumps TERMS_VERSION: the stored version is now
    // stale, so the next checkout re-stamps. This is exactly what #6983's
    // 2026-07-27 → 2026-08-20 bump does to every existing acceptance.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("users")
        .withIndex("by_userId", (q) => q.eq("userId", USER.subject))
        .unique();
      await ctx.db.patch(row!._id, { termsVersion: "1999-01-01" });
    });

    await t.mutation(internal.users.recordTermsAcceptance, { userId: USER.subject });

    const bumped = await rowFor(t, USER.subject);
    expect(bumped?.termsVersion).not.toBe("1999-01-01");
    expect(bumped?.termsFirstAcceptedAt).toBe(original?.termsFirstAcceptedAt);
    expect(bumped?.termsAcceptedAt).toBeGreaterThanOrEqual(original?.termsAcceptedAt ?? 0);
  });

  test("a row written before the field existed adopts the acceptance we can prove", async () => {
    const t = convexTest(schema, modules);
    const legacyAcceptedAt = 1_750_000_000_000;

    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        userId: USER.subject,
        firstSeenAt: legacyAcceptedAt,
        lastSeenAt: legacyAcceptedAt,
        termsAcceptedAt: legacyAcceptedAt,
        termsVersion: "2026-07-27",
      });
    });

    await t.mutation(internal.users.recordTermsAcceptance, { userId: USER.subject });

    const row = await rowFor(t, USER.subject);
    expect(row?.termsFirstAcceptedAt).toBe(legacyAcceptedAt);
  });

  test("checkout by a user with no row stamps both", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.users.recordTermsAcceptance, {
      userId: "user-never-ensured",
      email: "buyer@example.com",
    });

    const row = await rowFor(t, "user-never-ensured");
    expect(row?.termsFirstAcceptedAt).toBe(row?.termsAcceptedAt);
  });
});
