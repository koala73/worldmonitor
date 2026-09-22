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

beforeEach(() => {
  vi.useFakeTimers();
  recompute.mockReset().mockRejectedValue(new Error("temporary write failure"));
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
