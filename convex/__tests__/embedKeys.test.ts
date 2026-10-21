import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { getFeaturesForPlan } from "../lib/entitlements";
import { PRODUCT_CATALOG } from "../config/productCatalog";

const modules = import.meta.glob("../**/*.ts");

// ---------------------------------------------------------------------------
// Helpers (mirrors convex/__tests__/apiKeys.test.ts)
// ---------------------------------------------------------------------------

const NOW = Date.now();
const FUTURE = NOW + 86400000 * 30; // 30 days
const PAST = NOW - 86400000; // 1 day ago

const PRO_USER = { subject: "user-pro", tokenIdentifier: "clerk|user-pro" };
const ROLE_ONLY_PRO_USER = { subject: "user-role-only-pro", tokenIdentifier: "clerk|user-role-only-pro", plan: "pro" as const };
const BUSINESS_USER = { subject: "user-business", tokenIdentifier: "clerk|user-business" };
const API_USER = { subject: "user-api", tokenIdentifier: "clerk|user-api" };
const FREE_USER = { subject: "user-free", tokenIdentifier: "clerk|user-free" };
const OTHER_USER = { subject: "user-other", tokenIdentifier: "clerk|user-other" };

function makeKeyArgs(n: number) {
  const hex = n.toString(16).padStart(5, "0");
  const hash = hex.repeat(13).slice(0, 64); // 64-char hex
  return {
    name: `embed-key-${n}`,
    keyPrefix: `wme_${hex}`,
    keyHash: hash,
  };
}

async function seedEntitlement(
  t: ReturnType<typeof convexTest>,
  userId: string,
  planKey: string,
  opts: { validUntil?: number } = {},
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("entitlements", {
      userId,
      planKey,
      features: getFeaturesForPlan(planKey),
      validUntil: opts.validUntil ?? FUTURE,
      updatedAt: NOW,
    });
  });
}

/**
 * Seed a row shaped the way every entitlement written BEFORE `embedAccess`
 * existed is shaped: the field is absent, not `undefined`. The distinction is
 * the whole point — `mergeEntitlementFeatures` spreads the stored object over
 * the catalog defaults, so an own `embedAccess: undefined` property would
 * overwrite the default instead of inheriting it.
 */
async function seedLegacyEntitlement(
  t: ReturnType<typeof convexTest>,
  userId: string,
  planKey: string,
) {
  const { embedAccess: _embedAccess, ...legacyFeatures } = getFeaturesForPlan(planKey);
  await t.run(async (ctx) => {
    await ctx.db.insert("entitlements", {
      userId,
      planKey,
      features: legacyFeatures,
      validUntil: FUTURE,
      updatedAt: NOW,
    });
  });
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

describe("embedAccess in the product catalog", () => {
  test("every paid plan grants it and free does not", () => {
    for (const [planKey, entry] of Object.entries(PRODUCT_CATALOG)) {
      expect(entry.features.embedAccess, planKey).toBe(entry.features.tier >= 1);
    }
  });

  test("the paid plans that cannot mint a wm_ key can still mint an embed key", () => {
    // The reason the flag is not apiAccess.
    for (const planKey of ["pro_monthly", "pro_annual", "pro_business_monthly", "pro_business_annual"]) {
      const features = getFeaturesForPlan(planKey);
      expect(features.apiAccess, planKey).toBe(false);
      expect(features.embedAccess, planKey).toBe(true);
    }
  });

  test("free is excluded on both axes", () => {
    const features = getFeaturesForPlan("free");
    expect(features.tier).toBe(0);
    expect(features.embedAccess).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Read-time catalog merge (no backfill)
// ---------------------------------------------------------------------------

describe("read-time merge", () => {
  test("surfaces embedAccess on a stored row written before the field existed", async () => {
    const t = convexTest(schema, modules);
    await seedLegacyEntitlement(t, "user-pro", "pro_monthly");

    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("entitlements")
        .withIndex("by_userId", (q) => q.eq("userId", "user-pro"))
        .first(),
    );
    expect(stored?.features).not.toHaveProperty("embedAccess");

    const result = await t.query(internal.entitlements.getEntitlementsByUserId, {
      userId: "user-pro",
    });
    expect(result.features.embedAccess).toBe(true);
  });

  test("a legacy free row still merges to embedAccess=false", async () => {
    const t = convexTest(schema, modules);
    await seedLegacyEntitlement(t, "user-free", "free");

    const result = await t.query(internal.entitlements.getEntitlementsByUserId, {
      userId: "user-free",
    });
    expect(result.features.embedAccess).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createEmbedKey — the gate
// ---------------------------------------------------------------------------

describe("createEmbedKey entitlement gate", () => {
  test("succeeds for a verified Clerk PRO identity without an entitlement row", async () => {
    const t = convexTest(schema, modules);

    await expect(
      t.withIdentity(ROLE_ONLY_PRO_USER).mutation(api.embedKeys.createEmbedKey, makeKeyArgs(1)),
    ).resolves.toMatchObject({ keyPrefix: "wme_00001" });
  });

  test("succeeds for a Pro user (tier 1, apiAccess:false)", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");

    // The whole reason this credential is not a wm_ key: Pro cannot mint one.
    expect(getFeaturesForPlan("pro_monthly").apiAccess).toBe(false);

    const result = await t.withIdentity(PRO_USER).mutation(
      api.embedKeys.createEmbedKey,
      makeKeyArgs(1),
    );

    expect(result).toMatchObject({ name: "embed-key-1", keyPrefix: "wme_00001" });
    expect(result.id).toBeTruthy();

    const row = await t.run(async (ctx) => ctx.db.get(result.id));
    expect(row?.userId).toBe("user-pro");
    expect(row?.keyHash).toBe(makeKeyArgs(1).keyHash);
    expect(row?.revokedAt).toBeUndefined();
    expect(row?.createdAt).toBeGreaterThan(0);
  });

  test("succeeds for Pro Business and API tiers", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-business", "pro_business_monthly");
    await seedEntitlement(t, "user-api", "api_starter");

    await expect(
      t.withIdentity(BUSINESS_USER).mutation(api.embedKeys.createEmbedKey, makeKeyArgs(1)),
    ).resolves.toMatchObject({ keyPrefix: "wme_00001" });
    await expect(
      t.withIdentity(API_USER).mutation(api.embedKeys.createEmbedKey, makeKeyArgs(2)),
    ).resolves.toMatchObject({ keyPrefix: "wme_00002" });
  });

  test("succeeds for a Pro row written before embedAccess existed", async () => {
    // Merge-before-gate. Reading the stored row raw — the way createApiKey
    // reads apiAccess — would deny every subscriber who predates this deploy.
    const t = convexTest(schema, modules);
    await seedLegacyEntitlement(t, "user-pro", "pro_monthly");

    await expect(
      t.withIdentity(PRO_USER).mutation(api.embedKeys.createEmbedKey, makeKeyArgs(1)),
    ).resolves.toMatchObject({ keyPrefix: "wme_00001" });
  });

  test("rejects a legacy free row — the merge must not fail open", async () => {
    const t = convexTest(schema, modules);
    await seedLegacyEntitlement(t, "user-free", "free");

    await expect(
      t.withIdentity(FREE_USER).mutation(api.embedKeys.createEmbedKey, makeKeyArgs(1)),
    ).rejects.toThrow(/EMBED_ACCESS_REQUIRED/);
  });

  test("rejects users with no entitlement row", async () => {
    const t = convexTest(schema, modules);

    await expect(
      t.withIdentity(FREE_USER).mutation(api.embedKeys.createEmbedKey, makeKeyArgs(1)),
    ).rejects.toThrow(/EMBED_ACCESS_REQUIRED/);
  });

  test("rejects free-tier users", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-free", "free");

    await expect(
      t.withIdentity(FREE_USER).mutation(api.embedKeys.createEmbedKey, makeKeyArgs(1)),
    ).rejects.toThrow(/EMBED_ACCESS_REQUIRED/);
  });

  test("rejects an expired paid entitlement", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly", { validUntil: PAST });

    await expect(
      t.withIdentity(PRO_USER).mutation(api.embedKeys.createEmbedKey, makeKeyArgs(1)),
    ).rejects.toThrow(/EMBED_ACCESS_REQUIRED/);
  });

  test("requires authentication", async () => {
    const t = convexTest(schema, modules);

    await expect(
      t.mutation(api.embedKeys.createEmbedKey, makeKeyArgs(1)),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// createEmbedKey — input validation
// ---------------------------------------------------------------------------

describe("createEmbedKey input validation", () => {
  test("rejects a wm_ prefix — the two credential surfaces do not share a shape", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");

    await expect(
      t.withIdentity(PRO_USER).mutation(api.embedKeys.createEmbedKey, {
        ...makeKeyArgs(1),
        keyPrefix: "wm_00001",
      }),
    ).rejects.toThrow(/INVALID_PREFIX/);
  });

  test("rejects malformed prefixes, hashes and names", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");
    const asPro = t.withIdentity(PRO_USER);

    for (const keyPrefix of ["wme_0000", "wme_000011", "wme_ABCDE", "wme_zzzzz", "wme_"]) {
      await expect(
        asPro.mutation(api.embedKeys.createEmbedKey, { ...makeKeyArgs(1), keyPrefix }),
      ).rejects.toThrow(/INVALID_PREFIX/);
    }
    for (const keyHash of ["a".repeat(63), "a".repeat(65), "A".repeat(64), "z".repeat(64)]) {
      await expect(
        asPro.mutation(api.embedKeys.createEmbedKey, { ...makeKeyArgs(1), keyHash }),
      ).rejects.toThrow(/INVALID_HASH/);
    }
    await expect(
      asPro.mutation(api.embedKeys.createEmbedKey, { ...makeKeyArgs(1), name: "   " }),
    ).rejects.toThrow(/INVALID_NAME/);
  });

  test("rejects a duplicate key hash", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");
    const asPro = t.withIdentity(PRO_USER);

    await asPro.mutation(api.embedKeys.createEmbedKey, makeKeyArgs(1));
    await expect(
      asPro.mutation(api.embedKeys.createEmbedKey, { ...makeKeyArgs(2), keyHash: makeKeyArgs(1).keyHash }),
    ).rejects.toThrow(/DUPLICATE_KEY/);
  });

  test("enforces a per-user cap of 5 active keys", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");
    const asPro = t.withIdentity(PRO_USER);

    for (let i = 1; i <= 5; i++) {
      await asPro.mutation(api.embedKeys.createEmbedKey, makeKeyArgs(i));
    }
    await expect(
      asPro.mutation(api.embedKeys.createEmbedKey, makeKeyArgs(6)),
    ).rejects.toThrow(/KEY_LIMIT_REACHED/);
  });

  test("the cap counts only active keys — revoking frees a slot", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");
    const asPro = t.withIdentity(PRO_USER);

    const first = await asPro.mutation(api.embedKeys.createEmbedKey, makeKeyArgs(1));
    for (let i = 2; i <= 5; i++) {
      await asPro.mutation(api.embedKeys.createEmbedKey, makeKeyArgs(i));
    }
    await asPro.mutation(api.embedKeys.revokeEmbedKey, { keyId: first.id });

    await expect(
      asPro.mutation(api.embedKeys.createEmbedKey, makeKeyArgs(6)),
    ).resolves.toMatchObject({ keyPrefix: "wme_00006" });
  });

  test("the cap is per user, not global", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");
    await seedEntitlement(t, "user-other", "pro_monthly");

    for (let i = 1; i <= 5; i++) {
      await t.withIdentity(PRO_USER).mutation(api.embedKeys.createEmbedKey, makeKeyArgs(i));
    }
    await expect(
      t.withIdentity(OTHER_USER).mutation(api.embedKeys.createEmbedKey, makeKeyArgs(6)),
    ).resolves.toMatchObject({ keyPrefix: "wme_00006" });
  });
});

// ---------------------------------------------------------------------------
// allowedOrigins — stored and returned, never enforced
// ---------------------------------------------------------------------------

describe("allowedOrigins", () => {
  test("round-trips through create, the row, and list", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");
    const asPro = t.withIdentity(PRO_USER);

    const created = await asPro.mutation(api.embedKeys.createEmbedKey, {
      ...makeKeyArgs(1),
      allowedOrigins: ["https://partner.example", "http://localhost:3000"],
    });

    expect(created.allowedOrigins).toEqual(["http://localhost:3000", "https://partner.example"]);
    const row = await t.run(async (ctx) => ctx.db.get(created.id));
    expect(row?.allowedOrigins).toEqual(["http://localhost:3000", "https://partner.example"]);

    const listed = await asPro.query(api.embedKeys.listEmbedKeys, {});
    expect(listed[0]?.allowedOrigins).toEqual(["http://localhost:3000", "https://partner.example"]);
  });

  test("is optional — omitting it stores nothing", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");

    const created = await t.withIdentity(PRO_USER).mutation(
      api.embedKeys.createEmbedKey,
      makeKeyArgs(1),
    );

    expect(created.allowedOrigins).toBeUndefined();
    const row = await t.run(async (ctx) => ctx.db.get(created.id));
    expect(row?.allowedOrigins).toBeUndefined();
  });

  test("dedupes and drops blanks; an all-blank list stores nothing", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");
    const asPro = t.withIdentity(PRO_USER);

    const deduped = await asPro.mutation(api.embedKeys.createEmbedKey, {
      ...makeKeyArgs(1),
      allowedOrigins: ["https://a.example", " https://a.example ", "", "  "],
    });
    expect(deduped.allowedOrigins).toEqual(["https://a.example"]);

    const empty = await asPro.mutation(api.embedKeys.createEmbedKey, {
      ...makeKeyArgs(2),
      allowedOrigins: ["", "   "],
    });
    expect(empty.allowedOrigins).toBeUndefined();
  });

  test("rejects anything that is not a bare origin", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");
    const asPro = t.withIdentity(PRO_USER);

    for (const bad of [
      "partner.example",                 // no scheme
      "https://partner.example/embed",   // path
      "https://partner.example/",        // trailing slash
      "https://partner.example?x=1",     // query
      "not a url",
    ]) {
      await expect(
        asPro.mutation(api.embedKeys.createEmbedKey, {
          ...makeKeyArgs(1),
          allowedOrigins: [bad],
        }),
      ).rejects.toThrow(/INVALID_ORIGIN/);
    }
  });

  test("caps the number of declared origins", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");

    const eleven = Array.from({ length: 11 }, (_, i) => `https://p${i}.example`);
    await expect(
      t.withIdentity(PRO_USER).mutation(api.embedKeys.createEmbedKey, {
        ...makeKeyArgs(1),
        allowedOrigins: eleven,
      }),
    ).rejects.toThrow(/TOO_MANY_ORIGINS/);
  });

  test("validateKeyByHash does not expose them — nothing enforces origins", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");
    await t.withIdentity(PRO_USER).mutation(api.embedKeys.createEmbedKey, {
      ...makeKeyArgs(1),
      allowedOrigins: ["https://partner.example"],
    });

    const result = await t.query(internal.embedKeys.validateKeyByHash, {
      keyHash: makeKeyArgs(1).keyHash,
    });
    expect(result).not.toHaveProperty("allowedOrigins");
  });
});

// ---------------------------------------------------------------------------
// listEmbedKeys
// ---------------------------------------------------------------------------

describe("listEmbedKeys", () => {
  test("returns only the caller's keys and never the hash", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");
    await seedEntitlement(t, "user-other", "pro_monthly");

    await t.withIdentity(PRO_USER).mutation(api.embedKeys.createEmbedKey, makeKeyArgs(1));
    await t.withIdentity(OTHER_USER).mutation(api.embedKeys.createEmbedKey, makeKeyArgs(2));

    const mine = await t.withIdentity(PRO_USER).query(api.embedKeys.listEmbedKeys, {});
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ name: "embed-key-1", keyPrefix: "wme_00001" });
    expect(mine[0]).not.toHaveProperty("keyHash");
    expect(mine[0]).not.toHaveProperty("userId");
  });

  test("returns [] for an unauthenticated caller instead of throwing", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.embedKeys.listEmbedKeys, {})).resolves.toEqual([]);
  });

  test("includes revoked keys", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");
    const asPro = t.withIdentity(PRO_USER);

    const created = await asPro.mutation(api.embedKeys.createEmbedKey, makeKeyArgs(1));
    await asPro.mutation(api.embedKeys.revokeEmbedKey, { keyId: created.id });

    const keys = await asPro.query(api.embedKeys.listEmbedKeys, {});
    expect(keys).toHaveLength(1);
    expect(keys[0]?.revokedAt).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// revokeEmbedKey
// ---------------------------------------------------------------------------

describe("revokeEmbedKey", () => {
  test("stamps revokedAt and returns the hash for cache invalidation", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");
    const asPro = t.withIdentity(PRO_USER);

    const created = await asPro.mutation(api.embedKeys.createEmbedKey, makeKeyArgs(1));
    const result = await asPro.mutation(api.embedKeys.revokeEmbedKey, { keyId: created.id });

    expect(result).toEqual({ ok: true, keyHash: makeKeyArgs(1).keyHash });
    const row = await t.run(async (ctx) => ctx.db.get(created.id));
    expect(row?.revokedAt).toBeGreaterThan(0);
  });

  test("rejects revoking another user's key", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");
    await seedEntitlement(t, "user-other", "pro_monthly");

    const created = await t.withIdentity(PRO_USER).mutation(
      api.embedKeys.createEmbedKey,
      makeKeyArgs(1),
    );

    await expect(
      t.withIdentity(OTHER_USER).mutation(api.embedKeys.revokeEmbedKey, { keyId: created.id }),
    ).rejects.toThrow(/NOT_FOUND/);
    const row = await t.run(async (ctx) => ctx.db.get(created.id));
    expect(row?.revokedAt).toBeUndefined();
  });

  test("rejects a second revoke", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");
    const asPro = t.withIdentity(PRO_USER);

    const created = await asPro.mutation(api.embedKeys.createEmbedKey, makeKeyArgs(1));
    await asPro.mutation(api.embedKeys.revokeEmbedKey, { keyId: created.id });

    await expect(
      asPro.mutation(api.embedKeys.revokeEmbedKey, { keyId: created.id }),
    ).rejects.toThrow(/ALREADY_REVOKED/);
  });
});

// ---------------------------------------------------------------------------
// validateKeyByHash (internal)
// ---------------------------------------------------------------------------

describe("validateKeyByHash", () => {
  test("resolves an active key to its owner", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");
    await t.withIdentity(PRO_USER).mutation(api.embedKeys.createEmbedKey, makeKeyArgs(1));

    const result = await t.query(internal.embedKeys.validateKeyByHash, {
      keyHash: makeKeyArgs(1).keyHash,
    });
    expect(result).toMatchObject({ userId: "user-pro", name: "embed-key-1" });
  });

  test("returns null for an unknown hash", async () => {
    const t = convexTest(schema, modules);

    await expect(
      t.query(internal.embedKeys.validateKeyByHash, { keyHash: "f".repeat(64) }),
    ).resolves.toBeNull();
  });

  test("returns null once the key is revoked", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");
    const asPro = t.withIdentity(PRO_USER);

    const created = await asPro.mutation(api.embedKeys.createEmbedKey, makeKeyArgs(1));
    await asPro.mutation(api.embedKeys.revokeEmbedKey, { keyId: created.id });

    await expect(
      t.query(internal.embedKeys.validateKeyByHash, { keyHash: makeKeyArgs(1).keyHash }),
    ).resolves.toBeNull();
  });

  test("a wm_ key's hash never resolves through the embed table", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("userApiKeys", {
        userId: "user-api",
        name: "rest-key",
        keyPrefix: "wm_00001",
        keyHash: makeKeyArgs(1).keyHash,
        createdAt: NOW,
      });
    });

    await expect(
      t.query(internal.embedKeys.validateKeyByHash, { keyHash: makeKeyArgs(1).keyHash }),
    ).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// touchKeyLastUsed (internal)
// ---------------------------------------------------------------------------

describe("touchKeyLastUsed", () => {
  test("stamps lastUsedAt, then debounces a second touch", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");

    const created = await t.withIdentity(PRO_USER).mutation(
      api.embedKeys.createEmbedKey,
      makeKeyArgs(1),
    );
    await t.mutation(internal.embedKeys.touchKeyLastUsed, { keyId: created.id });
    const first = await t.run(async (ctx) => (await ctx.db.get(created.id))?.lastUsedAt);
    expect(first).toBeGreaterThan(0);

    await t.mutation(internal.embedKeys.touchKeyLastUsed, { keyId: created.id });
    const second = await t.run(async (ctx) => (await ctx.db.get(created.id))?.lastUsedAt);
    expect(second).toBe(first);
  });

  test("is a no-op for a revoked key", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");
    const asPro = t.withIdentity(PRO_USER);

    const created = await asPro.mutation(api.embedKeys.createEmbedKey, makeKeyArgs(1));
    await asPro.mutation(api.embedKeys.revokeEmbedKey, { keyId: created.id });
    await t.mutation(internal.embedKeys.touchKeyLastUsed, { keyId: created.id });

    const row = await t.run(async (ctx) => ctx.db.get(created.id));
    expect(row?.lastUsedAt).toBeUndefined();
  });
});
