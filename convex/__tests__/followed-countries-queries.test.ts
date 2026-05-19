import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { COUNTRY_COUNT_PRIVACY_FLOOR } from "../constants";

const modules = import.meta.glob("../**/*.ts");

/**
 * Build a `convexTest` instance AND pre-seed `followedCountriesShards`
 * (Codex round-4 P0 v2). Same helper shape as
 * `followed-countries-mutations.test.ts`. Required for any test that
 * invokes `followCountry` / `unfollowCountry` / `mergeAnonymousLocal`.
 */
async function makeT(): Promise<ReturnType<typeof convexTest>> {
  const t = convexTest(schema, modules);
  await t.mutation(internal.followedCountries._seedShards, {});
  return t;
}

const USER_A = {
  subject: "user-tests-fcq-A",
  tokenIdentifier: "clerk|user-tests-fcq-A",
};
const USER_B = {
  subject: "user-tests-fcq-B",
  tokenIdentifier: "clerk|user-tests-fcq-B",
};

/**
 * Seed a PRO entitlement so that follow mutations succeed past the
 * free-tier cap when the test needs >3 follows.
 */
async function seedProEntitlement(
  t: ReturnType<typeof convexTest>,
  userId: string,
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("entitlements", {
      userId,
      planKey: "pro_monthly",
      features: {
        tier: 1,
        maxDashboards: 10,
        apiAccess: true,
        apiRateLimit: 1000,
        prioritySupport: true,
        exportFormats: ["json", "csv"],
      },
      validUntil: Date.now() + 30 * 24 * 60 * 60 * 1000,
      updatedAt: Date.now(),
    });
  });
}

/**
 * Hand-seed N followers of `country` directly into the rows + counter
 * tables. Bypasses the mutation so we can synthesize arbitrary follower
 * sizes (3, 5, 7, ...) regardless of the free-tier cap.
 */
async function seedFollowers(
  t: ReturnType<typeof convexTest>,
  country: string,
  n: number,
): Promise<string[]> {
  const userIds: string[] = [];
  await t.run(async (ctx) => {
    const now = Date.now();
    for (let i = 0; i < n; i++) {
      const userId = `seeded-user-${country}-${i}`;
      userIds.push(userId);
      await ctx.db.insert("followedCountries", {
        userId,
        country,
        addedAt: now + i, // staggered so by_country pagination has a stable order
      });
    }
    if (n > 0) {
      await ctx.db.insert("followedCountriesCounts", {
        country,
        count: n,
        updatedAt: now,
      });
    }
  });
  return userIds;
}

// ---------------------------------------------------------------------------
// listFollowed — happy path, empty, no-auth, reactivity smoke
// ---------------------------------------------------------------------------

describe("listFollowed", () => {
  test("PRO user with ['US','GB'] (added in this order) → returns ['US','GB'] sorted by addedAt asc", async () => {
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);

    await asUser.mutation(api.followedCountries.followCountry, {
      country: "US",
    });
    // Tiny delay to make addedAt deterministic — convex-test uses real
    // Date.now(), so two back-to-back inserts CAN share a millisecond.
    // We stamp by addedAt, not insertion order, so equal stamps would
    // fall back on _id ordering. To make the test deterministic, hand-
    // patch the second insert's addedAt to be strictly later.
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "GB",
    });
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("followedCountries")
        .withIndex("by_user", (q) => q.eq("userId", USER_A.subject))
        .collect();
      const us = rows.find((r) => r.country === "US")!;
      const gb = rows.find((r) => r.country === "GB")!;
      // Force a strict ordering: US earlier than GB.
      await ctx.db.patch(us._id, { addedAt: 1000 });
      await ctx.db.patch(gb._id, { addedAt: 2000 });
    });

    const result = await asUser.query(api.followedCountries.listFollowed, {});
    expect(result).toEqual(["US", "GB"]);
  });

  test("user with 0 rows → []", async () => {
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);
    const result = await asUser.query(api.followedCountries.listFollowed, {});
    expect(result).toEqual([]);
  });

  test("unauthenticated → []", async () => {
    const t = await makeT();
    const result = await t.query(api.followedCountries.listFollowed, {});
    expect(result).toEqual([]);
  });

  test("reactivity smoke: add a row, query again sees the new row", async () => {
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);

    expect(
      await asUser.query(api.followedCountries.listFollowed, {}),
    ).toEqual([]);
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "FR",
    });
    expect(
      await asUser.query(api.followedCountries.listFollowed, {}),
    ).toEqual(["FR"]);
  });

  test("does NOT expose addedAt or userId — return is string[]", async () => {
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "US",
    });
    const result = await asUser.query(api.followedCountries.listFollowed, {});
    // string[] only; no objects.
    expect(Array.isArray(result)).toBe(true);
    for (const code of result) {
      expect(typeof code).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// countFollowers — happy path, privacy floor, validation, missing counter
// ---------------------------------------------------------------------------

describe("countFollowers", () => {
  test("7 followers (above privacy floor 5) → returns 7", async () => {
    const t = await makeT();
    await seedFollowers(t, "US", 7);

    const result = await t.query(api.followedCountries.countFollowers, {
      country: "US",
    });
    expect(result).toBe(7);
  });

  test("3 followers (below privacy floor 5) → returns 0", async () => {
    const t = await makeT();
    await seedFollowers(t, "US", 3);

    const result = await t.query(api.followedCountries.countFollowers, {
      country: "US",
    });
    expect(result).toBe(0);
  });

  test("exactly 5 followers (at privacy floor) → returns 5", async () => {
    const t = await makeT();
    await seedFollowers(t, "US", 5);

    const result = await t.query(api.followedCountries.countFollowers, {
      country: "US",
    });
    expect(result).toBe(5);
    // Sanity: the floor really is 5 (catches accidental constant drift).
    expect(COUNTRY_COUNT_PRIVACY_FLOOR).toBe(5);
  });

  test("exactly 4 followers (below privacy floor) → returns 0", async () => {
    const t = await makeT();
    await seedFollowers(t, "US", 4);

    const result = await t.query(api.followedCountries.countFollowers, {
      country: "US",
    });
    expect(result).toBe(0);
  });

  test("counter row absent → 0 (not an error)", async () => {
    const t = await makeT();
    // No seedFollowers — counter row simply doesn't exist.
    const result = await t.query(api.followedCountries.countFollowers, {
      country: "US",
    });
    expect(result).toBe(0);
  });

  test("invalid country 'INVALID' → INVALID_COUNTRY", async () => {
    const t = await makeT();
    await expect(
      t.query(api.followedCountries.countFollowers, { country: "INVALID" }),
    ).rejects.toThrow(/INVALID_COUNTRY/);
  });

  test("lowercase 'us' → INVALID_COUNTRY", async () => {
    const t = await makeT();
    await expect(
      t.query(api.followedCountries.countFollowers, { country: "us" }),
    ).rejects.toThrow(/INVALID_COUNTRY/);
  });

  test("regex-passing-but-not-in-registry 'XX' → INVALID_COUNTRY", async () => {
    const t = await makeT();
    await expect(
      t.query(api.followedCountries.countFollowers, { country: "XX" }),
    ).rejects.toThrow(/INVALID_COUNTRY/);
  });
});

// ---------------------------------------------------------------------------
// listFollowersPage — internal-only paginated cursor
// ---------------------------------------------------------------------------

describe("listFollowersPage (internal)", () => {
  test("country with 7 followers, limit=5 → first page 5 ids + nextCursor; second page 2 ids + nextCursor:null", async () => {
    const t = await makeT();
    const seededIds = await seedFollowers(t, "US", 7);

    const page1 = await t.query(
      internal.followedCountries.listFollowersPage,
      { country: "US", cursor: null, limit: 5 },
    );
    expect(page1.userIds).toHaveLength(5);
    expect(page1.nextCursor).not.toBeNull();
    // The five returned ids must be a subset of seeded ids.
    for (const id of page1.userIds) {
      expect(seededIds).toContain(id);
    }

    const page2 = await t.query(
      internal.followedCountries.listFollowersPage,
      { country: "US", cursor: page1.nextCursor, limit: 5 },
    );
    expect(page2.userIds).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();

    // Combined, the two pages cover all 7 seeded followers exactly once.
    const combined = new Set([...page1.userIds, ...page2.userIds]);
    expect(combined.size).toBe(7);
  });

  test("country with 0 followers → {userIds:[], nextCursor:null}", async () => {
    const t = await makeT();
    const result = await t.query(
      internal.followedCountries.listFollowersPage,
      { country: "US", cursor: null, limit: 50 },
    );
    expect(result.userIds).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  test("limit clamp: limit=10000 effectively clamps to 500", async () => {
    const t = await makeT();
    // Seed 600 followers to verify that limit=10000 returns at most 500.
    await seedFollowers(t, "US", 600);

    const result = await t.query(
      internal.followedCountries.listFollowersPage,
      { country: "US", cursor: null, limit: 10000 },
    );
    expect(result.userIds.length).toBeLessThanOrEqual(500);
    // We seeded 600, so the first page should return exactly 500 (the
    // clamp ceiling) and there must be more pages.
    expect(result.userIds.length).toBe(500);
    expect(result.nextCursor).not.toBeNull();
  });

  test("limit clamp: limit=0 clamps to 1 (returns at most 1 row)", async () => {
    const t = await makeT();
    await seedFollowers(t, "US", 5);

    const result = await t.query(
      internal.followedCountries.listFollowersPage,
      { country: "US", cursor: null, limit: 0 },
    );
    // Clamped to 1 — page returns exactly 1 row.
    expect(result.userIds.length).toBe(1);
    expect(result.nextCursor).not.toBeNull();
  });

  test("invalid country 'XX' → INVALID_COUNTRY", async () => {
    const t = await makeT();
    await expect(
      t.query(internal.followedCountries.listFollowersPage, {
        country: "XX",
        cursor: null,
        limit: 50,
      }),
    ).rejects.toThrow(/INVALID_COUNTRY/);
  });

  // Privacy contract: `listFollowersPage` is callable ONLY via
  // `internal.followedCountries.listFollowersPage`, NEVER via
  // `api.followedCountries.listFollowersPage`. The TypeScript codegen
  // splits the surfaces by declaration type — `internalQuery(...)`
  // declarations are type-filtered out of `api` via `FilterApi<...,
  // FunctionReference<any, "public">>`. The runtime `api`/`internal`
  // are both `anyApi` (a Proxy that lazily resolves any path), so the
  // distinction is enforced at compile time only — a public-tier
  // caller that types `api.followedCountries.listFollowersPage` is a
  // TS error.
  //
  // The two `@ts-expect-error` directives below are the actual privacy
  // assertion: TypeScript will FAIL to compile if these references
  // become valid (i.e. if someone ever changed `internalQuery` to
  // `query`). Conversely, removing the directives would fail the
  // typecheck today — TS knows the property doesn't exist on the
  // public surface.
  test("privacy: listFollowersPage is NOT exposed on api.followedCountries (type-level)", () => {
    // @ts-expect-error - listFollowersPage is internalQuery, NOT on api
    const publicRef = api.followedCountries.listFollowersPage;
    // Sanity: it IS exposed on the internal surface.
    const internalRef = internal.followedCountries.listFollowersPage;
    expect(internalRef).toBeDefined();
    // publicRef is the anyApi Proxy stub at runtime (truthy); the
    // privacy guarantee is the TS error suppressed above. We touch
    // the value here so eslint/biome don't strip the binding.
    void publicRef;
  });
});

// ---------------------------------------------------------------------------
// internalListFollowedForUser — used by the relay HTTP action
// ---------------------------------------------------------------------------

describe("internalListFollowedForUser", () => {
  test("returns the user's followed countries sorted by addedAt asc", async () => {
    const t = await makeT();
    // Hand-seed two rows for USER_A with explicit addedAt.
    await t.run(async (ctx) => {
      await ctx.db.insert("followedCountries", {
        userId: USER_A.subject,
        country: "GB",
        addedAt: 2000,
      });
      await ctx.db.insert("followedCountries", {
        userId: USER_A.subject,
        country: "US",
        addedAt: 1000,
      });
    });

    const result = await t.query(
      internal.followedCountries.internalListFollowedForUser,
      { userId: USER_A.subject },
    );
    // US (addedAt=1000) before GB (addedAt=2000).
    expect(result).toEqual(["US", "GB"]);
  });

  test("user with no rows → []", async () => {
    const t = await makeT();
    const result = await t.query(
      internal.followedCountries.internalListFollowedForUser,
      { userId: USER_B.subject },
    );
    expect(result).toEqual([]);
  });

  test("scopes correctly to userId — does NOT leak other users' rows", async () => {
    const t = await makeT();
    await t.run(async (ctx) => {
      await ctx.db.insert("followedCountries", {
        userId: USER_A.subject,
        country: "US",
        addedAt: 1000,
      });
      await ctx.db.insert("followedCountries", {
        userId: USER_B.subject,
        country: "GB",
        addedAt: 1000,
      });
    });

    const a = await t.query(
      internal.followedCountries.internalListFollowedForUser,
      { userId: USER_A.subject },
    );
    const b = await t.query(
      internal.followedCountries.internalListFollowedForUser,
      { userId: USER_B.subject },
    );
    expect(a).toEqual(["US"]);
    expect(b).toEqual(["GB"]);
  });
});
