import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");
const { recompute } = vi.hoisted(() => ({ recompute: vi.fn() }));
vi.mock("../payments/subscriptionHelpers", async (original) => ({
  ...await original<typeof import("../payments/subscriptionHelpers")>(),
  recomputeEntitlementFromAllSubs: recompute,
}));

// Throws inside the personal walk: erasePersonal calls mergeUniqueStrings when
// it reaches userApiKeys, so arming this fails that page mid-walk.
const { mergeFailures } = vi.hoisted(() => ({ mergeFailures: { remaining: 0 } }));
vi.mock("../accountDeletion/registry", async (original) => {
  const real = await original<typeof import("../accountDeletion/registry")>();
  return {
    ...real,
    mergeUniqueStrings: (...args: Parameters<typeof real.mergeUniqueStrings>) => {
      if (mergeFailures.remaining > 0) {
        mergeFailures.remaining -= 1;
        throw new Error("injected write conflict");
      }
      return real.mergeUniqueStrings(...args);
    },
  };
});

beforeEach(() => {
  vi.useFakeTimers();
  recompute.mockReset().mockRejectedValue(new Error("temporary write failure"));
  mergeFailures.remaining = 0;
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => ({
    deletionId: await ctx.db.insert("accountDeletions", {
      userId: "owner", userIdHash: "a".repeat(64), source: "self", status: "pending",
      step: "grants", dodoSubscriptionIds: ["sub_owner"], startedAt: 1, updatedAt: 1,
    }),
    grantId: await ctx.db.insert("businessProGrants", {
      businessSubscriptionId: "sub_owner", ownerUserId: "owner", inviteeUserId: "survivor",
      inviteeEmail: "survivor@company.test", domain: "company.test", status: "accepted",
      createdAt: 1, acceptedAt: 1, expiresAt: Date.now() + 86_400_000,
    }),
  }));
  return { t, ...ids };
}

test("a failed batch rolls back its writes and retries before going terminal", async () => {
  const { t, deletionId, grantId } = await setup();
  await t.action(internal.accountDeletion.batches.advanceEraseSafely, { deletionId });

  // A single batch throw is usually a lost optimistic-concurrency retry on a
  // shared aggregate row, not a broken deletion. Going terminal here would
  // strand a half-erased account behind the write fence with its subscription
  // still billing, so the first failure stays pending with a scheduled retry.
  await t.run(async (ctx) => {
    expect(await ctx.db.get(grantId)).not.toBeNull();
    expect(await ctx.db.get(deletionId)).toMatchObject({
      status: "pending", step: "grants", lastError: "ERASE_BATCH_RETRY", batchAttempts: 1,
    });
    expect(await ctx.db.system.query("_scheduled_functions").collect()).toHaveLength(1);
  });

  // Exhausting the ladder is what goes terminal, and it stops scheduling.
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  await t.run(async (ctx) => {
    expect(await ctx.db.get(grantId)).not.toBeNull();
    expect(await ctx.db.get(deletionId)).toMatchObject({
      status: "failed", step: "grants", lastError: "ERASE_BATCH_FAILED", batchAttempts: 5,
    });
    expect(await ctx.db.system.query("_scheduled_functions").collect()
      .then((jobs) => jobs.filter((job) => job.state.kind === "pending"))).toEqual([]);
  });

  // Explicit retry restores pending; the same batch can then finish, and
  // committed progress clears the counter so the next failure starts fresh.
  recompute.mockResolvedValue(undefined);
  await t.run((ctx) => ctx.db.patch(deletionId, { status: "pending", lastError: undefined }));
  await t.action(internal.accountDeletion.batches.advanceEraseSafely, { deletionId });
  await t.run(async (ctx) => {
    expect(await ctx.db.get(grantId)).toBeNull();
    expect(await ctx.db.get(deletionId)).toMatchObject({ status: "pending", step: "external" });
    expect((await ctx.db.get(deletionId))?.batchAttempts).toBeUndefined();
  });
});

test.each(["step", "cursor", "updatedAt", "complete"])(
  "a stale failure cannot overwrite newer %s progress", async (change) => {
    const { t, deletionId } = await setup();
    const snapshot = await t.query(internal.accountDeletion.batches.getBatchSnapshot, { deletionId });
    expect(snapshot).not.toBeNull();
    await t.run((ctx) => ctx.db.patch(deletionId, {
      ...(change === "step" ? { step: "anonymize" as const } : {}),
      ...(change === "cursor" ? { personalTableIndex: 3 } : {}),
      ...(change === "updatedAt" ? { updatedAt: 2 } : {}),
      ...(change === "complete" ? { status: "complete" as const } : {}),
    }));
    // Assert the rejection reason, not just the resulting status: a retrying
    // (non-stale) call also leaves the row pending, so status alone no longer
    // discriminates a refused stale write from an accepted one.
    expect(await t.mutation(internal.accountDeletion.batches.markBatchFailed,
      { deletionId, ...snapshot! })).toBe("stale");
    expect((await t.run((ctx) => ctx.db.get(deletionId)))?.status)
      .toBe(change === "complete" ? "complete" : "pending");
    expect((await t.run((ctx) => ctx.db.get(deletionId)))?.batchAttempts).toBeUndefined();
  },
);

test("same-step pages stamp distinct progress even in the same millisecond", async () => {
  const t = convexTest(schema, modules);
  const deletionId = await t.run(async (ctx) => {
    for (let i = 0; i < 129; i++) {
      await ctx.db.insert("userPreferences", {
        userId: "paged", variant: `variant-${i}`, data: {}, schemaVersion: 1, syncVersion: 1, updatedAt: 1,
      });
    }
    return ctx.db.insert("accountDeletions", {
      userId: "paged", userIdHash: "b".repeat(64), source: "self", status: "pending",
      step: "personal", personalTableIndex: 0, startedAt: Date.now(), updatedAt: Date.now(),
    });
  });
  const start = await t.query(internal.accountDeletion.batches.getBatchSnapshot, { deletionId });
  await t.mutation(internal.accountDeletion.batches.advanceErase, { deletionId });
  const firstPage = await t.query(internal.accountDeletion.batches.getBatchSnapshot, { deletionId });
  await t.mutation(internal.accountDeletion.batches.advanceErase, { deletionId });
  const secondPage = await t.query(internal.accountDeletion.batches.getBatchSnapshot, { deletionId });
  expect(firstPage).toMatchObject({ step: "personal", personalTableIndex: 0 });
  expect(secondPage).toMatchObject({ step: "personal", personalTableIndex: 0 });
  expect(firstPage!.updatedAt).toBeGreaterThan(start!.updatedAt);
  expect(secondPage!.updatedAt).toBeGreaterThan(firstPage!.updatedAt);
  expect(await t.mutation(internal.accountDeletion.batches.markBatchFailed,
    { deletionId, ...firstPage! })).toBe("stale");
  await t.run(async (ctx) => {
    expect((await ctx.db.get(deletionId))?.status).toBe("pending");
    expect(await ctx.db.query("userPreferences").collect()).toHaveLength(1);
  });
});

test("a failure mid personal walk retries from the recorded table cursor", async () => {
  // PERSONAL_DELETE_TABLES order: userPreferences(0), userPreferenceWriteRateLimits(1),
  // notificationChannels(2), alertRules(3), telegramPairingTokens(4), userApiKeys(5).
  const userId = "walker";
  const t = convexTest(schema, modules);
  const deletionId = await t.run(async (ctx) => {
    for (let i = 0; i < 2; i++) {
      await ctx.db.insert("userPreferences", {
        userId, variant: `variant-${i}`, data: {}, schemaVersion: 1, syncVersion: 1, updatedAt: 1,
      });
    }
    await ctx.db.insert("userPreferenceWriteRateLimits", { userId, windowStart: 1, count: 1, updatedAt: 1 });
    await ctx.db.insert("notificationChannels", {
      userId, channelType: "email", email: "w@example.test", verified: true, linkedAt: 1,
    });
    // 4 writes above + 60 of these fill the 64-write budget inside alertRules,
    // so the first page commits with the cursor parked at table 3.
    for (let i = 0; i < 70; i++) {
      await ctx.db.insert("alertRules", {
        userId, variant: `variant-${i}`, enabled: true, eventTypes: [], sensitivity: "all",
        channels: [], updatedAt: 1,
      });
    }
    await ctx.db.insert("userApiKeys", {
      userId, name: "key", keyPrefix: "wm_walk0", keyHash: "hash_walker", createdAt: 1,
    });
    return ctx.db.insert("accountDeletions", {
      userId, userIdHash: "e".repeat(64), source: "self", status: "pending",
      step: "personal", personalTableIndex: 0, startedAt: 1, updatedAt: 1,
    });
  });
  const count = (table: "alertRules" | "userApiKeys" | "userPreferences") =>
    t.run(async (ctx) => (await ctx.db.query(table).collect()).length);

  await t.mutation(internal.accountDeletion.batches.advanceErase, { deletionId });
  expect(await t.run((ctx) => ctx.db.get(deletionId))).toMatchObject({
    step: "personal", personalTableIndex: 3,
  });
  expect(await count("alertRules")).toBe(10);

  // A row the retry must NOT reach if it honours the cursor. The write fence
  // keeps real rows out of already-walked tables; this is a probe that tells
  // "resumed at table 3" apart from "restarted at table 0".
  await t.run((ctx) => ctx.db.insert("userPreferences", {
    userId, variant: "probe", data: {}, schemaVersion: 1, syncVersion: 1, updatedAt: 1,
  }));

  // The second page deletes the last alertRules, then throws at userApiKeys.
  mergeFailures.remaining = 1;
  await t.action(internal.accountDeletion.batches.advanceEraseSafely, { deletionId });
  const failed = await t.run((ctx) => ctx.db.get(deletionId));
  expect(failed).toMatchObject({
    status: "pending", step: "personal", personalTableIndex: 3,
    batchAttempts: 1, lastError: "ERASE_BATCH_RETRY",
  });
  expect(failed?.keyHashes).toBeUndefined();
  // Rolled back, not half-applied.
  expect(await count("alertRules")).toBe(10);
  expect(await count("userApiKeys")).toBe(1);

  // The retry resumes at table 3: it finishes alertRules and userApiKeys (no
  // skip past the failed table) and never revisits table 0 (no reset).
  await t.action(internal.accountDeletion.batches.advanceEraseSafely, { deletionId });
  const resumed = await t.run((ctx) => ctx.db.get(deletionId));
  expect(resumed?.step).not.toBe("personal");
  expect(resumed?.batchAttempts).toBeUndefined();
  expect(resumed?.keyHashes).toEqual(["hash_walker"]);
  expect(await count("alertRules")).toBe(0);
  expect(await count("userApiKeys")).toBe(0);
  expect(await count("userPreferences")).toBe(1);
});
