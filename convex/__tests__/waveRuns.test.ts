/**
 * Wave-loading state machine integration tests (PR 2).
 *
 * Covers the mutations + queries directly. Actions (pickWaveAction,
 * pushBatchAction, finalizeWaveAction) integrate Resend HTTP calls and
 * the Convex scheduler — those are exercised end-to-end on a test fork
 * with mocked Resend, not in this unit suite.
 *
 * Acceptance criteria mapped to tests in this file:
 *   - lease conflict (second claim refused)
 *   - underfill flag preserved through pick → finalize
 *   - empty pool → terminal no-op + lease cleared
 *   - CAS idempotency (_markContactPushed twice = +1 pushedCount once)
 *   - failure-rate threshold flips whole run
 *   - operator recovery routing (resumeStalled / resumeFinalize / discard)
 *   - confirmedNotSent gate on send-failure recovery
 *   - cleanup chunked deletion
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");

// convex-test 0.0.43 emits an unhandled rejection of shape
// `Error: Write outside of transaction <id>;_scheduled_functions` when a
// mutation under test calls `ctx.scheduler.runAfter(...)` and the framework
// later attempts to dispatch the scheduled action. This is a framework
// artifact (the scheduled action would touch `_scheduled_functions` outside
// the test's transactional fake) — not a bug in our code. Filter only this
// specific rejection so genuine errors still surface.
process.on("unhandledRejection", (err) => {
  if (err instanceof Error && /Write outside of transaction.*_scheduled_functions/.test(err.message)) {
    return; // swallow the convex-test scheduler-dispatch artifact
  }
  throw err;
});

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

const RAMP_KEY = "current";

async function seedRampConfig(t: ReturnType<typeof convexTest>): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("broadcastRampConfig", {
      key: RAMP_KEY,
      active: true,
      rampCurve: [1500, 5000, 15000, 25000],
      currentTier: 0,
      waveLabelPrefix: "pro-launch-wave",
      waveLabelOffset: 3,
      bounceKillThreshold: 0.04,
      complaintKillThreshold: 0.0008,
      killGateTripped: false,
    });
  });
}

async function seedRegistrations(
  t: ReturnType<typeof convexTest>,
  emails: string[],
): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    for (const email of emails) {
      await ctx.db.insert("registrations", {
        email,
        normalizedEmail: email.toLowerCase().trim(),
        registeredAt: now,
        appVersion: "test",
      });
    }
  });
}

async function readConfig(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) =>
    ctx.db
      .query("broadcastRampConfig")
      .withIndex("by_key", (q) => q.eq("key", RAMP_KEY))
      .unique(),
  );
}

async function readWaveRun(t: ReturnType<typeof convexTest>, runId: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("waveRuns")
      .withIndex("by_runId", (q) => q.eq("runId", runId))
      .unique(),
  );
}

async function readContacts(t: ReturnType<typeof convexTest>, runId: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("wavePickedContacts")
      .withIndex("by_runId", (q) => q.eq("runId", runId))
      .collect(),
  );
}

/** Helper: find a contact's _id by (runId, normalizedEmail). Tests call
 *  the mark-mutations by `contactId` after PR2 review-fix 9 (avoid the
 *  Convex 8192-doc-read scan limit). */
async function findContactId(
  t: ReturnType<typeof convexTest>,
  runId: string,
  normalizedEmail: string,
): Promise<string> {
  const all = await readContacts(t, runId);
  const match = all.find((c) => c.normalizedEmail === normalizedEmail);
  if (!match) throw new Error(`findContactId: no contact (${runId}, ${normalizedEmail})`);
  return match._id;
}

// ───────────────────────────────────────────────────────────────────────────
// _claimWaveRunLease
// ───────────────────────────────────────────────────────────────────────────

describe("_claimWaveRunLease", () => {
  test("claims lease when no holder + no active waveRun + no label collision", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    const result = await t.mutation(
      internal.broadcast.waveRuns._claimWaveRunLease,
      { waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 100, batchSize: 50 },
    );
    expect(result).toEqual({ ok: true, runId: "run-1" });
    const config = await readConfig(t);
    expect(config!.pendingRunId).toBe("run-1");
    expect(config!.pendingWaveLabel).toBe("pro-launch-wave-4");
    const run = await readWaveRun(t, "run-1");
    expect(run!.status).toBe("picking");
    expect(run!.requestedCount).toBe(100);
    expect(run!.batchSize).toBe(50);
  });

  test("refuses second claim while first lease is held", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 100, batchSize: 50,
    });
    const second = await t.mutation(
      internal.broadcast.waveRuns._claimWaveRunLease,
      { waveLabel: "pro-launch-wave-5", runId: "run-2", requestedCount: 100, batchSize: 50 },
    );
    expect(second).toMatchObject({ ok: false, reason: "lease-held", current: "run-1" });
  });

  test("refuses claim when waveLabel already has a stamped registration", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("registrations", {
        email: "stamped@example.com",
        normalizedEmail: "stamped@example.com",
        registeredAt: Date.now(),
        appVersion: "test",
        proLaunchWave: "pro-launch-wave-4",
      });
    });
    const result = await t.mutation(
      internal.broadcast.waveRuns._claimWaveRunLease,
      { waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 100, batchSize: 50 },
    );
    expect(result).toMatchObject({ ok: false, reason: "label-collides" });
  });

  test("refuses claim when no broadcastRampConfig row exists", async () => {
    const t = convexTest(schema, modules);
    const result = await t.mutation(
      internal.broadcast.waveRuns._claimWaveRunLease,
      { waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 100, batchSize: 50 },
    );
    expect(result).toMatchObject({ ok: false, reason: "no-config" });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// _persistPickedBatch + _markPickComplete + _markPickFailed
// ───────────────────────────────────────────────────────────────────────────

describe("pick-phase mutations", () => {
  test("_persistPickedBatch inserts contacts as pending + bumps updatedAt", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 3, batchSize: 50,
    });
    const r = await t.mutation(
      internal.broadcast.waveRuns._persistPickedBatch,
      { runId: "run-1", contacts: ["a@test", "b@test", "c@test"] },
    );
    expect(r.inserted).toBe(3);
    const contacts = await readContacts(t, "run-1");
    expect(contacts).toHaveLength(3);
    expect(contacts.every((c) => c.status === "pending")).toBe(true);
  });

  test("_markPickComplete transitions picking → segment-created with totalCount/underfilled", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 100, batchSize: 50,
    });
    await t.mutation(internal.broadcast.waveRuns._markPickComplete, {
      runId: "run-1", segmentId: "seg_abc", totalCount: 80, underfilled: true,
    });
    const run = await readWaveRun(t, "run-1");
    expect(run!.status).toBe("segment-created");
    expect(run!.segmentId).toBe("seg_abc");
    expect(run!.totalCount).toBe(80);
    expect(run!.underfilled).toBe(true);
  });

  test("_markPickFailed empty-pool clears the lease (terminal no-op)", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 100, batchSize: 50,
    });
    await t.mutation(internal.broadcast.waveRuns._markPickFailed, {
      runId: "run-1", substatus: "empty-pool", error: "no unstamped registrations",
    });
    const run = await readWaveRun(t, "run-1");
    expect(run!.status).toBe("failed");
    expect(run!.failureSubstatus).toBe("empty-pool");
    const config = await readConfig(t);
    expect(config!.pendingRunId).toBeUndefined();
    // PR2 review-fix 3: empty-pool now also DEACTIVATES the ramp (not just
    // clears the lease) and uses a `ramp-complete-*` status to signal
    // terminal completion to the operator.
    expect(config!.active).toBe(false);
    expect(config!.lastRunStatus).toBe("ramp-complete-empty-pool");
  });

  test("_markPickFailed segment-create-failed KEEPS the lease (operator must discard)", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 100, batchSize: 50,
    });
    await t.mutation(internal.broadcast.waveRuns._markPickFailed, {
      runId: "run-1", substatus: "segment-create-failed", error: "Resend 500",
    });
    const config = await readConfig(t);
    expect(config!.pendingRunId).toBe("run-1");
    const run = await readWaveRun(t, "run-1");
    expect(run!.status).toBe("failed");
    expect(run!.failureSubstatus).toBe("segment-create-failed");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// _markContactPushed / _markContactFailed (CAS guards)
// ───────────────────────────────────────────────────────────────────────────

describe("push-phase CAS mutations", () => {
  async function setupPushing(t: ReturnType<typeof convexTest>, totalCount = 4) {
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: totalCount, batchSize: 50,
    });
    const emails = Array.from({ length: totalCount }, (_, i) => `c${i}@test`);
    await seedRegistrations(t, emails);
    await t.mutation(internal.broadcast.waveRuns._persistPickedBatch, {
      runId: "run-1", contacts: emails,
    });
    await t.mutation(internal.broadcast.waveRuns._markPickComplete, {
      runId: "run-1", segmentId: "seg_abc", totalCount, underfilled: false,
    });
    await t.mutation(internal.broadcast.waveRuns._markPushingStarted, { runId: "run-1" });
    return emails;
  }

  test("_markContactPushed: pushed=true + pushedCount++ + registration stamped", async () => {
    const t = convexTest(schema, modules);
    const [first] = await setupPushing(t);
    const r = await t.mutation(internal.broadcast.waveRuns._markContactPushed, {
      contactId: await findContactId(t, "run-1", first!),
      runId: "run-1", normalizedEmail: first!, waveLabel: "pro-launch-wave-4",
    });
    expect(r).toMatchObject({ ok: true, stampResult: "stamped" });
    const run = await readWaveRun(t, "run-1");
    expect(run!.pushedCount).toBe(1);
    const contacts = await readContacts(t, "run-1");
    expect(contacts.find((c) => c.normalizedEmail === first)?.status).toBe("pushed");
  });

  test("_markContactPushed CAS: second call returns not-pending; pushedCount stays 1", async () => {
    const t = convexTest(schema, modules);
    const [first] = await setupPushing(t);
    const contactId = await findContactId(t, "run-1", first!);
    await t.mutation(internal.broadcast.waveRuns._markContactPushed, {
      contactId,
      runId: "run-1", normalizedEmail: first!, waveLabel: "pro-launch-wave-4",
    });
    const second = await t.mutation(internal.broadcast.waveRuns._markContactPushed, {
      contactId,
      runId: "run-1", normalizedEmail: first!, waveLabel: "pro-launch-wave-4",
    });
    expect(second).toMatchObject({ ok: false, reason: "not-pending" });
    const run = await readWaveRun(t, "run-1");
    expect(run!.pushedCount).toBe(1);
  });

  test("_markContactFailed: contact failed + failedCount++ (under threshold)", async () => {
    // 100 contacts: 1 failure = 1%, under the 5% threshold → run does NOT flip.
    const t = convexTest(schema, modules);
    const emails = await setupPushing(t, 100);
    const first = emails[0]!;
    const r = await t.mutation(internal.broadcast.waveRuns._markContactFailed, {
      contactId: await findContactId(t, "run-1", first),
      runId: "run-1", normalizedEmail: first, failedReason: "Resend 422",
    });
    expect(r).toMatchObject({ ok: true, runFailed: false });
    const run = await readWaveRun(t, "run-1");
    expect(run!.failedCount).toBe(1);
    expect(run!.status).toBe("pushing"); // still pushing — under threshold
    const contacts = await readContacts(t, "run-1");
    const failed = contacts.find((c) => c.normalizedEmail === first);
    expect(failed?.status).toBe("failed");
    expect(failed?.failedReason).toBe("Resend 422");
  });

  test("_markContactFailed flips whole run when failure rate exceeds 5%", async () => {
    // 4 contacts; 1 fail = 25% which is >5% → should flip.
    const t = convexTest(schema, modules);
    const [first] = await setupPushing(t, 4);
    const r = await t.mutation(internal.broadcast.waveRuns._markContactFailed, {
      contactId: await findContactId(t, "run-1", first!),
      runId: "run-1", normalizedEmail: first!, failedReason: "Resend 500",
    });
    expect(r).toMatchObject({ ok: true, runFailed: true });
    const run = await readWaveRun(t, "run-1");
    expect(run!.status).toBe("failed");
    expect(run!.failureSubstatus).toBe("batch-failure-rate-exceeded");
  });

  test("_markContactFailed CAS: second call on already-failed contact is no-op", async () => {
    const t = convexTest(schema, modules);
    // Use 100 contacts so a single failure is 1% — under threshold (won't flip the run)
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 100, batchSize: 50,
    });
    const emails = Array.from({ length: 100 }, (_, i) => `c${i}@test`);
    await seedRegistrations(t, emails);
    await t.mutation(internal.broadcast.waveRuns._persistPickedBatch, {
      runId: "run-1", contacts: emails,
    });
    await t.mutation(internal.broadcast.waveRuns._markPickComplete, {
      runId: "run-1", segmentId: "seg_abc", totalCount: 100, underfilled: false,
    });
    await t.mutation(internal.broadcast.waveRuns._markPushingStarted, { runId: "run-1" });

    const c0Id = await findContactId(t, "run-1", emails[0]!);
    await t.mutation(internal.broadcast.waveRuns._markContactFailed, {
      contactId: c0Id,
      runId: "run-1", normalizedEmail: emails[0]!, failedReason: "Resend 500",
    });
    const second = await t.mutation(internal.broadcast.waveRuns._markContactFailed, {
      contactId: c0Id,
      runId: "run-1", normalizedEmail: emails[0]!, failedReason: "Resend 500 again",
    });
    expect(second).toMatchObject({ ok: false, reason: "not-pending" });
    const run = await readWaveRun(t, "run-1");
    expect(run!.failedCount).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// _finalizeWaveRun + _markBroadcastCreated
// ───────────────────────────────────────────────────────────────────────────

describe("finalize-phase mutations", () => {
  async function setupBroadcastCreated(t: ReturnType<typeof convexTest>) {
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 1, batchSize: 50,
    });
    await t.mutation(internal.broadcast.waveRuns._markPickComplete, {
      runId: "run-1", segmentId: "seg_abc", totalCount: 1, underfilled: false,
    });
    await t.mutation(internal.broadcast.waveRuns._markPushingStarted, { runId: "run-1" });
    await t.mutation(internal.broadcast.waveRuns._markBroadcastCreated, {
      runId: "run-1", broadcastId: "bro_xyz",
    });
  }

  test("_markBroadcastCreated transitions pushing → broadcast-created with broadcastId", async () => {
    const t = convexTest(schema, modules);
    await setupBroadcastCreated(t);
    const run = await readWaveRun(t, "run-1");
    expect(run!.status).toBe("broadcast-created");
    expect(run!.broadcastId).toBe("bro_xyz");
  });

  test("_finalizeWaveRun atomically advances tier, sets lastWave*, clears lease, marks sent", async () => {
    const t = convexTest(schema, modules);
    await setupBroadcastCreated(t);
    const sentAt = Date.now();
    const r = await t.mutation(internal.broadcast.waveRuns._finalizeWaveRun, {
      runId: "run-1", sentAt,
    });
    expect(r).toMatchObject({ ok: true, advancedToTier: 1 });
    const config = await readConfig(t);
    expect(config!.currentTier).toBe(1);
    expect(config!.lastWaveLabel).toBe("pro-launch-wave-4");
    expect(config!.lastWaveBroadcastId).toBe("bro_xyz");
    expect(config!.lastWaveSegmentId).toBe("seg_abc");
    expect(config!.lastWaveSentAt).toBe(sentAt);
    expect(config!.lastRunStatus).toBe("succeeded");
    expect(config!.pendingRunId).toBeUndefined();
    const run = await readWaveRun(t, "run-1");
    expect(run!.status).toBe("sent");
  });

  test("_markFinalizeFailed create-broadcast-failed flips status='failed' (no broadcast yet)", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 1, batchSize: 50,
    });
    await t.mutation(internal.broadcast.waveRuns._markPickComplete, {
      runId: "run-1", segmentId: "seg_abc", totalCount: 1, underfilled: false,
    });
    await t.mutation(internal.broadcast.waveRuns._markPushingStarted, { runId: "run-1" });
    await t.mutation(internal.broadcast.waveRuns._markFinalizeFailed, {
      runId: "run-1", substatus: "create-broadcast-failed", error: "Resend 500",
    });
    const run = await readWaveRun(t, "run-1");
    expect(run!.status).toBe("failed");
    expect(run!.failureSubstatus).toBe("create-broadcast-failed");
  });

  test("_markFinalizeFailed send-broadcast-failed KEEPS status='broadcast-created' (broadcast exists)", async () => {
    const t = convexTest(schema, modules);
    await setupBroadcastCreated(t);
    await t.mutation(internal.broadcast.waveRuns._markFinalizeFailed, {
      runId: "run-1", substatus: "send-broadcast-failed", error: "network timeout",
    });
    const run = await readWaveRun(t, "run-1");
    expect(run!.status).toBe("broadcast-created"); // unchanged
    expect(run!.failureSubstatus).toBe("send-broadcast-failed");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Operator recovery — refuse-vs-route guards
// ───────────────────────────────────────────────────────────────────────────

describe("operator recovery", () => {
  test("resumeStalledWaveRun refuses broadcast-created (routes to resumeFinalizeWaveRun)", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 1, batchSize: 50,
    });
    await t.mutation(internal.broadcast.waveRuns._markPickComplete, {
      runId: "run-1", segmentId: "seg_abc", totalCount: 1, underfilled: false,
    });
    await t.mutation(internal.broadcast.waveRuns._markPushingStarted, { runId: "run-1" });
    await t.mutation(internal.broadcast.waveRuns._markBroadcastCreated, {
      runId: "run-1", broadcastId: "bro_xyz",
    });
    await expect(
      t.mutation(internal.broadcast.waveRuns.resumeStalledWaveRun, { runId: "run-1" }),
    ).rejects.toThrow(/broadcast-created.*resumeFinalizeWaveRun/);
  });

  test("resumeFinalizeWaveRun refuses send-failure case without confirmedNotSent", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 1, batchSize: 50,
    });
    await t.mutation(internal.broadcast.waveRuns._markPickComplete, {
      runId: "run-1", segmentId: "seg_abc", totalCount: 1, underfilled: false,
    });
    await t.mutation(internal.broadcast.waveRuns._markPushingStarted, { runId: "run-1" });
    await t.mutation(internal.broadcast.waveRuns._markBroadcastCreated, {
      runId: "run-1", broadcastId: "bro_xyz",
    });
    await t.mutation(internal.broadcast.waveRuns._markFinalizeFailed, {
      runId: "run-1", substatus: "send-broadcast-failed", error: "network",
    });
    await expect(
      t.mutation(internal.broadcast.waveRuns.resumeFinalizeWaveRun, { runId: "run-1" }),
    ).rejects.toThrow(/verify in the Resend dashboard/);
  });

  test("resumeFinalizeWaveRun for create-broadcast-failed needs no confirmedNotSent (no broadcast exists)", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 1, batchSize: 50,
    });
    await t.mutation(internal.broadcast.waveRuns._markPickComplete, {
      runId: "run-1", segmentId: "seg_abc", totalCount: 1, underfilled: false,
    });
    await t.mutation(internal.broadcast.waveRuns._markPushingStarted, { runId: "run-1" });
    await t.mutation(internal.broadcast.waveRuns._markFinalizeFailed, {
      runId: "run-1", substatus: "create-broadcast-failed", error: "Resend 500",
    });
    const r = await t.mutation(
      internal.broadcast.waveRuns.resumeFinalizeWaveRun,
      { runId: "run-1" },
    );
    expect(r).toMatchObject({ ok: true, scheduled: "finalizeWaveAction-create-and-send" });
    const run = await readWaveRun(t, "run-1");
    // Patched back to pushing so finalize action re-enters via create path.
    expect(run!.status).toBe("pushing");
    expect(run!.failureSubstatus).toBeUndefined();
    // Drain the scheduled finalizeWaveAction so it doesn't escape into an
    // unhandled rejection (the action would try Resend HTTP which fails in
    // the test env, but the scheduler-fail itself is fine).
    await t.finishInProgressScheduledFunctions().catch(() => {});
  });

  test("discardWaveRun marks failed + bumps waveLabelOffset + clears lease", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 100, batchSize: 50,
    });
    const r = await t.mutation(internal.broadcast.waveRuns.discardWaveRun, {
      runId: "run-1", reason: "operator decision",
    });
    expect(r).toMatchObject({ ok: true, newWaveLabelOffset: 4 });
    const config = await readConfig(t);
    expect(config!.waveLabelOffset).toBe(4);
    expect(config!.pendingRunId).toBeUndefined();
    const run = await readWaveRun(t, "run-1");
    expect(run!.status).toBe("failed");
    expect(run!.failureSubstatus).toBe("discarded-by-operator");
  });

  test("markFinalizeRecovered finalizes the run when operator confirms send happened", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 1, batchSize: 50,
    });
    await t.mutation(internal.broadcast.waveRuns._markPickComplete, {
      runId: "run-1", segmentId: "seg_abc", totalCount: 1, underfilled: false,
    });
    await t.mutation(internal.broadcast.waveRuns._markPushingStarted, { runId: "run-1" });
    await t.mutation(internal.broadcast.waveRuns._markBroadcastCreated, {
      runId: "run-1", broadcastId: "bro_xyz",
    });
    await t.mutation(internal.broadcast.waveRuns._markFinalizeFailed, {
      runId: "run-1", substatus: "send-broadcast-failed", error: "timeout",
    });
    const sentAt = Date.now();
    const r = await t.mutation(internal.broadcast.waveRuns.markFinalizeRecovered, {
      runId: "run-1", sentAt, reason: "Resend dashboard confirmed sent at 10:19 UTC",
    });
    expect(r).toMatchObject({ ok: true, advancedToTier: 1 });
    const config = await readConfig(t);
    expect(config!.currentTier).toBe(1);
    expect(config!.lastWaveSentAt).toBe(sentAt);
    expect(config!.pendingRunId).toBeUndefined();
    const run = await readWaveRun(t, "run-1");
    expect(run!.status).toBe("sent");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// In-flight guard query + cleanup
// ───────────────────────────────────────────────────────────────────────────

describe("_listInFlightWaveRuns + cleanup", () => {
  test("_listInFlightWaveRuns returns active runs with lastActivityAt fallback", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 100, batchSize: 50,
    });
    const inFlight = await t.query(
      internal.broadcast.waveRuns._listInFlightWaveRuns,
      {},
    );
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0]).toMatchObject({ runId: "run-1", status: "picking" });
    expect(inFlight[0]!.lastActivityAt).toBeGreaterThan(0);
  });

  test("_listInFlightWaveRuns excludes terminal-state runs (sent, failed)", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 100, batchSize: 50,
    });
    await t.mutation(internal.broadcast.waveRuns._markPickFailed, {
      runId: "run-1", substatus: "empty-pool", error: "no contacts",
    });
    const inFlight = await t.query(
      internal.broadcast.waveRuns._listInFlightWaveRuns,
      {},
    );
    expect(inFlight).toHaveLength(0);
  });

  test("_cleanupDiscardedWavePickedContacts deletes a chunk + reports hasMore", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 3, batchSize: 50,
    });
    await t.mutation(internal.broadcast.waveRuns._persistPickedBatch, {
      runId: "run-1", contacts: ["a@t", "b@t", "c@t"],
    });
    const r = await t.mutation(
      internal.broadcast.waveRuns._cleanupDiscardedWavePickedContacts,
      { runId: "run-1" },
    );
    expect(r.deleted).toBe(3);
    expect(r.hasMore).toBe(false);
    const remaining = await readContacts(t, "run-1");
    expect(remaining).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// PR2 review-fix 1: _markBroadcastCreated + _finalizeWaveRun lease+status CAS
// ───────────────────────────────────────────────────────────────────────────

describe("review-fix 1: lease+status CAS", () => {
  async function setupPushing(t: ReturnType<typeof convexTest>) {
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 1, batchSize: 50,
    });
    await t.mutation(internal.broadcast.waveRuns._markPickComplete, {
      runId: "run-1", segmentId: "seg_abc", totalCount: 1, underfilled: false,
    });
    await t.mutation(internal.broadcast.waveRuns._markPushingStarted, { runId: "run-1" });
  }

  test("_markBroadcastCreated: idempotent on re-call with same broadcastId", async () => {
    const t = convexTest(schema, modules);
    await setupPushing(t);
    const r1 = await t.mutation(internal.broadcast.waveRuns._markBroadcastCreated, {
      runId: "run-1", broadcastId: "bro_xyz",
    });
    expect(r1).toMatchObject({ ok: true, alreadyMarked: false });
    const r2 = await t.mutation(internal.broadcast.waveRuns._markBroadcastCreated, {
      runId: "run-1", broadcastId: "bro_xyz",
    });
    expect(r2).toMatchObject({ ok: true, alreadyMarked: true });
  });

  test("_markBroadcastCreated: refuses different broadcastId on already-marked run (duplicate detection)", async () => {
    const t = convexTest(schema, modules);
    await setupPushing(t);
    await t.mutation(internal.broadcast.waveRuns._markBroadcastCreated, {
      runId: "run-1", broadcastId: "bro_xyz",
    });
    const r = await t.mutation(internal.broadcast.waveRuns._markBroadcastCreated, {
      runId: "run-1", broadcastId: "bro_OTHER",
    });
    expect(r).toMatchObject({
      ok: false,
      reason: "duplicate-broadcast-detected",
      existing: "bro_xyz",
    });
  });

  test("_markBroadcastCreated: refuses on lost lease", async () => {
    const t = convexTest(schema, modules);
    await setupPushing(t);
    // Force-clear the lease (simulates operator forceReleaseLease).
    await t.run(async (ctx) => {
      const config = await ctx.db
        .query("broadcastRampConfig")
        .withIndex("by_key", (q) => q.eq("key", "current"))
        .unique();
      await ctx.db.patch(config!._id, { pendingRunId: undefined });
    });
    const r = await t.mutation(internal.broadcast.waveRuns._markBroadcastCreated, {
      runId: "run-1", broadcastId: "bro_xyz",
    });
    expect(r).toMatchObject({ ok: false, reason: "lost-lease" });
  });

  test("_markBroadcastCreated: refuses on wrong status (e.g. picking)", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 1, batchSize: 50,
    });
    // Status is still 'picking' — not allowed.
    const r = await t.mutation(internal.broadcast.waveRuns._markBroadcastCreated, {
      runId: "run-1", broadcastId: "bro_xyz",
    });
    expect(r).toMatchObject({ ok: false, reason: "wrong-status-picking" });
  });

  test("_finalizeWaveRun: idempotent on already-sent run (no-op, no double-advance)", async () => {
    const t = convexTest(schema, modules);
    await setupPushing(t);
    await t.mutation(internal.broadcast.waveRuns._markBroadcastCreated, {
      runId: "run-1", broadcastId: "bro_xyz",
    });
    const sentAt = Date.now();
    const r1 = await t.mutation(internal.broadcast.waveRuns._finalizeWaveRun, {
      runId: "run-1", sentAt,
    });
    expect(r1).toMatchObject({ ok: true, advancedToTier: 1 });
    // Second call should NOT advance the tier again.
    const r2 = await t.mutation(internal.broadcast.waveRuns._finalizeWaveRun, {
      runId: "run-1", sentAt: sentAt + 1000,
    });
    expect(r2).toMatchObject({ ok: true, alreadySent: true });
    const config = await readConfig(t);
    expect(config!.currentTier).toBe(1); // NOT 2
  });

  test("_finalizeWaveRun: throws on lost lease (refuses to advance after operator force-release)", async () => {
    const t = convexTest(schema, modules);
    await setupPushing(t);
    await t.mutation(internal.broadcast.waveRuns._markBroadcastCreated, {
      runId: "run-1", broadcastId: "bro_xyz",
    });
    await t.run(async (ctx) => {
      const config = await ctx.db
        .query("broadcastRampConfig")
        .withIndex("by_key", (q) => q.eq("key", "current"))
        .unique();
      await ctx.db.patch(config!._id, { pendingRunId: undefined });
    });
    await expect(
      t.mutation(internal.broadcast.waveRuns._finalizeWaveRun, {
        runId: "run-1", sentAt: Date.now(),
      }),
    ).rejects.toThrow(/lost lease/);
  });

  test("_finalizeWaveRun: throws on wrong status (e.g. pushing instead of broadcast-created)", async () => {
    const t = convexTest(schema, modules);
    await setupPushing(t);
    // Skip _markBroadcastCreated — try to finalize from 'pushing' directly.
    await expect(
      t.mutation(internal.broadcast.waveRuns._finalizeWaveRun, {
        runId: "run-1", sentAt: Date.now(),
      }),
    ).rejects.toThrow(/expected broadcast-created/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// PR2 review-fix 2: discardWaveRun unstamps registrations
// ───────────────────────────────────────────────────────────────────────────

describe("review-fix 2: unstamp on discard", () => {
  test("_cleanupDiscardedWavePickedContacts unstamps registrations matching the run's waveLabel", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 3, batchSize: 50,
    });
    const emails = ["a@t", "b@t", "c@t"];
    await seedRegistrations(t, emails);
    await t.mutation(internal.broadcast.waveRuns._persistPickedBatch, {
      runId: "run-1", contacts: emails,
    });
    await t.mutation(internal.broadcast.waveRuns._markPickComplete, {
      runId: "run-1", segmentId: "seg_abc", totalCount: 3, underfilled: false,
    });
    await t.mutation(internal.broadcast.waveRuns._markPushingStarted, { runId: "run-1" });
    // Push two of three (third stays pending). All three were seeded with
    // matching registrations by seedRegistrations.
    await t.mutation(internal.broadcast.waveRuns._markContactPushed, {
      contactId: await findContactId(t, "run-1", "a@t"),
      runId: "run-1", normalizedEmail: "a@t", waveLabel: "pro-launch-wave-4",
    });
    await t.mutation(internal.broadcast.waveRuns._markContactPushed, {
      contactId: await findContactId(t, "run-1", "b@t"),
      runId: "run-1", normalizedEmail: "b@t", waveLabel: "pro-launch-wave-4",
    });
    // Verify a + b are stamped before cleanup.
    const stampedBefore = await t.run(async (ctx) =>
      ctx.db.query("registrations").collect(),
    );
    expect(stampedBefore.filter((r) => r.proLaunchWave === "pro-launch-wave-4")).toHaveLength(2);

    // Cleanup should unstamp the 2 pushed contacts and delete all 3 wavePickedContacts rows.
    const r = await t.mutation(
      internal.broadcast.waveRuns._cleanupDiscardedWavePickedContacts,
      { runId: "run-1" },
    );
    expect(r).toMatchObject({ deleted: 3, unstamped: 2, hasMore: false });

    const stampedAfter = await t.run(async (ctx) =>
      ctx.db.query("registrations").collect(),
    );
    expect(stampedAfter.filter((r) => r.proLaunchWave === "pro-launch-wave-4")).toHaveLength(0);
    const remainingContacts = await readContacts(t, "run-1");
    expect(remainingContacts).toHaveLength(0);
  });

  test("_cleanupDiscardedWavePickedContacts does NOT unstamp a contact re-picked into a later wave", async () => {
    // Defensive: if the operator discards run-1, then a later run-2 picks
    // and stamps the same email with a different waveLabel, the cleanup of
    // run-1 must NOT clear run-2's stamp.
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 1, batchSize: 50,
    });
    await seedRegistrations(t, ["a@t"]);
    await t.mutation(internal.broadcast.waveRuns._persistPickedBatch, {
      runId: "run-1", contacts: ["a@t"],
    });
    await t.mutation(internal.broadcast.waveRuns._markPickComplete, {
      runId: "run-1", segmentId: "seg_abc", totalCount: 1, underfilled: false,
    });
    await t.mutation(internal.broadcast.waveRuns._markPushingStarted, { runId: "run-1" });
    await t.mutation(internal.broadcast.waveRuns._markContactPushed, {
      contactId: await findContactId(t, "run-1", "a@t"),
      runId: "run-1", normalizedEmail: "a@t", waveLabel: "pro-launch-wave-4",
    });
    // Manually re-stamp the registration as if it were re-picked into wave-5.
    await t.run(async (ctx) => {
      const reg = await ctx.db
        .query("registrations")
        .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", "a@t"))
        .first();
      await ctx.db.patch(reg!._id, { proLaunchWave: "pro-launch-wave-5" });
    });
    // Cleanup run-1 — must leave the wave-5 stamp alone.
    const r = await t.mutation(
      internal.broadcast.waveRuns._cleanupDiscardedWavePickedContacts,
      { runId: "run-1" },
    );
    expect(r.unstamped).toBe(0);
    const reg = await t.run(async (ctx) =>
      ctx.db
        .query("registrations")
        .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", "a@t"))
        .first(),
    );
    expect(reg!.proLaunchWave).toBe("pro-launch-wave-5");
  });

  test("discardWaveRun + cleanup unstamps the registration (action runs after discard)", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 1, batchSize: 50,
    });
    await seedRegistrations(t, ["a@t"]);
    await t.mutation(internal.broadcast.waveRuns._persistPickedBatch, {
      runId: "run-1", contacts: ["a@t"],
    });
    await t.mutation(internal.broadcast.waveRuns._markPickComplete, {
      runId: "run-1", segmentId: "seg_abc", totalCount: 1, underfilled: false,
    });
    await t.mutation(internal.broadcast.waveRuns._markPushingStarted, { runId: "run-1" });
    await t.mutation(internal.broadcast.waveRuns._markContactPushed, {
      contactId: await findContactId(t, "run-1", "a@t"),
      runId: "run-1", normalizedEmail: "a@t", waveLabel: "pro-launch-wave-4",
    });
    // Operator discard — flips the run to failed/discarded-by-operator and
    // schedules cleanup (we exercise the cleanup mutation directly here
    // since convex-test's action-dispatch path emits a benign "Write outside
    // of transaction" rejection on schedule.runAfter; the BEHAVIOR we want
    // to verify is that cleanup unstamps).
    await t.mutation(internal.broadcast.waveRuns.discardWaveRun, {
      runId: "run-1", reason: "operator decision",
    });
    // Run the cleanup mutation directly (same one the eager scheduler call
    // would invoke). Verifies the unstamp behavior on a discarded run.
    const r = await t.mutation(
      internal.broadcast.waveRuns._cleanupDiscardedWavePickedContacts,
      { runId: "run-1" },
    );
    expect(r.unstamped).toBe(1);
    const reg = await t.run(async (ctx) =>
      ctx.db
        .query("registrations")
        .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", "a@t"))
        .first(),
    );
    expect(reg!.proLaunchWave).toBeUndefined();
    // Drain the action that discardWaveRun also scheduled (it's a no-op
    // by this point since cleanup is already done; just suppress the
    // convex-test scheduler artifact).
    await t.finishInProgressScheduledFunctions().catch(() => {});
  });
});

// ───────────────────────────────────────────────────────────────────────────
// PR2 review-fix 3: pool-too-small terminates ramp
// ───────────────────────────────────────────────────────────────────────────

describe("review-fix 3: pool-too-small terminates ramp", () => {
  test("_markPickFailed pool-too-small clears lease + DEACTIVATES the ramp", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 1500, batchSize: 50,
    });
    await t.mutation(internal.broadcast.waveRuns._markPickFailed, {
      runId: "run-1",
      substatus: "pool-too-small",
      error: "picked 50 contacts < threshold",
    });
    const config = await readConfig(t);
    expect(config!.active).toBe(false);
    expect(config!.pendingRunId).toBeUndefined();
    expect(config!.lastRunStatus).toBe("ramp-complete-pool-too-small");
    const run = await readWaveRun(t, "run-1");
    expect(run!.status).toBe("failed");
    expect(run!.failureSubstatus).toBe("pool-too-small");
  });

  test("_markPickFailed empty-pool also DEACTIVATES the ramp (terminal completion)", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 1500, batchSize: 50,
    });
    await t.mutation(internal.broadcast.waveRuns._markPickFailed, {
      runId: "run-1", substatus: "empty-pool", error: "no contacts",
    });
    const config = await readConfig(t);
    expect(config!.active).toBe(false);
    expect(config!.lastRunStatus).toBe("ramp-complete-empty-pool");
  });

  test("_markPickFailed segment-create-failed does NOT deactivate (operator must triage)", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 1500, batchSize: 50,
    });
    await t.mutation(internal.broadcast.waveRuns._markPickFailed, {
      runId: "run-1", substatus: "segment-create-failed", error: "Resend 500",
    });
    const config = await readConfig(t);
    // Ramp stays active — operator inspects + discards. Lease stays held.
    expect(config!.active).toBe(true);
    expect(config!.pendingRunId).toBe("run-1");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// PR2 review-fix 5: cleanup excludes recoverable finalize failures
// ───────────────────────────────────────────────────────────────────────────

describe("review-fix 5: cleanup excludes recoverable failures", () => {
  async function setupOldFailedRun(
    t: ReturnType<typeof convexTest>,
    substatus: string,
  ) {
    // Seed a failed run with updatedAt 25h ago so it passes the age cutoff.
    const oldTime = Date.now() - 25 * 60 * 60 * 1000;
    await seedRampConfig(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("waveRuns", {
        runId: `run-${substatus}`,
        waveLabel: `pro-launch-wave-${substatus}`,
        status: "failed",
        failureSubstatus: substatus,
        requestedCount: 100,
        totalCount: 100,
        underfilled: false,
        pushedCount: 50,
        failedCount: 0,
        batchSize: 50,
        createdAt: oldTime,
        updatedAt: oldTime,
      });
    });
  }

  test("auto-cleanup INCLUDES discarded-by-operator runs", async () => {
    const t = convexTest(schema, modules);
    await setupOldFailedRun(t, "discarded-by-operator");
    const candidates = await t.query(
      internal.broadcast.waveRuns._listFailedWaveRunsForCleanup,
      {},
    );
    expect(candidates).toContain("run-discarded-by-operator");
  });

  test("auto-cleanup INCLUDES batch-failure-rate-exceeded (24h safety net)", async () => {
    const t = convexTest(schema, modules);
    await setupOldFailedRun(t, "batch-failure-rate-exceeded");
    const candidates = await t.query(
      internal.broadcast.waveRuns._listFailedWaveRunsForCleanup,
      {},
    );
    expect(candidates).toContain("run-batch-failure-rate-exceeded");
  });

  test("auto-cleanup EXCLUDES recoverable create-broadcast-failed", async () => {
    const t = convexTest(schema, modules);
    await setupOldFailedRun(t, "create-broadcast-failed");
    const candidates = await t.query(
      internal.broadcast.waveRuns._listFailedWaveRunsForCleanup,
      {},
    );
    // Operator may yet run resumeFinalizeWaveRun; cleanup would unstamp
    // pushed contacts and a subsequent successful send would re-stamp them
    // — risking duplicate outreach. Skip these in auto-cleanup.
    expect(candidates).not.toContain("run-create-broadcast-failed");
  });

  test("auto-cleanup EXCLUDES recoverable send-broadcast-failed", async () => {
    const t = convexTest(schema, modules);
    await setupOldFailedRun(t, "send-broadcast-failed");
    const candidates = await t.query(
      internal.broadcast.waveRuns._listFailedWaveRunsForCleanup,
      {},
    );
    expect(candidates).not.toContain("run-send-broadcast-failed");
  });

  test("auto-cleanup EXCLUDES failed runs with no substatus (defensive)", async () => {
    const t = convexTest(schema, modules);
    const oldTime = Date.now() - 25 * 60 * 60 * 1000;
    await seedRampConfig(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("waveRuns", {
        runId: "run-no-substatus",
        waveLabel: "pro-launch-wave-x",
        status: "failed", // status='failed' but no failureSubstatus set
        requestedCount: 100, totalCount: 100, underfilled: false,
        pushedCount: 0, failedCount: 0, batchSize: 50,
        createdAt: oldTime, updatedAt: oldTime,
      });
    });
    const candidates = await t.query(
      internal.broadcast.waveRuns._listFailedWaveRunsForCleanup,
      {},
    );
    expect(candidates).not.toContain("run-no-substatus");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// PR2 review-fix 6: _markFinalizeFailed terminal CAS + markFinalizeRecovered strict
// ───────────────────────────────────────────────────────────────────────────

describe("review-fix 6: terminal-CAS on finalize failure / recovery", () => {
  async function setupSent(t: ReturnType<typeof convexTest>) {
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 1, batchSize: 50,
    });
    await t.mutation(internal.broadcast.waveRuns._markPickComplete, {
      runId: "run-1", segmentId: "seg_abc", totalCount: 1, underfilled: false,
    });
    await t.mutation(internal.broadcast.waveRuns._markPushingStarted, { runId: "run-1" });
    await t.mutation(internal.broadcast.waveRuns._markBroadcastCreated, {
      runId: "run-1", broadcastId: "bro_xyz",
    });
    await t.mutation(internal.broadcast.waveRuns._finalizeWaveRun, {
      runId: "run-1", sentAt: Date.now(),
    });
  }

  test("_markFinalizeFailed: refuses to overwrite status='sent' (duplicate-finalize loser)", async () => {
    const t = convexTest(schema, modules);
    await setupSent(t);
    // Loser of a finalize race calls _markFinalizeFailed after Resend
    // returns 422 already-sent.
    const r = await t.mutation(internal.broadcast.waveRuns._markFinalizeFailed, {
      runId: "run-1",
      substatus: "send-broadcast-failed",
      error: "Resend 422 already sent",
    });
    expect(r).toMatchObject({ ok: false, reason: "already-sent" });
    // Run state unchanged — sent stays sent.
    const run = await readWaveRun(t, "run-1");
    expect(run!.status).toBe("sent");
    expect(run!.failureSubstatus).toBeUndefined();
  });

  test("_markFinalizeFailed: refuses to overwrite a different existing substatus", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 1, batchSize: 50,
    });
    await t.mutation(internal.broadcast.waveRuns._markPickComplete, {
      runId: "run-1", segmentId: "seg_abc", totalCount: 1, underfilled: false,
    });
    await t.mutation(internal.broadcast.waveRuns._markPushingStarted, { runId: "run-1" });
    // First failure — create-broadcast-failed.
    await t.mutation(internal.broadcast.waveRuns._markFinalizeFailed, {
      runId: "run-1", substatus: "create-broadcast-failed", error: "Resend 500",
    });
    // Second mutation tries to relabel — refuses.
    const r = await t.mutation(internal.broadcast.waveRuns._markFinalizeFailed, {
      runId: "run-1", substatus: "send-broadcast-failed", error: "different reason",
    });
    expect(r).toMatchObject({
      ok: false,
      reason: "already-failed-different-substatus",
      existing: "create-broadcast-failed",
    });
  });

  test("markFinalizeRecovered: throws on status='sent' (no double-advance)", async () => {
    const t = convexTest(schema, modules);
    await setupSent(t);
    // Even if a stale failureSubstatus was somehow set, status='sent' must block recovery.
    await t.run(async (ctx) => {
      const run = await ctx.db
        .query("waveRuns")
        .withIndex("by_runId", (q) => q.eq("runId", "run-1"))
        .unique();
      // Force a malformed state (won't happen in practice now that
      // _markFinalizeFailed CAS-rejects, but tests defense in depth).
      await ctx.db.patch(run!._id, { failureSubstatus: "send-broadcast-failed" });
    });
    await expect(
      t.mutation(internal.broadcast.waveRuns.markFinalizeRecovered, {
        runId: "run-1", sentAt: Date.now(), reason: "stale state recovery",
      }),
    ).rejects.toThrow(/already finalized|requires status/);
    const config = await readConfig(t);
    expect(config!.currentTier).toBe(1); // NOT advanced again
  });

  test("markFinalizeRecovered: throws on lost lease (refuses to advance from stale runId)", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 1, batchSize: 50,
    });
    await t.mutation(internal.broadcast.waveRuns._markPickComplete, {
      runId: "run-1", segmentId: "seg_abc", totalCount: 1, underfilled: false,
    });
    await t.mutation(internal.broadcast.waveRuns._markPushingStarted, { runId: "run-1" });
    await t.mutation(internal.broadcast.waveRuns._markBroadcastCreated, {
      runId: "run-1", broadcastId: "bro_xyz",
    });
    // PR2 review-fix 10: substatus required for the recovery to be reachable.
    await t.mutation(internal.broadcast.waveRuns._markFinalizeFailed, {
      runId: "run-1", substatus: "send-broadcast-failed", error: "timeout",
    });
    // Force-clear the lease (operator did forceReleaseLease).
    await t.run(async (ctx) => {
      const config = await ctx.db
        .query("broadcastRampConfig")
        .withIndex("by_key", (q) => q.eq("key", "current"))
        .unique();
      await ctx.db.patch(config!._id, { pendingRunId: undefined });
    });
    await expect(
      t.mutation(internal.broadcast.waveRuns.markFinalizeRecovered, {
        runId: "run-1", sentAt: Date.now(), reason: "operator verified",
      }),
    ).rejects.toThrow(/lost lease/);
  });

  test("markFinalizeRecovered: succeeds on broadcast-created + send-broadcast-failed substatus + held lease", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 1, batchSize: 50,
    });
    await t.mutation(internal.broadcast.waveRuns._markPickComplete, {
      runId: "run-1", segmentId: "seg_abc", totalCount: 1, underfilled: false,
    });
    await t.mutation(internal.broadcast.waveRuns._markPushingStarted, { runId: "run-1" });
    await t.mutation(internal.broadcast.waveRuns._markBroadcastCreated, {
      runId: "run-1", broadcastId: "bro_xyz",
    });
    // PR2 review-fix 10: markFinalizeRecovered now requires the substatus
    // signal. Without it, status='broadcast-created' alone is also the
    // mid-flight pre-send state and would race-advance the tier.
    await t.mutation(internal.broadcast.waveRuns._markFinalizeFailed, {
      runId: "run-1", substatus: "send-broadcast-failed", error: "network timeout",
    });
    const sentAt = Date.now();
    const r = await t.mutation(internal.broadcast.waveRuns.markFinalizeRecovered, {
      runId: "run-1", sentAt, reason: "Resend dashboard confirmed sent",
    });
    expect(r).toMatchObject({ ok: true, advancedToTier: 1 });
    const config = await readConfig(t);
    expect(config!.currentTier).toBe(1);
    expect(config!.lastWaveSentAt).toBe(sentAt);
  });

  test("markFinalizeRecovered: REFUSES on broadcast-created without send-broadcast-failed substatus (mid-flight protection)", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      waveLabel: "pro-launch-wave-4", runId: "run-1", requestedCount: 1, batchSize: 50,
    });
    await t.mutation(internal.broadcast.waveRuns._markPickComplete, {
      runId: "run-1", segmentId: "seg_abc", totalCount: 1, underfilled: false,
    });
    await t.mutation(internal.broadcast.waveRuns._markPushingStarted, { runId: "run-1" });
    await t.mutation(internal.broadcast.waveRuns._markBroadcastCreated, {
      runId: "run-1", broadcastId: "bro_xyz",
    });
    // status='broadcast-created' but no failureSubstatus — this is the
    // active mid-flight state between create and send. Operator MUST
    // NOT be able to short-circuit here.
    await expect(
      t.mutation(internal.broadcast.waveRuns.markFinalizeRecovered, {
        runId: "run-1", sentAt: Date.now(), reason: "operator confused",
      }),
    ).rejects.toThrow(/failureSubstatus.*<none>|only applies to send-broadcast-failed/);
    const config = await readConfig(t);
    expect(config!.currentTier).toBe(0); // NOT advanced
  });
});
