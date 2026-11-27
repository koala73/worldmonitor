import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import * as registry from "../accountDeletion/registry";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");
const { recompute } = vi.hoisted(() => ({ recompute: vi.fn() }));
vi.mock("../payments/subscriptionHelpers", async (original) => ({
  ...await original<typeof import("../payments/subscriptionHelpers")>(),
  recomputeEntitlementFromAllSubs: recompute,
}));

beforeEach(() => {
  vi.useFakeTimers();
  recompute.mockReset().mockRejectedValue(new Error("temporary write failure"));
});
afterEach(() => {
  vi.restoreAllMocks();
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

test("a failed personal batch resumes from the committed table cursor", async () => {
  const t = convexTest(schema, modules);
  const userId = "paged-owner";
  const { deletionId, firstId, lastId, keyId } = await t.run(async (ctx) => {
    const firstId = await ctx.db.insert("userPreferences", {
      userId, variant: "full", data: {}, schemaVersion: 1, syncVersion: 1, updatedAt: 1,
    });
    for (let i = 0; i < registry.ERASE_WRITE_BUDGET; i++) {
      await ctx.db.insert("userPreferenceWriteRateLimits", {
        userId, windowStart: i, count: 1, updatedAt: 1,
      });
    }
    const lastId = await ctx.db.insert("userPreferenceWriteRateLimits", {
      userId, windowStart: registry.ERASE_WRITE_BUDGET, count: 1, updatedAt: 1,
    });
    const keyId = await ctx.db.insert("userApiKeys", {
      userId, name: "retry-key", keyPrefix: "wm_retry", keyHash: "c".repeat(64), createdAt: 1,
    });
    const deletionId = await ctx.db.insert("accountDeletions", {
      userId, userIdHash: "c".repeat(64), source: "self", status: "pending",
      step: "personal", personalTableIndex: 0, startedAt: 1, updatedAt: 1,
    });
    return { deletionId, firstId, lastId, keyId };
  });

  await t.mutation(internal.accountDeletion.batches.advanceErase, { deletionId });
  const committed = await t.query(internal.accountDeletion.batches.getBatchSnapshot, { deletionId });
  expect(committed).toMatchObject({ step: "personal", personalTableIndex: 1 });
  expect(await t.run((ctx) => ctx.db.get(firstId))).toBeNull();

  vi.spyOn(registry, "mergeUniqueStrings").mockImplementationOnce(() => {
    throw new Error("temporary key cleanup failure");
  });
  await vi.runOnlyPendingTimersAsync();
  await t.finishInProgressScheduledFunctions();
  await t.run(async (ctx) => {
    expect(await ctx.db.get(deletionId)).toMatchObject({
      status: "pending", step: "personal", personalTableIndex: committed?.personalTableIndex,
      lastError: "ERASE_BATCH_RETRY", batchAttempts: 1,
    });
    expect(await ctx.db.get(lastId)).not.toBeNull();
    expect(await ctx.db.get(keyId)).not.toBeNull();
  });

  // Seed into the completed table directly so a retry that restarts at zero is observable.
  const earlierId = await t.run((ctx) => ctx.db.insert("userPreferences", {
    userId, variant: "coverage", data: {}, schemaVersion: 1, syncVersion: 1, updatedAt: 1,
  }));
  await vi.runOnlyPendingTimersAsync();
  await t.finishInProgressScheduledFunctions();
  await t.run(async (ctx) => {
    expect(await ctx.db.get(earlierId)).not.toBeNull();
    expect(await ctx.db.query("userPreferenceWriteRateLimits").collect()).toEqual([]);
    expect(await ctx.db.get(keyId)).toBeNull();
    expect(await ctx.db.get(deletionId)).toMatchObject({ step: "external" });
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
