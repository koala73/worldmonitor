import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import { PERSONAL_DELETE_TABLES } from "../accountDeletion/batches";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

type PersonalTable = (typeof PERSONAL_DELETE_TABLES)[number];

const DELETED = "user_erased";
const SURVIVOR = "user_survivor";

/**
 * One owned row per personal table. Adding a table to PERSONAL_DELETE_TABLES
 * without a seeder here fails the key-set test below (and the editor, via the
 * total Record type). The registry gate proves a table is walked; only this
 * proves a seeded row actually disappears.
 */
const SEEDERS: Record<PersonalTable, (ctx: MutationCtx, userId: string) => Promise<unknown>> = {
  userPreferences: (ctx, userId) => ctx.db.insert("userPreferences", {
    userId, variant: "full", data: {}, schemaVersion: 1, syncVersion: 1, updatedAt: 1,
  }),
  userPreferenceWriteRateLimits: (ctx, userId) => ctx.db.insert("userPreferenceWriteRateLimits", {
    userId, windowStart: 1, count: 1, updatedAt: 1,
  }),
  notificationChannels: (ctx, userId) => ctx.db.insert("notificationChannels", {
    userId, channelType: "email", email: `${userId}@example.test`, verified: true, linkedAt: 1,
  }),
  alertRules: (ctx, userId) => ctx.db.insert("alertRules", {
    userId, variant: "full", enabled: true, eventTypes: ["conflict"], sensitivity: "high",
    channels: ["email"], updatedAt: 1,
  }),
  telegramPairingTokens: (ctx, userId) => ctx.db.insert("telegramPairingTokens", {
    userId, token: `tok_${userId}`, expiresAt: 1, used: false,
  }),
  userApiKeys: (ctx, userId) => ctx.db.insert("userApiKeys", {
    userId, name: "key", keyPrefix: "wm_test0", keyHash: `api_${userId}`, createdAt: 1,
  }),
  embedKeys: (ctx, userId) => ctx.db.insert("embedKeys", {
    userId, name: "embed", keyPrefix: "wme_test0", keyHash: `embed_${userId}`, createdAt: 1,
  }),
  mcpProTokens: (ctx, userId) => ctx.db.insert("mcpProTokens", { userId, createdAt: 1 }),
  userReferralCodes: (ctx, userId) => ctx.db.insert("userReferralCodes", {
    userId, code: `ref_${userId}`, createdAt: 1,
  }),
  userReferralCredits: (ctx, userId) => ctx.db.insert("userReferralCredits", {
    referrerUserId: userId, refereeEmail: `referee-of-${userId}@example.test`, createdAt: 1,
  }),
  entitlements: (ctx, userId) => ctx.db.insert("entitlements", {
    userId, planKey: "pro_monthly",
    features: {
      tier: 1, maxDashboards: 1, apiAccess: false, apiRateLimit: 0,
      prioritySupport: false, exportFormats: [],
    },
    validUntil: 1, updatedAt: 1,
  }),
  apiUsageRollups: (ctx, userId) => ctx.db.insert("apiUsageRollups", {
    userId, planKey: "pro_monthly", dimension: "api_daily_requests", windowKey: "2026-09-23",
    windowStart: 1, windowEnd: 2, limit: 100, usage: 1, usageRatio: 0.01, source: "test",
    sourceFreshAt: 1, computedAt: 1,
  }),
  apiPlanLimitNotices: (ctx, userId) => ctx.db.insert("apiPlanLimitNotices", {
    userId, planKey: "pro_monthly", dimension: "api_daily_requests", state: "warning",
    windowKey: "2026-09-23", usage: 90, limit: 100, usageRatio: 0.9, current: true,
    firstSeenAt: 1, lastSeenAt: 1, emailStatus: "pending", ctaKind: "checkout",
  }),
  checkoutAdmissions: (ctx, userId) => ctx.db.insert("checkoutAdmissions", {
    userId, windowStart: 1, count: 1,
  }),
  followedCountriesUserMeta: (ctx, userId) => ctx.db.insert("followedCountriesUserMeta", {
    userId, count: 1, updatedAt: 1,
  }),
  users: (ctx, userId) => ctx.db.insert("users", { userId, firstSeenAt: 1, lastSeenAt: 1 }),
};

/**
 * Counted by full scan and owner field, deliberately NOT through an index: the
 * failure this guards is `takePersonalRows` querying the wrong index, paging
 * zero rows and reporting the table done. Reusing an index here could share
 * that mistake.
 */
async function ownedRows(ctx: MutationCtx, table: PersonalTable, userId: string): Promise<number> {
  const rows = await ctx.db.query(table).collect();
  return rows.filter((row) =>
    ("referrerUserId" in row ? row.referrerUserId : row.userId) === userId).length;
}

test("the seeder map covers exactly the tables the personal stepper walks", () => {
  expect(Object.keys(SEEDERS).sort()).toEqual([...PERSONAL_DELETE_TABLES].sort());
});

test("the personal step erases a seeded row from every personal table, and only the subject's", async () => {
  const t = convexTest(schema, modules);
  const deletionId = await t.run(async (ctx) => {
    for (const table of PERSONAL_DELETE_TABLES) {
      await SEEDERS[table](ctx, DELETED);
      await SEEDERS[table](ctx, SURVIVOR);
    }
    return ctx.db.insert("accountDeletions", {
      userId: DELETED, userIdHash: "d".repeat(64), source: "self", status: "pending",
      step: "personal", personalTableIndex: 0, startedAt: 1, updatedAt: 1,
    });
  });

  for (let page = 0; page < 10; page++) {
    const { step } = await t.mutation(internal.accountDeletion.batches.advanceErase, { deletionId });
    if (step !== "personal") break;
  }

  const counts = await t.run(async (ctx) => {
    const result: Record<string, { erased: number; survivor: number }> = {};
    for (const table of PERSONAL_DELETE_TABLES) {
      result[table] = {
        erased: await ownedRows(ctx, table, DELETED),
        survivor: await ownedRows(ctx, table, SURVIVOR),
      };
    }
    return { step: (await ctx.db.get(deletionId))?.step, tables: result };
  });
  expect(counts.step).not.toBe("personal");
  expect(counts.tables).toEqual(Object.fromEntries(
    PERSONAL_DELETE_TABLES.map((table) => [table, { erased: 0, survivor: 1 }]),
  ));
});
