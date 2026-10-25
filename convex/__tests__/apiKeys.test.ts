import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, describe, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { getFeaturesForPlan } from "../lib/entitlements";

const modules = import.meta.glob("../**/*.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = Date.now();
const FUTURE = NOW + 86400000 * 30; // 30 days
const PAST = NOW - 86400000; // 1 day ago

const API_USER = { subject: "user-api", tokenIdentifier: "clerk|user-api" };
const PRO_USER = { subject: "user-pro", tokenIdentifier: "clerk|user-pro" };
const FREE_USER = { subject: "user-free", tokenIdentifier: "clerk|user-free" };
const OTHER_USER = { subject: "user-other", tokenIdentifier: "clerk|user-other" };

function makeKeyArgs(n: number) {
  const hex = n.toString(16).padStart(5, "0");
  const hash = hex.repeat(13).slice(0, 64); // 64-char hex
  return {
    name: `test-key-${n}`,
    keyPrefix: `wm_${hex}`,
    keyHash: hash,
  };
}

/** Seed entitlement with apiAccess=true (API_STARTER plan, tier 2). */
async function seedApiEntitlement(
  t: ReturnType<typeof convexTest>,
  userId: string,
  opts: { validUntil?: number } = {},
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("entitlements", {
      userId,
      planKey: "api_starter",
      features: getFeaturesForPlan("api_starter"),
      validUntil: opts.validUntil ?? FUTURE,
      updatedAt: NOW,
    });
  });
}

async function seedActiveApiKeys(
  t: ReturnType<typeof convexTest>,
  userId: string,
  count: number,
) {
  await t.run(async (ctx) => {
    const now = Date.now();
    for (let i = 1; i <= count; i++) {
      const args = makeKeyArgs(i);
      await ctx.db.insert("userApiKeys", {
        userId,
        name: args.name,
        keyPrefix: args.keyPrefix,
        keyHash: args.keyHash,
        createdAt: now - (count - i) * 1000,
      });
    }
  });
}

/** Seed entitlement with apiAccess=false (Pro plan, tier 1). */
async function seedProEntitlement(
  t: ReturnType<typeof convexTest>,
  userId: string,
  opts: { validUntil?: number } = {},
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("entitlements", {
      userId,
      planKey: "pro_monthly",
      features: getFeaturesForPlan("pro_monthly"),
      validUntil: opts.validUntil ?? FUTURE,
      updatedAt: NOW,
    });
  });
}

// ---------------------------------------------------------------------------
// createApiKey
// ---------------------------------------------------------------------------

describe("createApiKey", () => {
  test("rejects free-tier users (API_ACCESS_REQUIRED)", async () => {
    const t = convexTest(schema, modules);

    await expect(
      t.withIdentity(FREE_USER).mutation(api.apiKeys.createApiKey, makeKeyArgs(1)),
    ).rejects.toThrow(/API_ACCESS_REQUIRED/);
  });

  test("rejects pro-tier users without apiAccess", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");

    // Pro plan has apiAccess=false — should be rejected
    await expect(
      t.withIdentity(PRO_USER).mutation(api.apiKeys.createApiKey, makeKeyArgs(1)),
    ).rejects.toThrow(/API_ACCESS_REQUIRED/);
  });

  test("rejects users with expired entitlement", async () => {
    const t = convexTest(schema, modules);
    await seedApiEntitlement(t, "user-api", { validUntil: PAST });

    await expect(
      t.withIdentity(API_USER).mutation(api.apiKeys.createApiKey, makeKeyArgs(1)),
    ).rejects.toThrow(/API_ACCESS_REQUIRED/);
  });

  test("succeeds for API-tier user", async () => {
    const t = convexTest(schema, modules);
    await seedApiEntitlement(t, "user-api");

    const result = await t.withIdentity(API_USER).mutation(
      api.apiKeys.createApiKey,
      makeKeyArgs(1),
    );

    expect(result).toMatchObject({
      name: "test-key-1",
      keyPrefix: "wm_00001",
    });
    expect(result.id).toBeTruthy();
  });

  test("enforces per-user limit of 5 active keys", async () => {
    const t = convexTest(schema, modules);
    await seedApiEntitlement(t, "user-api");

    const asApiUser = t.withIdentity(API_USER);
    for (let i = 1; i <= 5; i++) {
      await asApiUser.mutation(api.apiKeys.createApiKey, makeKeyArgs(i));
    }

    await expect(
      asApiUser.mutation(api.apiKeys.createApiKey, makeKeyArgs(6)),
    ).rejects.toThrow(/KEY_LIMIT_REACHED/);

    const keys = await asApiUser.query(api.apiKeys.listApiKeys, {});
    expect(keys.filter((k: any) => !k.revokedAt)).toHaveLength(5);
    expect(keys.filter((k: any) => k.revokedAt)).toHaveLength(0);
  });

  for (const overflow of [
    { seededActive: 6, nextKey: 7, revokedNames: ["test-key-1", "test-key-2"] },
    {
      seededActive: 8,
      nextKey: 9,
      revokedNames: ["test-key-1", "test-key-2", "test-key-3", "test-key-4"],
    },
  ]) {
    test(`race-leftover overflow from ${overflow.seededActive} active keys converges back to 5 active keys while creating`, async () => {
      // convex-test serializes mutations, so seed the post-race over-cap state directly.
      const t = convexTest(schema, modules);
      await seedApiEntitlement(t, "user-api");
      await seedActiveApiKeys(t, "user-api", overflow.seededActive);

      const asApiUser = t.withIdentity(API_USER);
      const created = await asApiUser.mutation(
        api.apiKeys.createApiKey,
        makeKeyArgs(overflow.nextKey),
      );
      expect(created.name).toBe(`test-key-${overflow.nextKey}`);

      const keys = await asApiUser.query(api.apiKeys.listApiKeys, {});
      const active = keys.filter((k: any) => !k.revokedAt);
      const revoked = keys.filter((k: any) => k.revokedAt);
      expect(active).toHaveLength(5);
      expect(revoked).toHaveLength(overflow.revokedNames.length);
      expect(revoked.map((k: any) => k.name).sort()).toEqual(overflow.revokedNames);
      expect(active.some((k: any) => k.name === `test-key-${overflow.nextKey}`)).toBe(true);
    });
  }

  test("revoked keys do not count toward the limit", async () => {
    const t = convexTest(schema, modules);
    await seedApiEntitlement(t, "user-api");

    const asApiUser = t.withIdentity(API_USER);
    const first = await asApiUser.mutation(api.apiKeys.createApiKey, makeKeyArgs(1));
    for (let i = 2; i <= 5; i++) {
      await asApiUser.mutation(api.apiKeys.createApiKey, makeKeyArgs(i));
    }

    // Revoke the first key
    await asApiUser.mutation(api.apiKeys.revokeApiKey, { keyId: first.id });

    // Should succeed since only 4 active keys remain
    const sixth = await asApiUser.mutation(api.apiKeys.createApiKey, makeKeyArgs(6));
    expect(sixth.name).toBe("test-key-6");
  });

  test("rejects duplicate key hash", async () => {
    const t = convexTest(schema, modules);
    await seedApiEntitlement(t, "user-api");

    const asApiUser = t.withIdentity(API_USER);
    await asApiUser.mutation(api.apiKeys.createApiKey, makeKeyArgs(1));

    await expect(
      asApiUser.mutation(api.apiKeys.createApiKey, {
        ...makeKeyArgs(1),
        name: "different-name",
      }),
    ).rejects.toThrow(/DUPLICATE_KEY/);
  });

  test("rejects invalid keyPrefix format", async () => {
    const t = convexTest(schema, modules);
    await seedApiEntitlement(t, "user-api");

    await expect(
      t.withIdentity(API_USER).mutation(api.apiKeys.createApiKey, {
        name: "test",
        keyPrefix: "wm_toolong00",
        keyHash: "a".repeat(64),
      }),
    ).rejects.toThrow(/INVALID_PREFIX/);
  });

  test("rejects invalid keyHash format", async () => {
    const t = convexTest(schema, modules);
    await seedApiEntitlement(t, "user-api");

    await expect(
      t.withIdentity(API_USER).mutation(api.apiKeys.createApiKey, {
        name: "test",
        keyPrefix: "wm_abcde",
        keyHash: "not-a-valid-hash",
      }),
    ).rejects.toThrow(/INVALID_HASH/);
  });

  test("rejects empty name", async () => {
    const t = convexTest(schema, modules);
    await seedApiEntitlement(t, "user-api");

    await expect(
      t.withIdentity(API_USER).mutation(api.apiKeys.createApiKey, {
        name: "   ",
        keyPrefix: "wm_abcde",
        keyHash: "a".repeat(64),
      }),
    ).rejects.toThrow(/INVALID_NAME/);
  });
});

// ---------------------------------------------------------------------------
// revokeApiKey
// ---------------------------------------------------------------------------

describe("revokeApiKey", () => {
  test("revokes own key and returns keyHash", async () => {
    const t = convexTest(schema, modules);
    await seedApiEntitlement(t, "user-api");

    const asApiUser = t.withIdentity(API_USER);
    const created = await asApiUser.mutation(api.apiKeys.createApiKey, makeKeyArgs(1));

    const result = await asApiUser.mutation(api.apiKeys.revokeApiKey, { keyId: created.id });
    expect(result.ok).toBe(true);
    expect(result.keyHash).toBe(makeKeyArgs(1).keyHash);
  });

  test("schedules cache invalidation for the revoked key AND the owner's other active keys (their ranks shift)", async () => {
    const savedUrl = process.env.UPSTASH_REDIS_REST_URL;
    const savedToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    // The jobs are asserted as scheduled, never run: on real timers they fire
    // after the test ends and write to a torn-down database.
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      await seedApiEntitlement(t, "user-api");
      const asApiUser = t.withIdentity(API_USER);
      const first = await asApiUser.mutation(api.apiKeys.createApiKey, makeKeyArgs(1));
      await asApiUser.mutation(api.apiKeys.createApiKey, makeKeyArgs(2));
      await asApiUser.mutation(api.apiKeys.createApiKey, makeKeyArgs(3));
      const revokedEarlier = await asApiUser.mutation(api.apiKeys.createApiKey, makeKeyArgs(4));
      await asApiUser.mutation(api.apiKeys.revokeApiKey, { keyId: revokedEarlier.id });
      // Another owner's key must never ride along.
      await seedApiEntitlement(t, "user-other");
      await t.withIdentity(OTHER_USER).mutation(api.apiKeys.createApiKey, makeKeyArgs(9));

      await asApiUser.mutation(api.apiKeys.revokeApiKey, { keyId: first.id });

      const scheduled = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
      const jobs = scheduled.filter((job) => job.name.includes("invalidateUserApiKeyCaches"));
      const last = jobs[jobs.length - 1];
      expect(last).toBeDefined();
      const keyHashes = (last!.args[0] as { keyHashes: string[] }).keyHashes;
      expect(keyHashes[0]).toBe(makeKeyArgs(1).keyHash);
      expect(new Set(keyHashes)).toEqual(new Set([makeKeyArgs(1).keyHash, makeKeyArgs(2).keyHash, makeKeyArgs(3).keyHash]));
    } finally {
      vi.useRealTimers();
      if (savedUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = savedUrl;
      if (savedToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = savedToken;
    }
  });

  test("rejects non-owner revoke attempt", async () => {
    const t = convexTest(schema, modules);
    await seedApiEntitlement(t, "user-api");

    const created = await t.withIdentity(API_USER).mutation(
      api.apiKeys.createApiKey,
      makeKeyArgs(1),
    );

    await expect(
      t.withIdentity(OTHER_USER).mutation(api.apiKeys.revokeApiKey, { keyId: created.id }),
    ).rejects.toThrow(/NOT_FOUND/);
  });

  test("rejects double revocation", async () => {
    const t = convexTest(schema, modules);
    await seedApiEntitlement(t, "user-api");

    const asApiUser = t.withIdentity(API_USER);
    const created = await asApiUser.mutation(api.apiKeys.createApiKey, makeKeyArgs(1));
    await asApiUser.mutation(api.apiKeys.revokeApiKey, { keyId: created.id });

    await expect(
      asApiUser.mutation(api.apiKeys.revokeApiKey, { keyId: created.id }),
    ).rejects.toThrow(/ALREADY_REVOKED/);
  });
});

// ---------------------------------------------------------------------------
// listApiKeys
// ---------------------------------------------------------------------------

describe("listApiKeys", () => {
  test("returns empty list when no keys", async () => {
    const t = convexTest(schema, modules);

    const keys = await t.withIdentity(API_USER).query(api.apiKeys.listApiKeys, {});
    expect(keys).toEqual([]);
  });

  test("returns both active and revoked keys", async () => {
    const t = convexTest(schema, modules);
    await seedApiEntitlement(t, "user-api");

    const asApiUser = t.withIdentity(API_USER);
    const k1 = await asApiUser.mutation(api.apiKeys.createApiKey, makeKeyArgs(1));
    await asApiUser.mutation(api.apiKeys.createApiKey, makeKeyArgs(2));
    await asApiUser.mutation(api.apiKeys.revokeApiKey, { keyId: k1.id });

    const keys = await asApiUser.query(api.apiKeys.listApiKeys, {});
    expect(keys).toHaveLength(2);

    const active = keys.filter((k: any) => !k.revokedAt);
    const revoked = keys.filter((k: any) => k.revokedAt);
    expect(active).toHaveLength(1);
    expect(revoked).toHaveLength(1);
  });

  test("does not return other users' keys", async () => {
    const t = convexTest(schema, modules);
    await seedApiEntitlement(t, "user-api");

    await t.withIdentity(API_USER).mutation(api.apiKeys.createApiKey, makeKeyArgs(1));

    const otherKeys = await t.withIdentity(OTHER_USER).query(api.apiKeys.listApiKeys, {});
    expect(otherKeys).toEqual([]);
  });

  test("returns empty during an unauthenticated query race", async () => {
    // WORLDMONITOR-XM: the settings query can fire while Convex auth briefly
    // disappears during initial auth, sign-out, or token rotation. Seed a real
    // user's key to prove the unauthenticated result is empty rather than a
    // throw or an accidental cross-user read.
    const t = convexTest(schema, modules);
    await seedApiEntitlement(t, "user-api");
    await t.withIdentity(API_USER).mutation(api.apiKeys.createApiKey, makeKeyArgs(1));

    const keys = await t.query(api.apiKeys.listApiKeys, {});
    expect(keys).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validateKeyByHash (internal)
// ---------------------------------------------------------------------------

describe("validateKeyByHash", () => {
  test("returns key info for valid active key", async () => {
    const t = convexTest(schema, modules);
    await seedApiEntitlement(t, "user-api");

    await t.withIdentity(API_USER).mutation(api.apiKeys.createApiKey, makeKeyArgs(1));

    const result = await t.query(internal.apiKeys.validateKeyByHash, {
      keyHash: makeKeyArgs(1).keyHash,
    });
    expect(result).toMatchObject({
      userId: "user-api",
      name: "test-key-1",
    });
  });

  test("returns null for revoked key", async () => {
    const t = convexTest(schema, modules);
    await seedApiEntitlement(t, "user-api");

    const asApiUser = t.withIdentity(API_USER);
    const created = await asApiUser.mutation(api.apiKeys.createApiKey, makeKeyArgs(1));
    await asApiUser.mutation(api.apiKeys.revokeApiKey, { keyId: created.id });

    const result = await t.query(internal.apiKeys.validateKeyByHash, {
      keyHash: makeKeyArgs(1).keyHash,
    });
    expect(result).toBeNull();
  });

  test("returns null for nonexistent hash", async () => {
    const t = convexTest(schema, modules);

    const result = await t.query(internal.apiKeys.validateKeyByHash, {
      keyHash: "f".repeat(64),
    });
    expect(result).toBeNull();
  });

  // Plan 2026-10-25-001 KTD5 / R5: the edge applies "oldest active keys up to
  // maxDesktopKeys" to a downgraded owner's generic keys, so every validate
  // response carries the key's 0-based rank among the owner's ACTIVE keys of
  // both kinds, oldest first.
  test("AE6: activeKeyRank orders the owner's active keys oldest-first and shifts after a revoke", async () => {
    const t = convexTest(schema, modules);
    await seedApiEntitlement(t, "user-api");
    const asApiUser = t.withIdentity(API_USER);
    const first = await asApiUser.mutation(api.apiKeys.createApiKey, makeKeyArgs(1));
    await asApiUser.mutation(api.apiKeys.createApiKey, makeKeyArgs(2));
    await asApiUser.mutation(api.apiKeys.createApiKey, makeKeyArgs(3));

    const rank = async (n: number) =>
      (await t.query(internal.apiKeys.validateKeyByHash, { keyHash: makeKeyArgs(n).keyHash }))?.activeKeyRank;
    expect([await rank(1), await rank(2), await rank(3)]).toEqual([0, 1, 2]);

    await asApiUser.mutation(api.apiKeys.revokeApiKey, { keyId: first.id });
    expect([await rank(2), await rank(3)]).toEqual([0, 1]);
  });

  test("activeKeyRank counts desktop and api keys in one order, per owner", async () => {
    process.env.DESKTOP_KEYS_ENABLED = "true";
    try {
      const t = convexTest(schema, modules);
      await seedProEntitlement(t, "user-pro");
      await seedApiEntitlement(t, "user-api");
      // Owner A: one generic row older than a desktop row (a downgraded API
      // customer who later minted a desktop key), plus a revoked row that must
      // not take a slot.
      await t.run(async (ctx) => {
        await ctx.db.insert("userApiKeys", {
          userId: "user-pro", name: "revoked", keyPrefix: "wm_0000a", keyHash: "a".repeat(64),
          createdAt: NOW - 5_000, revokedAt: NOW - 4_000,
        });
        await ctx.db.insert("userApiKeys", {
          userId: "user-pro", name: "generic", keyPrefix: "wm_0000b", keyHash: "b".repeat(64),
          createdAt: NOW - 3_000,
        });
      });
      const desktop = await t.withIdentity(PRO_USER).mutation(api.apiKeys.createApiKey, desktopArgs(7));
      // Owner B's keys never influence owner A's ranks.
      await t.withIdentity(API_USER).mutation(api.apiKeys.createApiKey, makeKeyArgs(9));

      const generic = await t.query(internal.apiKeys.validateKeyByHash, { keyHash: "b".repeat(64) });
      const desk = await t.query(internal.apiKeys.validateKeyByHash, { keyHash: desktopArgs(7).keyHash });
      const other = await t.query(internal.apiKeys.validateKeyByHash, { keyHash: makeKeyArgs(9).keyHash });
      expect(generic).toMatchObject({ keyKind: "api", activeKeyRank: 0 });
      expect(desk).toMatchObject({ keyKind: "desktop", activeKeyRank: 1 });
      expect(other).toMatchObject({ keyKind: "api", activeKeyRank: 0 });
      expect(desktop.keyKind).toBe("desktop");
    } finally {
      delete process.env.DESKTOP_KEYS_ENABLED;
    }
  });

  test("Company Monitoring keys take no desktop slot or rank for a downgraded owner", async () => {
    process.env.DESKTOP_KEYS_ENABLED = "true";
    try {
      const t = convexTest(schema, modules);
      await seedProEntitlement(t, "user-pro");
      // Two scoped keys left over from an API plan. Every desktop-aware
      // validator rejects them, so they must not use up the Pro allowance.
      await t.run(async (ctx) => {
        for (const [i, c] of ["c", "d"].entries()) {
          await ctx.db.insert("userApiKeys", {
            userId: "user-pro", name: `scoped-${c}`, keyPrefix: `wm_0000${c}`, keyHash: c.repeat(64),
            scopes: ["company_monitoring:read"], companyMonitoringAccountId: "acct-1",
            createdAt: NOW - 5_000 + i,
          });
        }
        await ctx.db.insert("userApiKeys", {
          userId: "user-pro", name: "generic", keyPrefix: "wm_0000e", keyHash: "e".repeat(64),
          createdAt: NOW - 3_000,
        });
      });

      const generic = await t.query(internal.apiKeys.validateKeyByHash, { keyHash: "e".repeat(64) });
      expect(generic).toMatchObject({ keyKind: "api", activeKeyRank: 0 });
      // Pro cap is 2: the generic key holds one slot, so one desktop key fits.
      await t.withIdentity(PRO_USER).mutation(api.apiKeys.createApiKey, desktopArgs(1));
      await expect(
        t.withIdentity(PRO_USER).mutation(api.apiKeys.createApiKey, desktopArgs(2)),
      ).rejects.toThrow(/DESKTOP_KEY_LIMIT_REACHED/);
    } finally {
      delete process.env.DESKTOP_KEYS_ENABLED;
    }
  });
});

// ---------------------------------------------------------------------------
// getKeyOwner (internal)
// ---------------------------------------------------------------------------

describe("getKeyOwner", () => {
  test("returns owner regardless of revoked status", async () => {
    const t = convexTest(schema, modules);
    await seedApiEntitlement(t, "user-api");

    const asApiUser = t.withIdentity(API_USER);
    const created = await asApiUser.mutation(api.apiKeys.createApiKey, makeKeyArgs(1));
    await asApiUser.mutation(api.apiKeys.revokeApiKey, { keyId: created.id });

    const result = await t.query(internal.apiKeys.getKeyOwner, {
      keyHash: makeKeyArgs(1).keyHash,
    });
    expect(result).toEqual({ userId: "user-api" });
  });

  test("returns null for nonexistent hash", async () => {
    const t = convexTest(schema, modules);

    const result = await t.query(internal.apiKeys.getKeyOwner, {
      keyHash: "f".repeat(64),
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// touchKeyLastUsed (internal) — debounce
// ---------------------------------------------------------------------------

describe("touchKeyLastUsed", () => {
  test("sets lastUsedAt on first call", async () => {
    const t = convexTest(schema, modules);
    await seedApiEntitlement(t, "user-api");

    const created = await t.withIdentity(API_USER).mutation(
      api.apiKeys.createApiKey,
      makeKeyArgs(1),
    );

    await t.mutation(internal.apiKeys.touchKeyLastUsed, { keyId: created.id });

    const keys = await t.withIdentity(API_USER).query(api.apiKeys.listApiKeys, {});
    const key = keys.find((k: any) => k.id === created.id);
    expect(key?.lastUsedAt).toBeGreaterThan(0);
  });

  test("skips write for revoked key", async () => {
    const t = convexTest(schema, modules);
    await seedApiEntitlement(t, "user-api");

    const asApiUser = t.withIdentity(API_USER);
    const created = await asApiUser.mutation(api.apiKeys.createApiKey, makeKeyArgs(1));
    await asApiUser.mutation(api.apiKeys.revokeApiKey, { keyId: created.id });

    // Should not throw
    await t.mutation(internal.apiKeys.touchKeyLastUsed, { keyId: created.id });
  });
});

// ---------------------------------------------------------------------------
// Desktop keys (plan 2026-10-25-001, U2)
//
// A desktop key is a `userApiKeys` row with keyKind "desktop". Issuance is
// gated by the DESKTOP_KEYS_ENABLED Convex env flag (Deploy Order step 3) and
// the merged desktop-key predicate; the cap is the plan's maxDesktopKeys and
// counts a downgraded owner's still-working generic keys too (R5, KTD5).
// ---------------------------------------------------------------------------

const PRO_BUSINESS_USER = { subject: "user-pro-biz", tokenIdentifier: "clerk|user-pro-biz" };

function desktopArgs(n: number) {
  return { ...makeKeyArgs(n), keyKind: "desktop" as const };
}

async function seedEntitlementRow(
  t: ReturnType<typeof convexTest>,
  userId: string,
  planKey: string,
  opts: { validUntil?: number; stripDesktopFields?: boolean } = {},
) {
  await t.run(async (ctx) => {
    const features: any = { ...getFeaturesForPlan(planKey) };
    if (opts.stripDesktopFields) {
      // A row written before desktop keys existed: no flag, no cap, no limits.
      delete features.desktopKeyAccess;
      delete features.maxDesktopKeys;
      features.planLimits = { ...features.planLimits };
      delete features.planLimits.desktopKeyRequestsPerDay;
      delete features.planLimits.desktopKeyBurstPerMinute;
    }
    await ctx.db.insert("entitlements", {
      userId,
      planKey,
      features,
      validUntil: opts.validUntil ?? FUTURE,
      updatedAt: NOW,
    });
  });
}

async function seedKeyRows(
  t: ReturnType<typeof convexTest>,
  userId: string,
  rows: Array<{ n: number; keyKind?: "api" | "desktop"; revoked?: boolean }>,
) {
  await t.run(async (ctx) => {
    const now = Date.now();
    for (const row of rows) {
      const args = makeKeyArgs(row.n);
      await ctx.db.insert("userApiKeys", {
        userId,
        name: args.name,
        keyPrefix: args.keyPrefix,
        keyHash: args.keyHash,
        createdAt: now - (100 - row.n) * 1000,
        ...(row.keyKind ? { keyKind: row.keyKind } : {}),
        ...(row.revoked ? { revokedAt: now } : {}),
      });
    }
  });
}

describe("desktop keys", () => {
  beforeEach(() => {
    process.env.DESKTOP_KEYS_ENABLED = "true";
  });
  afterEach(() => {
    delete process.env.DESKTOP_KEYS_ENABLED;
  });

  test("Pro owner creates a desktop key; row and result carry keyKind desktop", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");

    const created = await t.withIdentity(PRO_USER).mutation(
      api.apiKeys.createApiKey,
      desktopArgs(1),
    );
    expect(created).toMatchObject({ name: "test-key-1", keyPrefix: "wm_00001", keyKind: "desktop" });

    const row = await t.run(async (ctx) => ctx.db.get(created.id));
    expect(row?.keyKind).toBe("desktop");
  });

  test("AE3: third desktop key on Pro fails with the limit error", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");
    const asPro = t.withIdentity(PRO_USER);

    await asPro.mutation(api.apiKeys.createApiKey, desktopArgs(1));
    await asPro.mutation(api.apiKeys.createApiKey, desktopArgs(2));
    await expect(
      asPro.mutation(api.apiKeys.createApiKey, desktopArgs(3)),
    ).rejects.toThrow(/DESKTOP_KEY_LIMIT_REACHED/);
  });

  test("Pro Business stops at three desktop keys", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlementRow(t, "user-pro-biz", "pro_business_monthly");
    const asBiz = t.withIdentity(PRO_BUSINESS_USER);

    for (let i = 1; i <= 3; i++) {
      await asBiz.mutation(api.apiKeys.createApiKey, desktopArgs(i));
    }
    await expect(
      asBiz.mutation(api.apiKeys.createApiKey, desktopArgs(4)),
    ).rejects.toThrow(/DESKTOP_KEY_LIMIT_REACHED/);
  });

  test("downgraded owner with three generic keys cannot create a desktop key", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");
    // Two legacy rows (no keyKind) and one explicit api row, all still active.
    await seedKeyRows(t, "user-pro", [{ n: 1 }, { n: 2 }, { n: 3, keyKind: "api" }]);

    await expect(
      t.withIdentity(PRO_USER).mutation(api.apiKeys.createApiKey, desktopArgs(10)),
    ).rejects.toThrow(/DESKTOP_KEY_LIMIT_REACHED/);
  });

  test("downgraded owner: one generic key plus one desktop key fills the Pro cap", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");
    await seedKeyRows(t, "user-pro", [{ n: 1 }, { n: 2, revoked: true }]);
    const asPro = t.withIdentity(PRO_USER);

    await asPro.mutation(api.apiKeys.createApiKey, desktopArgs(10));
    await expect(
      asPro.mutation(api.apiKeys.createApiKey, desktopArgs(11)),
    ).rejects.toThrow(/DESKTOP_KEY_LIMIT_REACHED/);
  });

  test("free account cannot create a desktop key", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.withIdentity(FREE_USER).mutation(api.apiKeys.createApiKey, desktopArgs(1)),
    ).rejects.toThrow(/DESKTOP_KEY_ACCESS_REQUIRED/);

    await seedEntitlementRow(t, "user-free", "free");
    await expect(
      t.withIdentity(FREE_USER).mutation(api.apiKeys.createApiKey, desktopArgs(1)),
    ).rejects.toThrow(/DESKTOP_KEY_ACCESS_REQUIRED/);
  });

  test("lapsed Pro owner cannot create a desktop key", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro", { validUntil: PAST });
    await expect(
      t.withIdentity(PRO_USER).mutation(api.apiKeys.createApiKey, desktopArgs(1)),
    ).rejects.toThrow(/DESKTOP_KEY_ACCESS_REQUIRED/);
  });

  test("API Starter owner cannot create a desktop key", async () => {
    const t = convexTest(schema, modules);
    await seedApiEntitlement(t, "user-api");
    await expect(
      t.withIdentity(API_USER).mutation(api.apiKeys.createApiKey, desktopArgs(1)),
    ).rejects.toThrow(/DESKTOP_KEY_ACCESS_REQUIRED/);
  });

  test("Pro still cannot create an api key, with or without an explicit kind", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");
    const asPro = t.withIdentity(PRO_USER);

    await expect(
      asPro.mutation(api.apiKeys.createApiKey, makeKeyArgs(1)),
    ).rejects.toThrow(/API_ACCESS_REQUIRED/);
    await expect(
      asPro.mutation(api.apiKeys.createApiKey, { ...makeKeyArgs(1), keyKind: "api" }),
    ).rejects.toThrow(/API_ACCESS_REQUIRED/);
  });

  test("legacy Pro entitlement row without desktopKeyAccess can create after merge", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlementRow(t, "user-pro", "pro_monthly", { stripDesktopFields: true });
    const asPro = t.withIdentity(PRO_USER);

    await asPro.mutation(api.apiKeys.createApiKey, desktopArgs(1));
    await asPro.mutation(api.apiKeys.createApiKey, desktopArgs(2));
    // The cap also comes from the catalog merge, not the (missing) stored value.
    await expect(
      asPro.mutation(api.apiKeys.createApiKey, desktopArgs(3)),
    ).rejects.toThrow(/DESKTOP_KEY_LIMIT_REACHED/);
  });

  test("desktop keys reject Company Monitoring scopes", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");
    await expect(
      t.withIdentity(PRO_USER).mutation(api.apiKeys.createApiKey, {
        ...desktopArgs(1),
        scopes: ["company_monitoring:read"],
      }),
    ).rejects.toThrow(/INVALID_API_KEY_SCOPES/);
    const rows = await t.run(async (ctx) => ctx.db.query("userApiKeys").collect());
    expect(rows).toHaveLength(0);
  });

  test("desktop keys keep prefix, hash, name, and duplicate-hash validation", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");
    const asPro = t.withIdentity(PRO_USER);

    await expect(
      asPro.mutation(api.apiKeys.createApiKey, { ...desktopArgs(1), keyPrefix: "wm_toolong00" }),
    ).rejects.toThrow(/INVALID_PREFIX/);
    await expect(
      asPro.mutation(api.apiKeys.createApiKey, { ...desktopArgs(1), keyHash: "nope" }),
    ).rejects.toThrow(/INVALID_HASH/);
    await expect(
      asPro.mutation(api.apiKeys.createApiKey, { ...desktopArgs(1), name: "  " }),
    ).rejects.toThrow(/INVALID_NAME/);

    await asPro.mutation(api.apiKeys.createApiKey, desktopArgs(1));
    await expect(
      asPro.mutation(api.apiKeys.createApiKey, { ...desktopArgs(1), name: "other" }),
    ).rejects.toThrow(/DUPLICATE_KEY/);
  });

  test("flag off: desktop creation is refused for everyone", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");
    await seedEntitlementRow(t, "user-pro-biz", "pro_business_monthly");

    for (const value of [undefined, "false", "1", "TRUE"]) {
      if (value === undefined) delete process.env.DESKTOP_KEYS_ENABLED;
      else process.env.DESKTOP_KEYS_ENABLED = value;
      for (const identity of [PRO_USER, PRO_BUSINESS_USER, FREE_USER, API_USER]) {
        await expect(
          t.withIdentity(identity).mutation(api.apiKeys.createApiKey, desktopArgs(1)),
        ).rejects.toThrow(/DESKTOP_KEYS_DISABLED/);
      }
    }
    const rows = await t.run(async (ctx) => ctx.db.query("userApiKeys").collect());
    expect(rows).toHaveLength(0);
  });

  test("kill switch: with the flag off an existing desktop row validates null; an api row is unaffected", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");
    await seedApiEntitlement(t, "user-api");
    const desk = await t.withIdentity(PRO_USER).mutation(api.apiKeys.createApiKey, desktopArgs(1));
    const generic = await t.withIdentity(API_USER).mutation(api.apiKeys.createApiKey, makeKeyArgs(2));
    expect(await t.query(internal.apiKeys.validateKeyByHash, { keyHash: desktopArgs(1).keyHash })).toMatchObject({ id: desk.id, keyKind: "desktop" });

    for (const value of [undefined, "false", "TRUE"]) {
      if (value === undefined) delete process.env.DESKTOP_KEYS_ENABLED;
      else process.env.DESKTOP_KEYS_ENABLED = value;
      expect(await t.query(internal.apiKeys.validateKeyByHash, { keyHash: desktopArgs(1).keyHash })).toBeNull();
      expect(await t.query(internal.apiKeys.validateKeyByHash, { keyHash: makeKeyArgs(2).keyHash })).toMatchObject({ id: generic.id, keyKind: "api" });
    }

    // Flipping it back on restores the key: nothing was rewritten.
    process.env.DESKTOP_KEYS_ENABLED = "true";
    expect(await t.query(internal.apiKeys.validateKeyByHash, { keyHash: desktopArgs(1).keyHash })).toMatchObject({ id: desk.id, keyKind: "desktop" });
    const row = await t.run(async (ctx) => ctx.db.get(desk.id));
    expect(row?.revokedAt).toBeUndefined();
  });

  test("flag off does not affect api key creation", async () => {
    delete process.env.DESKTOP_KEYS_ENABLED;
    const t = convexTest(schema, modules);
    await seedApiEntitlement(t, "user-api");
    const created = await t.withIdentity(API_USER).mutation(
      api.apiKeys.createApiKey,
      makeKeyArgs(1),
    );
    expect(created.keyKind).toBe("api");
  });

  test("revoking a desktop key frees a slot", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");
    const asPro = t.withIdentity(PRO_USER);

    const first = await asPro.mutation(api.apiKeys.createApiKey, desktopArgs(1));
    await asPro.mutation(api.apiKeys.createApiKey, desktopArgs(2));
    await expect(
      asPro.mutation(api.apiKeys.createApiKey, desktopArgs(3)),
    ).rejects.toThrow(/DESKTOP_KEY_LIMIT_REACHED/);

    const revoked = await asPro.mutation(api.apiKeys.revokeApiKey, { keyId: first.id });
    expect(revoked).toEqual({ ok: true, keyHash: makeKeyArgs(1).keyHash });
    const third = await asPro.mutation(api.apiKeys.createApiKey, desktopArgs(3));
    expect(third.keyKind).toBe("desktop");
  });

  test("desktop rows do not count against, and are never revoked by, the api-key limit", async () => {
    // R8 upgrade case: a Pro owner's two desktop keys survive an upgrade to
    // API Starter, and the owner still gets the full five api keys.
    const t = convexTest(schema, modules);
    await seedApiEntitlement(t, "user-api");
    await seedKeyRows(t, "user-api", [
      { n: 90, keyKind: "desktop" },
      { n: 91, keyKind: "desktop" },
    ]);
    const asApi = t.withIdentity(API_USER);

    for (let i = 1; i <= 5; i++) {
      await asApi.mutation(api.apiKeys.createApiKey, makeKeyArgs(i));
    }
    await expect(
      asApi.mutation(api.apiKeys.createApiKey, makeKeyArgs(6)),
    ).rejects.toThrow(/KEY_LIMIT_REACHED/);

    const keys = await asApi.query(api.apiKeys.listApiKeys, {});
    const desktop = keys.filter((k: any) => k.keyKind === "desktop");
    expect(desktop).toHaveLength(2);
    expect(desktop.every((k: any) => !k.revokedAt)).toBe(true);
  });

  test("api overflow convergence revokes only api rows, never desktop rows", async () => {
    const t = convexTest(schema, modules);
    await seedApiEntitlement(t, "user-api");
    // Desktop rows are the OLDEST, so an oldest-first revoke that ignored kind
    // would hit them first.
    await seedKeyRows(t, "user-api", [
      { n: 1, keyKind: "desktop" },
      { n: 2, keyKind: "desktop" },
      { n: 3 },
      { n: 4 },
      { n: 5 },
      { n: 6, keyKind: "api" },
      { n: 7, keyKind: "api" },
      { n: 8, keyKind: "api" },
    ]);
    const asApi = t.withIdentity(API_USER);
    await asApi.mutation(api.apiKeys.createApiKey, makeKeyArgs(20));

    const keys = await asApi.query(api.apiKeys.listApiKeys, {});
    const activeApi = keys.filter((k: any) => !k.revokedAt && k.keyKind === "api");
    const activeDesktop = keys.filter((k: any) => !k.revokedAt && k.keyKind === "desktop");
    expect(activeApi).toHaveLength(5);
    expect(activeDesktop).toHaveLength(2);
    // Six active api rows converge to four plus the new one: the two oldest
    // API rows go, the older desktop rows stay.
    expect(keys.filter((k: any) => k.revokedAt).map((k: any) => k.name).sort()).toEqual([
      "test-key-3",
      "test-key-4",
    ]);
  });

  test("listApiKeys returns keyKind, mapping legacy rows to api", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");
    await seedKeyRows(t, "user-pro", [{ n: 1 }]);
    await t.withIdentity(PRO_USER).mutation(api.apiKeys.createApiKey, desktopArgs(2));

    const keys = await t.withIdentity(PRO_USER).query(api.apiKeys.listApiKeys, {});
    const byName = Object.fromEntries(keys.map((k: any) => [k.name, k.keyKind]));
    expect(byName).toEqual({ "test-key-1": "api", "test-key-2": "desktop" });
  });

  test("validate-by-hash returns desktop for new desktop rows and api for legacy and api rows", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");
    await seedApiEntitlement(t, "user-api");
    await seedKeyRows(t, "user-pro", [{ n: 1 }]); // legacy, no keyKind
    await t.withIdentity(PRO_USER).mutation(api.apiKeys.createApiKey, desktopArgs(2));
    await t.withIdentity(API_USER).mutation(api.apiKeys.createApiKey, makeKeyArgs(3));

    const kindOf = async (n: number) =>
      (await t.query(internal.apiKeys.validateKeyByHash, { keyHash: makeKeyArgs(n).keyHash }))
        ?.keyKind;
    expect(await kindOf(1)).toBe("api");
    expect(await kindOf(2)).toBe("desktop");
    expect(await kindOf(3)).toBe("api");
  });

  test("validate-by-hash returns null for a revoked desktop key", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, "user-pro");
    const asPro = t.withIdentity(PRO_USER);
    const created = await asPro.mutation(api.apiKeys.createApiKey, desktopArgs(1));
    await asPro.mutation(api.apiKeys.revokeApiKey, { keyId: created.id });

    const result = await t.query(internal.apiKeys.validateKeyByHash, {
      keyHash: makeKeyArgs(1).keyHash,
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HTTP route /api/internal-validate-api-key — touch scheduling gate
//
// Convex Insights (2026-08): apiKeys:touchKeyLastUsed produced 1,036 OCC
// write conflicts on userApiKeys in 14 days (max retry depth 3), because the
// route scheduled a touch on EVERY validation and the mutation's internal
// 5-minute debounce is a read-then-write: at each debounce-boundary every
// concurrently scheduled touch reads the same stale lastUsedAt and they all
// patch the same hot document. The gate moves the staleness check to the
// route, so a fresh key schedules NOTHING — the herd never forms.
//
// The observable for "was a touch scheduled": queue a validate inside the
// debounce window, let the fake clock pass the boundary, THEN drain the
// scheduler. A queued touch would now see a stale lastUsedAt and write; a
// gated route queued nothing, so lastUsedAt must not move.
// ---------------------------------------------------------------------------

describe("HTTP route /api/internal-validate-api-key — touch scheduling gate", () => {
  const SHARED_SECRET = "test-shared-secret";
  const T0 = new Date("2026-08-13T00:00:00Z").getTime();

  beforeEach(() => {
    process.env.CONVEX_SERVER_SHARED_SECRET = SHARED_SECRET;
  });
  afterEach(() => {
    delete process.env.CONVEX_SERVER_SHARED_SECRET;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function validate(t: ReturnType<typeof convexTest>, keyHash: string) {
    return t.fetch("/api/internal-validate-api-key", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-convex-shared-secret": SHARED_SECRET,
      },
      body: JSON.stringify({ keyHash }),
    });
  }

  async function readLastUsedAt(t: ReturnType<typeof convexTest>, keyHash: string) {
    return t.run(async (ctx) => {
      const row = await ctx.db
        .query("userApiKeys")
        .withIndex("by_keyHash", (q) => q.eq("keyHash", keyHash))
        .unique();
      return row?.lastUsedAt;
    });
  }

  test("validate inside the debounce window schedules no touch; after expiry it does", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const t = convexTest(schema, modules);
    await seedApiEntitlement(t, "user-api");
    await t.withIdentity(API_USER).mutation(api.apiKeys.createApiKey, makeKeyArgs(1));
    const keyHash = makeKeyArgs(1).keyHash;

    // Phase 1 — first validate: lastUsedAt unset, so the touch must be scheduled.
    const res1 = await validate(t, keyHash);
    expect(res1.status).toBe(200);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await readLastUsedAt(t, keyHash)).toBe(T0);

    // Phase 2 — validate at T0+2min (inside the 5-min debounce). Leave the
    // scheduler undrained and move past the boundary before draining: a
    // queued touch would execute with a stale read and write T0+6min.
    vi.setSystemTime(T0 + 2 * 60_000);
    const res2 = await validate(t, keyHash);
    expect(res2.status).toBe(200);
    vi.setSystemTime(T0 + 6 * 60_000);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await readLastUsedAt(t, keyHash)).toBe(T0);

    // Phase 3 — validate after expiry: the gate must reopen.
    const res3 = await validate(t, keyHash);
    expect(res3.status).toBe(200);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await readLastUsedAt(t, keyHash)).toBe(T0 + 6 * 60_000);
  });

  // Convex Insights (2026-10): the gate above still let 560 OCC conflicts
  // through in 72h. Every validation that lands between the debounce expiring
  // and the first touch committing sees a stale lastUsedAt, so a burst of
  // parallel requests schedules a herd of touches for the same instant and
  // all but one lose the write race. Spreading the herd lets the first touch
  // commit before the rest run, so they read a fresh lastUsedAt and no-op.
  test("concurrent validations of a stale key spread their touches over time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const t = convexTest(schema, modules);
    await seedApiEntitlement(t, "user-api");
    await t.withIdentity(API_USER).mutation(api.apiKeys.createApiKey, makeKeyArgs(1));
    const keyHash = makeKeyArgs(1).keyHash;

    const random = vi.spyOn(Math, "random");
    for (const r of [0.1, 0.5, 0.9]) {
      random.mockReturnValue(r);
      expect((await validate(t, keyHash)).status).toBe(200);
    }
    random.mockRestore();

    const touchTimes = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect())
        .filter((job) => job.name.includes("touchKeyLastUsed"))
        .map((job) => job.scheduledTime),
    );
    expect(touchTimes.sort((a, b) => a - b)).toEqual([T0 + 3_000, T0 + 15_000, T0 + 27_000]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  test("response body does not leak lastUsedAt (gateway contract unchanged)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const t = convexTest(schema, modules);
    await seedApiEntitlement(t, "user-api");
    await t.withIdentity(API_USER).mutation(api.apiKeys.createApiKey, makeKeyArgs(1));

    const res = await validate(t, makeKeyArgs(1).keyHash);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["activeKeyRank", "id", "keyKind", "name", "userId"]);
    expect(body.keyKind).toBe("api");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  test("response body carries keyKind desktop for a desktop row and api for a legacy row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    // A desktop row validates only while the kill switch is on (the same flag
    // that gates issuance); the route contract below is what the edge caches.
    process.env.DESKTOP_KEYS_ENABLED = "true";
    try {
      const t = convexTest(schema, modules);
      await seedKeyRows(t, "user-pro", [{ n: 1 }, { n: 2, keyKind: "desktop" }]);

      const legacy = await validate(t, makeKeyArgs(1).keyHash);
      expect(((await legacy.json()) as Record<string, unknown>).keyKind).toBe("api");
      const desktop = await validate(t, makeKeyArgs(2).keyHash);
      const body = (await desktop.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ userId: "user-pro", name: "test-key-2", keyKind: "desktop" });
      expect(Object.keys(body).sort()).toEqual(["activeKeyRank", "id", "keyKind", "name", "userId"]);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      delete process.env.DESKTOP_KEYS_ENABLED;
    }
  });
});
