import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import {
  COUNTRY_COUNT_PRIVACY_FLOOR,
  FREE_TIER_FOLLOW_LIMIT,
  MAX_MERGE_INPUT,
  SHARD_COUNT,
} from "../constants";
import { _ISO2_REGISTRY_FOR_TESTS, isValidIso2 } from "../lib/iso2";
import { userIdToShard } from "../lib/shards";
import { ISO2_TO_ISO3 } from "../../src/utils/country-codes";

const modules = import.meta.glob("../**/*.ts");

/**
 * Build a `convexTest` instance AND pre-seed the
 * `followedCountriesShards` lock table — every `followCountry` /
 * `unfollowCountry` / `mergeAnonymousLocal` mutation throws
 * SHARDS_NOT_SEEDED without it (Codex round-4 P0 v2). All test fixtures
 * use this helper instead of calling `convexTest(schema, modules)`
 * directly so the seed pre-condition is uniform.
 */
async function makeT(): Promise<ReturnType<typeof convexTest>> {
  const t = convexTest(schema, modules);
  await t.mutation(internal.followedCountries._seedShards, {});
  return t;
}

const USER_A = {
  subject: "user-tests-fc-A",
  tokenIdentifier: "clerk|user-tests-fc-A",
};
const USER_B = {
  subject: "user-tests-fc-B",
  tokenIdentifier: "clerk|user-tests-fc-B",
};

/**
 * Seed a PRO entitlement for the given test user. Without this, the user
 * is treated as free-tier (tier=0) by `readEntitlementTier` since the
 * `entitlements` table starts empty under convex-test.
 */
async function seedProEntitlement(
  t: ReturnType<typeof convexTest>,
  userId: string,
  validUntil = Date.now() + 30 * 24 * 60 * 60 * 1000,
) {
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
      validUntil,
      updatedAt: Date.now(),
    });
  });
}

/**
 * Read the aggregate counter row for a country. Returns 0 if no row.
 * Mirrors the read-shape of the future `countFollowers` query (U14)
 * so the counter-maintenance tests assert against the same row the
 * production read path will use.
 */
async function readCounter(
  t: ReturnType<typeof convexTest>,
  country: string,
): Promise<number> {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query("followedCountriesCounts")
      .withIndex("by_country", (q) => q.eq("country", country))
      .first();
    return row?.count ?? 0;
  });
}

/**
 * Read a user's followed-country list as a sorted-by-addedAt array of
 * country codes. Used to assert post-mutation table state.
 */
async function readUserFollows(
  t: ReturnType<typeof convexTest>,
  userId: string,
): Promise<string[]> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("followedCountries")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return rows
      .sort((a, b) => a.addedAt - b.addedAt)
      .map((r) => r.country);
  });
}

/**
 * Read the per-user serialization row's denormalized count. Returns 0
 * if no row exists. Used to assert the cap-bypass parity invariant
 * (`userMeta.count === COUNT(followedCountries WHERE userId=X)`).
 */
async function readUserMetaCount(
  t: ReturnType<typeof convexTest>,
  userId: string,
): Promise<number> {
  return await t.run(async (ctx) => {
    const meta = await ctx.db
      .query("followedCountriesUserMeta")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    return meta?.count ?? 0;
  });
}

/**
 * Hand-seed the followed-countries table AND the per-user serialization
 * row so cap-check denominator is in parity. Use this in tests that need
 * a pre-existing row state without going through `followCountry`. Without
 * the user-meta seed, the cap check would read 0 (no meta row) and let
 * a free user past the cap — masking real regressions in cap enforcement.
 */
async function seedFollowedCountries(
  t: ReturnType<typeof convexTest>,
  userId: string,
  codes: string[],
): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    for (const country of codes) {
      await ctx.db.insert("followedCountries", { userId, country, addedAt: now });
    }
    await ctx.db.insert("followedCountriesUserMeta", {
      userId,
      count: codes.length,
      updatedAt: now,
    });
  });
}

// ---------------------------------------------------------------------------
// ISO-2 registry parity — the registry mirrored into convex/lib/iso2.ts
// MUST stay in lockstep with the keys of `ISO2_TO_ISO3` in
// `src/utils/country-codes.ts`. This test catches drift if either side is
// edited without the other.
// ---------------------------------------------------------------------------

describe("iso2 registry — sanity & boundary cases", () => {
  test("isValidIso2 accepts known ISO-2 codes", () => {
    for (const code of [
      "US",
      "GB",
      "FR",
      "DE",
      "JP",
      "CN",
      "BR",
      "AQ",
      "XK", // Kosovo (user-assigned but mirrored in client registry)
    ]) {
      expect(isValidIso2(code)).toBe(true);
    }
  });

  test("isValidIso2 rejects regex-passing-but-non-ISO-2 codes", () => {
    for (const code of ["XX", "ZZ", "EN", "UK"]) {
      expect(isValidIso2(code)).toBe(false);
    }
  });

  test("isValidIso2 rejects bad-shape input", () => {
    for (const code of [
      "us", // lowercase
      "USA", // alpha-3
      "U", // too short
      "USS", // too long
      "U1", // contains digit
      "", // empty
      " ", // whitespace
      " US",
      "US ",
    ]) {
      expect(isValidIso2(code)).toBe(false);
    }
  });

  test("registry has 239 canonical alpha-2 codes (matches client mirror)", () => {
    // If this number changes, update BOTH `convex/lib/iso2.ts` and
    // `src/utils/country-codes.ts::ISO2_TO_ISO3` together.
    expect(_ISO2_REGISTRY_FOR_TESTS.size).toBe(239);
  });

  test("registry === Object.keys(ISO2_TO_ISO3) (set equality, not size only)", () => {
    // P2 #13 — Catches drift where one registry has, e.g., 'XK' and the
    // other has 'EU' (same size, different content). Set-equality is the
    // only way to prove the two are in true lockstep.
    const serverSet = _ISO2_REGISTRY_FOR_TESTS;
    const clientSet = new Set(Object.keys(ISO2_TO_ISO3));
    const onlyInServer = [...serverSet].filter((c) => !clientSet.has(c));
    const onlyInClient = [...clientSet].filter((c) => !serverSet.has(c));
    expect(onlyInServer).toEqual([]);
    expect(onlyInClient).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// followCountry — happy path, idempotency, validation, free-tier cap
// ---------------------------------------------------------------------------

describe("followCountry — happy path & idempotency", () => {
  test("PRO user follows 'US' → row inserted, counter US=1, idempotent:false", async () => {
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);

    const result = await asUser.mutation(api.followedCountries.followCountry, {
      country: "US",
    });
    expect(result).toEqual({ ok: true, idempotent: false });
    expect(await readUserFollows(t, USER_A.subject)).toEqual(["US"]);
    expect(await readCounter(t, "US")).toBe(1);
  });

  test("PRO user calls followCountry('US') twice → second is idempotent, one row, counter still 1", async () => {
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);

    await asUser.mutation(api.followedCountries.followCountry, {
      country: "US",
    });
    const second = await asUser.mutation(api.followedCountries.followCountry, {
      country: "US",
    });
    expect(second).toEqual({ ok: true, idempotent: true });
    expect(await readUserFollows(t, USER_A.subject)).toEqual(["US"]);
    expect(await readCounter(t, "US")).toBe(1);
  });
});

describe("followCountry — free-tier cap", () => {
  test("free user with 2 rows → followCountry('US') succeeds; currentCount becomes 3", async () => {
    const t = await makeT();
    // No seedProEntitlement — user is free.
    const asUser = t.withIdentity(USER_A);
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "GB",
    });
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "JP",
    });
    const result = await asUser.mutation(api.followedCountries.followCountry, {
      country: "US",
    });
    expect(result).toEqual({ ok: true, idempotent: false });
    expect(await readUserFollows(t, USER_A.subject)).toEqual(["GB", "JP", "US"]);
  });

  test("free user with 3 rows → followCountry('FR') throws FREE_CAP with currentCount=3, limit=3", async () => {
    const t = await makeT();
    const asUser = t.withIdentity(USER_A);
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "GB",
    });
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "JP",
    });
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "DE",
    });

    await expect(
      asUser.mutation(api.followedCountries.followCountry, {
        country: "FR",
      }),
    ).rejects.toThrow(/FREE_CAP/);
    // Counter for FR must NOT have been incremented (atomicity).
    expect(await readCounter(t, "FR")).toBe(0);
    expect(await readUserFollows(t, USER_A.subject)).toEqual([
      "GB",
      "JP",
      "DE",
    ]);
  });

  test("expired entitlement is treated as free-tier", async () => {
    const t = await makeT();
    // Expired entitlement = free.
    await seedProEntitlement(t, USER_A.subject, Date.now() - 1000);
    const asUser = t.withIdentity(USER_A);
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "GB",
    });
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "JP",
    });
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "DE",
    });
    await expect(
      asUser.mutation(api.followedCountries.followCountry, {
        country: "FR",
      }),
    ).rejects.toThrow(/FREE_CAP/);
  });
});

describe("followCountry — tier-first skip-collect optimization (P3 #21)", () => {
  test("PRO user with many existing rows is never blocked by FREE_CAP — collect() not called for cap check", async () => {
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);
    // Hand-seed 10 rows (> FREE_TIER_FOLLOW_LIMIT) to prove the PRO path
    // doesn't inspect the existing row count for cap enforcement.
    const seedCodes = ["GB", "JP", "DE", "FR", "IT", "ES", "PT", "NL", "BE", "CH"];
    await t.run(async (ctx) => {
      for (const country of seedCodes) {
        await ctx.db.insert("followedCountries", {
          userId: USER_A.subject,
          country,
          addedAt: Date.now(),
        });
      }
    });
    // 11th follow should still succeed: PRO has no cap.
    const result = await asUser.mutation(api.followedCountries.followCountry, {
      country: "US",
    });
    expect(result).toEqual({ ok: true, idempotent: false });
  });
});

describe("followCountry — auth & input validation", () => {
  test("unauthenticated → UNAUTHENTICATED", async () => {
    const t = await makeT();
    await expect(
      t.mutation(api.followedCountries.followCountry, { country: "US" }),
    ).rejects.toThrow(/UNAUTHENTICATED/);
  });

  test("invalid ISO-2 inputs all throw INVALID_COUNTRY", async () => {
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);
    for (const bad of ["us", "USA", "XX", "EN", "UK", "", " "]) {
      await expect(
        asUser.mutation(api.followedCountries.followCountry, {
          country: bad,
        }),
      ).rejects.toThrow(/INVALID_COUNTRY/);
    }
  });
});

// ---------------------------------------------------------------------------
// unfollowCountry — happy path, idempotency, counter decrement
// ---------------------------------------------------------------------------

describe("unfollowCountry — happy path & idempotency", () => {
  test("existing row → deleted, counter -1, idempotent:false", async () => {
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "US",
    });
    expect(await readCounter(t, "US")).toBe(1);

    const result = await asUser.mutation(
      api.followedCountries.unfollowCountry,
      { country: "US" },
    );
    expect(result).toEqual({ ok: true, idempotent: false });
    expect(await readUserFollows(t, USER_A.subject)).toEqual([]);
    expect(await readCounter(t, "US")).toBe(0);
  });

  test("absent row → idempotent:true, counter NOT touched", async () => {
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);

    const result = await asUser.mutation(
      api.followedCountries.unfollowCountry,
      { country: "US" },
    );
    expect(result).toEqual({ ok: true, idempotent: true });
    // Counter row should not exist (read returns 0 because row absent).
    expect(await readCounter(t, "US")).toBe(0);
  });

  test("second unfollow on already-deleted row → idempotent:true", async () => {
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "US",
    });
    await asUser.mutation(api.followedCountries.unfollowCountry, {
      country: "US",
    });
    const second = await asUser.mutation(
      api.followedCountries.unfollowCountry,
      { country: "US" },
    );
    expect(second).toEqual({ ok: true, idempotent: true });
    expect(await readCounter(t, "US")).toBe(0);
  });

  test("unauthenticated → UNAUTHENTICATED", async () => {
    const t = await makeT();
    await expect(
      t.mutation(api.followedCountries.unfollowCountry, { country: "US" }),
    ).rejects.toThrow(/UNAUTHENTICATED/);
  });

  test("invalid ISO-2 → INVALID_COUNTRY", async () => {
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);
    await expect(
      asUser.mutation(api.followedCountries.unfollowCountry, {
        country: "XX",
      }),
    ).rejects.toThrow(/INVALID_COUNTRY/);
  });
});

// ---------------------------------------------------------------------------
// Counter scenarios — multi-user / never-negative
// ---------------------------------------------------------------------------

describe("counter maintenance — multi-user", () => {
  test("two different users following 'US' → counter 0→1→2; unfollows → 2→1→0", async () => {
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    await seedProEntitlement(t, USER_B.subject);
    const asA = t.withIdentity(USER_A);
    const asB = t.withIdentity(USER_B);

    expect(await readCounter(t, "US")).toBe(0);
    await asA.mutation(api.followedCountries.followCountry, {
      country: "US",
    });
    expect(await readCounter(t, "US")).toBe(1);
    await asB.mutation(api.followedCountries.followCountry, {
      country: "US",
    });
    expect(await readCounter(t, "US")).toBe(2);

    await asA.mutation(api.followedCountries.unfollowCountry, {
      country: "US",
    });
    expect(await readCounter(t, "US")).toBe(1);
    await asB.mutation(api.followedCountries.unfollowCountry, {
      country: "US",
    });
    expect(await readCounter(t, "US")).toBe(0);
  });

  test("counter never goes below 0 (defensive max-with-zero)", async () => {
    const t = await makeT();
    // Hand-seed a 0-count counter row to simulate drift.
    await t.run(async (ctx) => {
      await ctx.db.insert("followedCountriesCounts", {
        country: "US",
        count: 0,
        updatedAt: Date.now(),
      });
    });
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);
    // Hand-insert a row WITHOUT touching the counter, to simulate drift.
    await t.run(async (ctx) => {
      await ctx.db.insert("followedCountries", {
        userId: USER_A.subject,
        country: "US",
        addedAt: Date.now(),
      });
    });
    // Counter row exists at 0; unfollow decrements via Math.max(0, count-1).
    await asUser.mutation(api.followedCountries.unfollowCountry, {
      country: "US",
    });
    expect(await readCounter(t, "US")).toBe(0);
  });
});

describe("counter maintenance — idempotency does NOT double-count", () => {
  test("follow same country twice → counter +1, not +2", async () => {
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);

    await asUser.mutation(api.followedCountries.followCountry, {
      country: "US",
    });
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "US",
    });
    expect(await readCounter(t, "US")).toBe(1);
  });

  test("unfollow absent row → counter NOT decremented", async () => {
    const t = await makeT();
    // User-A follows US; user-B then unfollows US (which they never followed).
    // User-B's unfollow should be idempotent and NOT touch the counter.
    await seedProEntitlement(t, USER_A.subject);
    await seedProEntitlement(t, USER_B.subject);
    const asA = t.withIdentity(USER_A);
    const asB = t.withIdentity(USER_B);

    await asA.mutation(api.followedCountries.followCountry, {
      country: "US",
    });
    expect(await readCounter(t, "US")).toBe(1);
    await asB.mutation(api.followedCountries.unfollowCountry, {
      country: "US",
    });
    expect(await readCounter(t, "US")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// mergeAnonymousLocal — happy paths, cap, validation, dedup
// ---------------------------------------------------------------------------

describe("mergeAnonymousLocal — PRO happy path", () => {
  test("PRO user has ['US'], input ['GB','JP'] → final ['US','GB','JP']", async () => {
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);

    await asUser.mutation(api.followedCountries.followCountry, {
      country: "US",
    });

    const result = await asUser.mutation(
      api.followedCountries.mergeAnonymousLocal,
      { countries: ["GB", "JP"] },
    );
    expect(result).toEqual({
      totalCount: 3,
      accepted: ["GB", "JP"],
      droppedInvalid: [],
      droppedDueToCap: [],
    });
    expect(await readUserFollows(t, USER_A.subject)).toEqual([
      "US",
      "GB",
      "JP",
    ]);
    expect(await readCounter(t, "GB")).toBe(1);
    expect(await readCounter(t, "JP")).toBe(1);
  });

  test("PRO user with no rows, input ['US','US','US'] → canonicalize to ['US']; one row; counter +1", async () => {
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);

    const result = await asUser.mutation(
      api.followedCountries.mergeAnonymousLocal,
      { countries: ["US", "US", "US"] },
    );
    expect(result).toEqual({
      totalCount: 1,
      accepted: ["US"],
      droppedInvalid: [],
      droppedDueToCap: [],
    });
    expect(await readUserFollows(t, USER_A.subject)).toEqual(["US"]);
    expect(await readCounter(t, "US")).toBe(1);
  });
});

describe("mergeAnonymousLocal — free-tier cap", () => {
  test("free user with ['US'] (1), input ['GB','JP','CN'] → accept first 2; CN to droppedDueToCap", async () => {
    const t = await makeT();
    const asUser = t.withIdentity(USER_A);
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "US",
    });

    const result = await asUser.mutation(
      api.followedCountries.mergeAnonymousLocal,
      { countries: ["GB", "JP", "CN"] },
    );
    expect(result).toEqual({
      totalCount: 3,
      accepted: ["GB", "JP"],
      droppedInvalid: [],
      droppedDueToCap: ["CN"],
    });
    expect(await readUserFollows(t, USER_A.subject)).toEqual([
      "US",
      "GB",
      "JP",
    ]);
    // Counter for CN must NOT have been incremented.
    expect(await readCounter(t, "CN")).toBe(0);
  });

  test("free user already at cap → accepted=[], all to droppedDueToCap", async () => {
    const t = await makeT();
    const asUser = t.withIdentity(USER_A);
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "US",
    });
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "GB",
    });
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "JP",
    });

    const result = await asUser.mutation(
      api.followedCountries.mergeAnonymousLocal,
      { countries: ["CN", "FR"] },
    );
    expect(result).toEqual({
      totalCount: 3,
      accepted: [],
      droppedInvalid: [],
      droppedDueToCap: ["CN", "FR"],
    });
    expect(await readUserFollows(t, USER_A.subject)).toEqual([
      "US",
      "GB",
      "JP",
    ]);
    expect(await readCounter(t, "CN")).toBe(0);
    expect(await readCounter(t, "FR")).toBe(0);
  });

  test("abuse — free user posts 50-element array → cap fits only (3 - existing); final NEVER exceeds 3", async () => {
    const t = await makeT();
    const asUser = t.withIdentity(USER_A);
    // Existing = 0; cap = 3 should fit.
    const big = Array.from({ length: 50 }, (_, i) => {
      // generate 50 distinct valid ISO-2 codes from the registry
      const codes = [
        "US",
        "GB",
        "JP",
        "FR",
        "DE",
        "IT",
        "ES",
        "PT",
        "NL",
        "BE",
        "CH",
        "AT",
        "SE",
        "NO",
        "DK",
        "FI",
        "PL",
        "CZ",
        "HU",
        "GR",
        "RO",
        "BG",
        "IE",
        "LU",
        "MT",
        "CY",
        "SI",
        "SK",
        "EE",
        "LV",
        "LT",
        "HR",
        "BR",
        "AR",
        "MX",
        "CL",
        "PE",
        "CO",
        "VE",
        "UY",
        "PY",
        "BO",
        "EC",
        "ZA",
        "EG",
        "MA",
        "DZ",
        "TN",
        "KE",
        "NG",
      ];
      return codes[i];
    }) as string[];
    expect(big).toHaveLength(50);

    const result = await asUser.mutation(
      api.followedCountries.mergeAnonymousLocal,
      { countries: big },
    );
    expect(result.accepted).toHaveLength(FREE_TIER_FOLLOW_LIMIT);
    expect(result.totalCount).toBe(FREE_TIER_FOLLOW_LIMIT);
    // 47 of the remaining 50 codes should have ended up in droppedDueToCap.
    expect(result.droppedDueToCap).toHaveLength(50 - FREE_TIER_FOLLOW_LIMIT);
    expect(result.droppedInvalid).toEqual([]);
    expect(await readUserFollows(t, USER_A.subject)).toHaveLength(
      FREE_TIER_FOLLOW_LIMIT,
    );
  });
});

describe("mergeAnonymousLocal — input validation", () => {
  test("oversized input (200 elements) → INPUT_TOO_LARGE", async () => {
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);

    const big = Array.from({ length: 200 }, () => "US");
    expect(big.length).toBeGreaterThan(MAX_MERGE_INPUT);
    await expect(
      asUser.mutation(api.followedCountries.mergeAnonymousLocal, {
        countries: big,
      }),
    ).rejects.toThrow(/INPUT_TOO_LARGE/);
    // No rows inserted.
    expect(await readUserFollows(t, USER_A.subject)).toEqual([]);
  });

  test("empty input → EMPTY_INPUT", async () => {
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);
    await expect(
      asUser.mutation(api.followedCountries.mergeAnonymousLocal, {
        countries: [],
      }),
    ).rejects.toThrow(/EMPTY_INPUT/);
  });

  test("unauthenticated → UNAUTHENTICATED", async () => {
    const t = await makeT();
    await expect(
      t.mutation(api.followedCountries.mergeAnonymousLocal, {
        countries: ["US"],
      }),
    ).rejects.toThrow(/UNAUTHENTICATED/);
  });

  test("input ['US','xx','United States'] → accepted=['US'], droppedInvalid=['xx','United States']", async () => {
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);

    const result = await asUser.mutation(
      api.followedCountries.mergeAnonymousLocal,
      { countries: ["US", "xx", "United States"] },
    );
    expect(result).toEqual({
      totalCount: 1,
      accepted: ["US"],
      droppedInvalid: ["xx", "United States"],
      droppedDueToCap: [],
    });
  });

  test("mixed valid/invalid + duplicates: ['US','us','US','XX','GB'] → drops 'us'+'XX'; canonicalizes valid to ['US','GB']", async () => {
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);

    const result = await asUser.mutation(
      api.followedCountries.mergeAnonymousLocal,
      { countries: ["US", "us", "US", "XX", "GB"] },
    );
    expect(result.accepted).toEqual(["US", "GB"]);
    expect(result.droppedInvalid).toEqual(["us", "XX"]);
    expect(result.droppedDueToCap).toEqual([]);
    expect(result.totalCount).toBe(2);
  });
});

describe("mergeAnonymousLocal — duplicate inputs free-tier near-cap", () => {
  test("free user with no rows, input ['US','US','GB','GB','JP','CN'] → cap accepts first 3 unique; CN to droppedDueToCap", async () => {
    const t = await makeT();
    const asUser = t.withIdentity(USER_A);

    const result = await asUser.mutation(
      api.followedCountries.mergeAnonymousLocal,
      { countries: ["US", "US", "GB", "GB", "JP", "CN"] },
    );
    expect(result).toEqual({
      totalCount: 3,
      accepted: ["US", "GB", "JP"],
      droppedInvalid: [],
      droppedDueToCap: ["CN"],
    });
    expect(await readUserFollows(t, USER_A.subject)).toEqual([
      "US",
      "GB",
      "JP",
    ]);
    expect(await readCounter(t, "US")).toBe(1);
    expect(await readCounter(t, "GB")).toBe(1);
    expect(await readCounter(t, "JP")).toBe(1);
    expect(await readCounter(t, "CN")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sanity: COUNTRY_COUNT_PRIVACY_FLOOR is imported from convex/constants
// (queries land in U14 — this constant is used there, not here, but the
// import path must be live so U14 doesn't break).
// ---------------------------------------------------------------------------
describe("constants — sanity", () => {
  test("COUNTRY_COUNT_PRIVACY_FLOOR is a positive integer", () => {
    expect(Number.isInteger(COUNTRY_COUNT_PRIVACY_FLOOR)).toBe(true);
    expect(COUNTRY_COUNT_PRIVACY_FLOOR).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Per-user serialization (cap-bypass mitigation, Codex round-3 P0)
//
// Convex per-document OCC tracks reads at the document level, NOT at the
// index-range level. Without a per-user serialization document, two
// parallel `followCountry` mutations from the SAME user can both pass the
// cap check on a stale denominator and both insert — bypassing the free
// cap and potentially creating duplicate (userId, country) rows.
//
// CONCURRENCY-SIMULATION CAVEAT (convex-test 0.0.43):
//   `convex-test`'s TransactionManager (node_modules/convex-test/dist/
//   index.js:1268) takes a single `_waitOnCurrentFunction` lock at the
//   start of each top-level mutation, so `Promise.all([t.mutation(...),
//   t.mutation(...)])` runs strictly sequentially even though the test
//   author expresses parallelism. There is NO real OCC retry mechanism
//   in the mock — the second mutation begins after the first commits.
//
//   What this means: tests CANNOT prove "loser retries and re-reads"
//   directly. What they CAN prove is the FINAL-STATE INVARIANT — even
//   when the second mutation runs back-to-back against the post-winner
//   state, the cap, idempotency, and meta-parity invariants hold. In
//   production, Convex's real OCC layer turns the same final-state
//   invariant into the cap-bypass guarantee: the loser retries against
//   the winner's commit and behaves exactly like the sequential second
//   call here. So if these tests pass AND the meta read/write happens on
//   every mutation path, the production fix holds.
//
//   See `convex-occ-retry-vs-app-cas-conflict-different-layers` (memory)
//   for the layer separation; this test suite is the app-side invariant
//   layer, the OCC retry is the platform layer we trust.
// ---------------------------------------------------------------------------

describe("per-user serialization — cap-bypass mitigation (P0)", () => {
  test("concurrent same-user same-country: Promise.all of 2 followCountry('US') → exactly 1 row, counter=1, meta=1, second is idempotent", async () => {
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);

    const [r1, r2] = await Promise.all([
      asUser.mutation(api.followedCountries.followCountry, { country: "US" }),
      asUser.mutation(api.followedCountries.followCountry, { country: "US" }),
    ]);

    // Exactly one of the two saw idempotent:false, the other idempotent:true.
    // Order is implementation-defined under convex-test's serialization;
    // we don't pin which one wins.
    const idempotent = [r1.idempotent, r2.idempotent].sort();
    expect(idempotent).toEqual([false, true]);

    expect(await readUserFollows(t, USER_A.subject)).toEqual(["US"]);
    expect(await readCounter(t, "US")).toBe(1);
    expect(await readUserMetaCount(t, USER_A.subject)).toBe(1);
  });

  test("concurrent same-user cap-boundary: free user with 2 rows + Promise.all(follow('GB'), follow('JP')) → at most 3 rows, cap holds", async () => {
    const t = await makeT();
    // Free user (no PRO). Seed 2 of 3 cap slots.
    await seedFollowedCountries(t, USER_A.subject, ["US", "DE"]);
    const asUser = t.withIdentity(USER_A);

    // Both calls target NEW countries. Under our fix: post-serialization,
    // second call sees count=3 if the first succeeded, throws FREE_CAP.
    const results = await Promise.allSettled([
      asUser.mutation(api.followedCountries.followCountry, { country: "GB" }),
      asUser.mutation(api.followedCountries.followCountry, { country: "JP" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Either both fit (one succeeded → cap reached → second throws) OR
    // both succeed because cap is exactly 3 and seeds put us at 2; here
    // (2 + 2 attempts = 4 attempted, cap=3) → exactly one succeeds and
    // one throws FREE_CAP.
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(
      /FREE_CAP/,
    );

    // Final row count must NEVER exceed cap.
    const finalCount = (await readUserFollows(t, USER_A.subject)).length;
    expect(finalCount).toBeLessThanOrEqual(FREE_TIER_FOLLOW_LIMIT);
    expect(finalCount).toBe(3); // 2 seeded + 1 winner
    expect(await readUserMetaCount(t, USER_A.subject)).toBe(finalCount);
  });

  test("concurrent same-user mixed follow/unfollow on US: final state is consistent (count matches row count, no orphans)", async () => {
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    // Seed US so unfollow has something to remove.
    await seedFollowedCountries(t, USER_A.subject, ["US"]);
    const asUser = t.withIdentity(USER_A);

    const results = await Promise.allSettled([
      asUser.mutation(api.followedCountries.followCountry, { country: "US" }),
      asUser.mutation(api.followedCountries.unfollowCountry, { country: "US" }),
    ]);

    // Both mutations succeed (each is idempotent on its no-op branch).
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    // Two consistent end-states are possible depending on serialization
    // order:
    //   (a) follow first (idempotent — already exists), then unfollow
    //       (deletes) → 0 rows, meta=0, counter=0
    //   (b) unfollow first (deletes), then follow (inserts) → 1 row,
    //       meta=1, counter=1
    const rows = await readUserFollows(t, USER_A.subject);
    const meta = await readUserMetaCount(t, USER_A.subject);
    const counter = await readCounter(t, "US");

    // Parity invariant: meta count === row count for this user.
    expect(meta).toBe(rows.length);
    // counter parity: counter === row count for the country (single-user test).
    expect(counter).toBe(rows.length);
    // Either end-state.
    expect([0, 1]).toContain(rows.length);
  });

  test("concurrent mergeAnonymousLocal from N tabs (free user, 5-element list) → final ≤ FREE_TIER_FOLLOW_LIMIT, no duplicate (userId, country) rows", async () => {
    const t = await makeT();
    // No PRO seed → free user, cap=3.
    const asUser = t.withIdentity(USER_A);
    const codes = ["US", "GB", "JP", "CN", "FR"];

    // Simulate 5 tabs all calling mergeAnonymousLocal at the same time.
    const N = 5;
    const results = await Promise.allSettled(
      Array.from({ length: N }, () =>
        asUser.mutation(api.followedCountries.mergeAnonymousLocal, {
          countries: codes,
        }),
      ),
    );
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    // Final row count must never exceed cap.
    const rows = await readUserFollows(t, USER_A.subject);
    expect(rows.length).toBeLessThanOrEqual(FREE_TIER_FOLLOW_LIMIT);
    expect(rows.length).toBe(FREE_TIER_FOLLOW_LIMIT); // 3 of 5 fit

    // No duplicate (userId, country) rows. (The set of countries should
    // equal the row count.)
    expect(new Set(rows).size).toBe(rows.length);

    // Meta parity invariant.
    expect(await readUserMetaCount(t, USER_A.subject)).toBe(rows.length);
  });

  test("concurrent mergeAnonymousLocal from N tabs (PRO user, 5-element list) → exactly the deduped union, no duplicates", async () => {
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);
    const codes = ["US", "GB", "JP", "CN", "FR"];

    const N = 5;
    const results = await Promise.allSettled(
      Array.from({ length: N }, () =>
        asUser.mutation(api.followedCountries.mergeAnonymousLocal, {
          countries: codes,
        }),
      ),
    );
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const rows = await readUserFollows(t, USER_A.subject);
    expect(rows.length).toBe(codes.length);
    expect(new Set(rows)).toEqual(new Set(codes));
    expect(await readUserMetaCount(t, USER_A.subject)).toBe(codes.length);
    // Each per-country counter should be exactly 1 (one user, one row each).
    for (const c of codes) {
      expect(await readCounter(t, c)).toBe(1);
    }
  });

  test("user-meta count parity invariant after a sequence of mutations", async () => {
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);

    await asUser.mutation(api.followedCountries.followCountry, { country: "US" });
    await asUser.mutation(api.followedCountries.followCountry, { country: "GB" });
    await asUser.mutation(api.followedCountries.followCountry, { country: "JP" });
    await asUser.mutation(api.followedCountries.unfollowCountry, { country: "GB" });
    await asUser.mutation(api.followedCountries.followCountry, { country: "US" }); // idempotent
    await asUser.mutation(api.followedCountries.mergeAnonymousLocal, {
      countries: ["DE", "FR", "GB"],
    });

    const rows = await readUserFollows(t, USER_A.subject);
    const meta = await readUserMetaCount(t, USER_A.subject);
    expect(meta).toBe(rows.length);
    // Final set: ['US', 'JP', 'DE', 'FR', 'GB'] (5 rows) — order may differ.
    expect(new Set(rows)).toEqual(new Set(["US", "JP", "DE", "FR", "GB"]));
    expect(meta).toBe(5);
  });

  test("idempotent followCountry does NOT bump user-meta count", async () => {
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);

    await asUser.mutation(api.followedCountries.followCountry, { country: "US" });
    expect(await readUserMetaCount(t, USER_A.subject)).toBe(1);
    // Second call is idempotent.
    await asUser.mutation(api.followedCountries.followCountry, { country: "US" });
    expect(await readUserMetaCount(t, USER_A.subject)).toBe(1);
  });

  test("idempotent unfollowCountry does NOT decrement user-meta count", async () => {
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);

    // Unfollow on absent row — idempotent, no decrement.
    await asUser.mutation(api.followedCountries.unfollowCountry, { country: "US" });
    expect(await readUserMetaCount(t, USER_A.subject)).toBe(0);

    // Follow then unfollow then unfollow.
    await asUser.mutation(api.followedCountries.followCountry, { country: "US" });
    expect(await readUserMetaCount(t, USER_A.subject)).toBe(1);
    await asUser.mutation(api.followedCountries.unfollowCountry, { country: "US" });
    expect(await readUserMetaCount(t, USER_A.subject)).toBe(0);
    // Idempotent unfollow — must NOT push count negative.
    await asUser.mutation(api.followedCountries.unfollowCountry, { country: "US" });
    expect(await readUserMetaCount(t, USER_A.subject)).toBe(0);
  });

  test("FREE_CAP throw rolls back all writes — meta is unchanged", async () => {
    const t = await makeT();
    // Free user at cap.
    await seedFollowedCountries(t, USER_A.subject, ["US", "GB", "JP"]);
    expect(await readUserMetaCount(t, USER_A.subject)).toBe(3);
    const asUser = t.withIdentity(USER_A);

    await expect(
      asUser.mutation(api.followedCountries.followCountry, { country: "FR" }),
    ).rejects.toThrow(/FREE_CAP/);

    // Meta count, row count, and counter for FR must all be unchanged.
    expect(await readUserMetaCount(t, USER_A.subject)).toBe(3);
    expect((await readUserFollows(t, USER_A.subject)).length).toBe(3);
    expect(await readCounter(t, "FR")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sharded-lock pre-seed (Codex round-4 P0 v2)
//
// The previous P0 fix added `followedCountriesUserMeta` keyed by userId
// as a per-user lock — but that document is created LAZILY on first
// mutation. Convex per-document OCC does NOT protect an empty index
// range, so two parallel first-ever mutations from the same brand-new
// user could both read `meta=undefined` and both INSERT, producing
// duplicate meta rows that break the next `.unique()` read AND re-open
// the cap-bypass window.
//
// The fix is the pre-seeded `followedCountriesShards` table: every
// mutation reads + patches the shard row at `userIdToShard(userId)`,
// and that read+write pair on an ALREADY-EXISTING document forces
// Convex's OCC to serialize the brand-new-user race deterministically.
// ---------------------------------------------------------------------------

describe("sharded lock — pre-seed & no-meta-dup invariant", () => {
  test("first-ever follow on a brand-new user creates exactly 1 meta row (no dup)", async () => {
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);

    await asUser.mutation(api.followedCountries.followCountry, {
      country: "US",
    });

    // Exactly one meta row for this user — `.unique()` would throw on dup.
    const metaCount = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("followedCountriesUserMeta")
        .withIndex("by_user", (q) => q.eq("userId", USER_A.subject))
        .collect();
      return rows.length;
    });
    expect(metaCount).toBe(1);
    expect(await readUserMetaCount(t, USER_A.subject)).toBe(1);
  });

  test("two back-to-back mergeAnonymousLocal calls on a brand-new user → one meta row, correct count, no duplicate followedCountries rows", async () => {
    // The original cap-bypass scenario, but now with the shard-tier fix:
    // the second call sees the post-winner state and either accepts fewer
    // rows OR is fully idempotent. Final state must satisfy the
    // meta-uniqueness invariant.
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);

    const codes = ["US", "GB", "JP"];

    // Two PARALLEL calls (convex-test serializes, but the post-winner
    // state of the first MUST be visible to the second under the shard
    // lock — and the meta-row uniqueness must hold either way).
    const results = await Promise.allSettled([
      asUser.mutation(api.followedCountries.mergeAnonymousLocal, {
        countries: codes,
      }),
      asUser.mutation(api.followedCountries.mergeAnonymousLocal, {
        countries: codes,
      }),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    // Exactly one meta row for this user — the brand-new-user TOCTOU
    // is closed by the shard lock.
    const metaRows = await t.run(async (ctx) => {
      return await ctx.db
        .query("followedCountriesUserMeta")
        .withIndex("by_user", (q) => q.eq("userId", USER_A.subject))
        .collect();
    });
    expect(metaRows.length).toBe(1);
    expect(metaRows[0].count).toBe(codes.length);

    // No duplicate (userId, country) rows.
    const rows = await readUserFollows(t, USER_A.subject);
    expect(new Set(rows).size).toBe(rows.length);
    expect(new Set(rows)).toEqual(new Set(codes));
    expect(rows.length).toBe(codes.length);
  });

  test("operator running _seedShards after a partial seed completes idempotently", async () => {
    // makeT() already calls _seedShards (so all SHARD_COUNT rows exist).
    // Re-running it should be a no-op: 0 new rows, total still SHARD_COUNT.
    const t = await makeT();

    const second = await t.mutation(
      internal.followedCountries._seedShards,
      {},
    );
    expect(second).toEqual({ seeded: 0 });

    // Manually delete a few shards to simulate partial-seed state, then
    // re-run: the mutation should plug only the holes and report exactly
    // the count it inserted.
    await t.run(async (ctx) => {
      const some = await ctx.db
        .query("followedCountriesShards")
        .withIndex("by_shard", (q) => q.eq("shardId", 0))
        .unique();
      if (some) await ctx.db.delete(some._id);
      const some2 = await ctx.db
        .query("followedCountriesShards")
        .withIndex("by_shard", (q) => q.eq("shardId", 5))
        .unique();
      if (some2) await ctx.db.delete(some2._id);
    });
    const third = await t.mutation(
      internal.followedCountries._seedShards,
      {},
    );
    expect(third).toEqual({ seeded: 2 });

    // Total row count is exactly SHARD_COUNT.
    const total = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("followedCountriesShards")
        .collect();
      return rows.length;
    });
    expect(total).toBe(SHARD_COUNT);
  });

  test("SHARDS_NOT_SEEDED throw when the shards table is empty (operator error)", async () => {
    // BYPASS makeT() so the shards table is NOT seeded — this is the
    // operator-error scenario where deploy missed the seed step and the
    // daily cron hasn't fired yet.
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);

    await expect(
      asUser.mutation(api.followedCountries.followCountry, {
        country: "US",
      }),
    ).rejects.toThrow(/SHARDS_NOT_SEEDED/);

    await expect(
      asUser.mutation(api.followedCountries.mergeAnonymousLocal, {
        countries: ["US"],
      }),
    ).rejects.toThrow(/SHARDS_NOT_SEEDED/);

    await expect(
      asUser.mutation(api.followedCountries.unfollowCountry, {
        country: "US",
      }),
    ).rejects.toThrow(/SHARDS_NOT_SEEDED/);
  });

  test("public seedShards mutation is no longer exported (security: anyone-can-seed surface removed)", async () => {
    // Codex round-3 P1 fix: the `seedShards` PUBLIC mutation was removed
    // because (a) it had no auth gate (any browser ConvexHttpClient could
    // call it) and (b) the only legitimate caller is the post-deploy CI
    // step which uses `npx convex run --prod followedCountries:_seedShards`
    // — and `npx convex run` can target internal functions directly. So
    // the public surface was deadweight + a hazard.
    //
    // Assertion: the source file does NOT export a top-level
    // `seedShards` (would surface as `export const seedShards = mutation`
    // or `export const seedShards = internalMutation`). We assert against
    // source text rather than `api.followedCountries.seedShards` because
    // the Convex `api` proxy returns FunctionReference objects whose
    // tostring/inspect path is not pretty-format-safe. The compile-time
    // typecheck is the primary gate; this is a belt-and-suspenders
    // runtime guard against accidental re-export.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const source = await fs.readFile(
      path.join(here, "..", "followedCountries.ts"),
      "utf8",
    );
    // Match `export const seedShards = ...` at column 0 (anchored to a
    // line start); the internal helper is `_seedShards` and is allowed.
    expect(/^export const seedShards\s*=/m.test(source)).toBe(false);
  });

  test("readShardOrThrow tolerates duplicate shard rows (uses .first(), not .unique())", async () => {
    // Concurrent-seed race tolerance: two simultaneous _seedShards calls
    // against an empty table can produce duplicate rows for the same
    // shardId. `readShardOrThrow` uses `.first()` so the mutation never
    // throws. `.first()` returns the oldest row by `_creationTime`
    // (Convex's automatic index tiebreaker), so all parallel mutations
    // for users hashing to this shard pick the SAME row — OCC
    // serialization is preserved during the duplicate-window. The
    // `_dedupeShards` cron then removes extras within 24h.
    const t = await makeT();
    await seedProEntitlement(t, USER_A.subject);
    const userShard = userIdToShard(USER_A.subject);

    // Inject a duplicate row for the user's shard.
    await t.run(async (ctx) => {
      await ctx.db.insert("followedCountriesShards", {
        shardId: userShard,
        lastTouchedAt: Date.now(),
      });
    });

    // Confirm the duplicate exists (sanity-check the test setup).
    const dupCount = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("followedCountriesShards")
        .withIndex("by_shard", (q) => q.eq("shardId", userShard))
        .collect();
      return rows.length;
    });
    expect(dupCount).toBe(2);

    // Mutation MUST succeed despite the duplicate.
    const asUser = t.withIdentity(USER_A);
    const result = await asUser.mutation(
      api.followedCountries.followCountry,
      { country: "US" },
    );
    expect(result).toEqual({ ok: true, idempotent: false });

    // Counter parity: row inserted, counter incremented, meta count = 1.
    expect(await readUserFollows(t, USER_A.subject)).toEqual(["US"]);
    expect(await readCounter(t, "US")).toBe(1);
    expect(await readUserMetaCount(t, USER_A.subject)).toBe(1);
  });

  test("_dedupeShards: zero duplicates → no-op", async () => {
    const t = await makeT();
    const result = await t.mutation(
      internal.followedCountries._dedupeShards,
      {},
    );
    expect(result).toEqual({ deleted: 0 });

    // Total still SHARD_COUNT, no row dropped.
    const total = await t.run(async (ctx) => {
      const rows = await ctx.db.query("followedCountriesShards").collect();
      return rows.length;
    });
    expect(total).toBe(SHARD_COUNT);
  });

  test("_dedupeShards: N duplicates → reduces to 1 row per shardId, keeps oldest", async () => {
    const t = await makeT();

    // Inject duplicates for shardIds 0 and 5 (one extra each), and a
    // double-duplicate for shardId 7 (two extras). We track the
    // `_creationTime` of the oldest — that's the row that MUST survive.
    const oldestIds: Record<number, string> = {};
    await t.run(async (ctx) => {
      for (const sid of [0, 5, 7]) {
        const existing = await ctx.db
          .query("followedCountriesShards")
          .withIndex("by_shard", (q) => q.eq("shardId", sid))
          .first();
        if (existing) oldestIds[sid] = existing._id;
      }
      // Inject extras AFTER reading the oldest so `_creationTime`
      // ordering is unambiguous.
      await ctx.db.insert("followedCountriesShards", {
        shardId: 0,
        lastTouchedAt: Date.now(),
      });
      await ctx.db.insert("followedCountriesShards", {
        shardId: 5,
        lastTouchedAt: Date.now(),
      });
      await ctx.db.insert("followedCountriesShards", {
        shardId: 7,
        lastTouchedAt: Date.now(),
      });
      await ctx.db.insert("followedCountriesShards", {
        shardId: 7,
        lastTouchedAt: Date.now(),
      });
    });

    const result = await t.mutation(
      internal.followedCountries._dedupeShards,
      {},
    );
    // 1 + 1 + 2 = 4 extras deleted.
    expect(result).toEqual({ deleted: 4 });

    // Total back to SHARD_COUNT.
    const total = await t.run(async (ctx) => {
      const rows = await ctx.db.query("followedCountriesShards").collect();
      return rows.length;
    });
    expect(total).toBe(SHARD_COUNT);

    // Each shardId now has exactly 1 row and the survivor is the
    // pre-existing oldest one.
    for (const sid of [0, 5, 7]) {
      const rows = await t.run(async (ctx) => {
        return await ctx.db
          .query("followedCountriesShards")
          .withIndex("by_shard", (q) => q.eq("shardId", sid))
          .collect();
      });
      expect(rows.length).toBe(1);
      expect(rows[0]._id).toBe(oldestIds[sid]);
    }
  });

  test("_seedShards is idempotent under back-to-back concurrent re-run", async () => {
    // Models the concurrent-seed race: two simultaneous calls. Both
    // observe pre-seed state; both insert nothing because makeT() already
    // seeded; both return { seeded: 0 }. Total row count is unchanged.
    const t = await makeT();
    const [a, b] = await Promise.all([
      t.mutation(internal.followedCountries._seedShards, {}),
      t.mutation(internal.followedCountries._seedShards, {}),
    ]);
    expect(a).toEqual({ seeded: 0 });
    expect(b).toEqual({ seeded: 0 });

    const total = await t.run(async (ctx) => {
      const rows = await ctx.db.query("followedCountriesShards").collect();
      return rows.length;
    });
    expect(total).toBe(SHARD_COUNT);
  });

  test("userIdToShard is deterministic and within [0, SHARD_COUNT)", () => {
    // Sanity: the hash function MUST be deterministic. If two calls for
    // the same userId returned different shards, the OCC serialization
    // would silently break under load.
    for (const id of ["user-a", "user-with-very-long-clerk-subject-id-12345"]) {
      const a = userIdToShard(id);
      const b = userIdToShard(id);
      expect(a).toBe(b);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(SHARD_COUNT);
    }
  });
});
