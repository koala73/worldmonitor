/**
 * Tests for the broadcast ramp runner's lease-based concurrency guard +
 * structured recovery action.
 *
 * Two production-incident-prevention scenarios:
 *
 *   1. Race condition (P1, PR #3473 review): two overlapping cron runs (or
 *      cron + manual trigger, or Convex action retry) both proceed through
 *      assignAndExportWave + createProLaunchBroadcast + sendProLaunchBroadcast
 *      before colliding at _recordWaveSent. By then DUPLICATE EMAILS have
 *      already gone out. The lease (claimed BEFORE side effects) makes the
 *      loser exit cleanly.
 *
 *   2. Recovery after exported-but-not-sent (P1, PR #3473 review): a partial
 *      failure where assignAndExportWave succeeded (contacts stamped, segment
 *      created) but createProLaunchBroadcast / sendProLaunchBroadcast threw.
 *      Bare clearPartialFailure makes the next cron retry the same waveLabel,
 *      which fails because the contacts are already stamped. recoverFromPartialFailure
 *      provides explicit recovery modes: manual-finished (advance tier with
 *      manually-completed broadcastId) or discard-and-rotate (bump
 *      waveLabelOffset so next cron uses a fresh label).
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");

async function seedRampConfig(
  t: ReturnType<typeof convexTest>,
  overrides: Partial<{
    currentTier: number;
    rampCurve: number[];
    waveLabelPrefix: string;
    waveLabelOffset: number;
    lastRunStatus: string | undefined;
    lastWaveBroadcastId: string | undefined;
    lastWaveSentAt: number | undefined;
    pendingRunId: string | undefined;
    pendingRunStartedAt: number | undefined;
    active: boolean;
    killGateTripped: boolean;
  }> = {},
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("broadcastRampConfig", {
      key: "current",
      active: overrides.active ?? true,
      rampCurve: overrides.rampCurve ?? [500, 1500, 5000],
      currentTier: overrides.currentTier ?? 0,
      waveLabelPrefix: overrides.waveLabelPrefix ?? "wave",
      waveLabelOffset: overrides.waveLabelOffset ?? 3,
      bounceKillThreshold: 0.04,
      complaintKillThreshold: 0.0008,
      killGateTripped: overrides.killGateTripped ?? false,
      lastRunStatus: overrides.lastRunStatus,
      lastWaveBroadcastId: overrides.lastWaveBroadcastId,
      lastWaveSentAt: overrides.lastWaveSentAt,
      pendingRunId: overrides.pendingRunId,
      pendingRunStartedAt: overrides.pendingRunStartedAt,
    });
  });
}

async function loadRow(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("broadcastRampConfig")
      .withIndex("by_key", (q) => q.eq("key", "current"))
      .first(),
  );
}

// ----------------------------------------------------------------------------
// _claimTierForRun: the pre-side-effect lock
// ----------------------------------------------------------------------------

describe("_claimTierForRun — lease lifecycle", () => {
  test("claims successfully when no lease is held", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    const result = await t.mutation(internal.broadcast.rampRunner._claimTierForRun, {
      runId: "run-1",
      expectedCurrentTier: 0,
    });
    expect(result.ok).toBe(true);
    const row = await loadRow(t);
    expect(row?.pendingRunId).toBe("run-1");
    expect(row?.pendingRunStartedAt).toBeTypeOf("number");
  });

  test("rejects when another lease is held and fresh — RACE GUARD", async () => {
    // The whole point: two concurrent runs both pass kill-gate / tier-bounds
    // checks, both attempt to claim, only ONE wins. The loser exits without
    // running assignAndExportWave + createProLaunchBroadcast + sendProLaunchBroadcast.
    const t = convexTest(schema, modules);
    await seedRampConfig(t);

    const first = await t.mutation(internal.broadcast.rampRunner._claimTierForRun, {
      runId: "run-A",
      expectedCurrentTier: 0,
    });
    expect(first.ok).toBe(true);

    const second = await t.mutation(internal.broadcast.rampRunner._claimTierForRun, {
      runId: "run-B",
      expectedCurrentTier: 0,
    });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("lease-held");
    expect(second.heldBy).toBe("run-A");
  });

  test("rejects when expectedCurrentTier doesn't match — protects against tier-already-advanced", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t, { currentTier: 2 });
    const result = await t.mutation(internal.broadcast.rampRunner._claimTierForRun, {
      runId: "run-1",
      expectedCurrentTier: 1, // stale
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("tier-moved");
    expect(result.actualTier).toBe(2);
  });

  test("overrides a stale lease (older than STALE_LEASE_MS) — recovers from runner crash", async () => {
    // STALE_LEASE_MS is 30 minutes. Seed a lease 31 minutes old; new claim wins.
    const t = convexTest(schema, modules);
    await seedRampConfig(t, {
      pendingRunId: "run-crashed",
      pendingRunStartedAt: Date.now() - 31 * 60 * 1000,
    });
    const result = await t.mutation(internal.broadcast.rampRunner._claimTierForRun, {
      runId: "run-fresh",
      expectedCurrentTier: 0,
    });
    expect(result.ok).toBe(true);
    const row = await loadRow(t);
    expect(row?.pendingRunId).toBe("run-fresh");
  });
});

// ----------------------------------------------------------------------------
// _recordWaveSent: validates lease and clears it
// ----------------------------------------------------------------------------

describe("_recordWaveSent — lease validation on success", () => {
  test("clears the lease and advances tier when the lease is held by the same runId", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t, {
      currentTier: 1,
      pendingRunId: "run-X",
      pendingRunStartedAt: Date.now(),
    });
    const result = await t.mutation(internal.broadcast.rampRunner._recordWaveSent, {
      runId: "run-X",
      expectedCurrentTier: 1,
      newTier: 2,
      waveLabel: "wave-5",
      broadcastId: "bc-test-123",
      segmentId: "seg-test-456",
      assigned: 1500,
      sentAt: Date.now(),
    });
    expect(result.ok).toBe(true);
    const row = await loadRow(t);
    expect(row?.currentTier).toBe(2);
    expect(row?.lastWaveBroadcastId).toBe("bc-test-123");
    expect(row?.pendingRunId).toBeUndefined();
    expect(row?.pendingRunStartedAt).toBeUndefined();
  });

  test("throws when the lease has been overridden (lease-lost guard)", async () => {
    // Defends against the (rare) case where our lease was overridden as stale
    // by another run while we were in flight. We must NOT advance the tier —
    // the other run may also be in flight and would conflict.
    const t = convexTest(schema, modules);
    await seedRampConfig(t, {
      currentTier: 1,
      pendingRunId: "run-OTHER",
      pendingRunStartedAt: Date.now(),
    });
    await expect(
      t.mutation(internal.broadcast.rampRunner._recordWaveSent, {
        runId: "run-MINE",
        expectedCurrentTier: 1,
        newTier: 2,
        waveLabel: "wave-5",
        broadcastId: "bc-test",
        segmentId: "seg-test",
        assigned: 1500,
        sentAt: Date.now(),
      }),
    ).rejects.toThrow(/lease lost/i);
  });
});

// ----------------------------------------------------------------------------
// _recordRunOutcome: clears lease for the matching runId
// ----------------------------------------------------------------------------

describe("_recordRunOutcome — lease release on failure", () => {
  test("clears the lease when runId matches the held lease", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t, {
      pendingRunId: "run-Y",
      pendingRunStartedAt: Date.now(),
    });
    await t.mutation(internal.broadcast.rampRunner._recordRunOutcome, {
      runId: "run-Y",
      status: "partial-failure",
      error: "test failure",
    });
    const row = await loadRow(t);
    expect(row?.pendingRunId).toBeUndefined();
    expect(row?.pendingRunStartedAt).toBeUndefined();
    expect(row?.lastRunStatus).toBe("partial-failure");
  });

  test("does NOT clear the lease when runId differs (avoids stomping another run's lease)", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t, {
      pendingRunId: "run-OTHER",
      pendingRunStartedAt: Date.now(),
    });
    await t.mutation(internal.broadcast.rampRunner._recordRunOutcome, {
      runId: "run-MINE",
      status: "partial-failure",
    });
    const row = await loadRow(t);
    // Lease stays with run-OTHER, even though we recorded an outcome.
    expect(row?.pendingRunId).toBe("run-OTHER");
  });
});

// ----------------------------------------------------------------------------
// recoverFromPartialFailure — the structured recovery for P1 #2
// ----------------------------------------------------------------------------

describe("recoverFromPartialFailure — exported-but-not-sent recovery", () => {
  test("manual-finished: advances tier + records broadcastId from operator-completed wave", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t, {
      currentTier: 1,
      lastRunStatus: "partial-failure",
      pendingRunId: "run-stuck",
      pendingRunStartedAt: Date.now(),
    });
    const result = await t.mutation(
      internal.broadcast.rampRunner.recoverFromPartialFailure,
      {
        recovery: "manual-finished",
        reason: "Sent wave-5 manually via Resend dashboard after createProLaunchBroadcast threw",
        broadcastId: "bc-manual-789",
        segmentId: "seg-manual-456",
        sentAt: 1700000000000,
        assigned: 1500,
      },
    );
    expect(result.ok).toBe(true);
    expect(result.recovery).toBe("manual-finished");
    expect(result.advancedToTier).toBe(2);

    const row = await loadRow(t);
    expect(row?.currentTier).toBe(2);
    expect(row?.lastWaveBroadcastId).toBe("bc-manual-789");
    expect(row?.lastWaveSegmentId).toBe("seg-manual-456");
    expect(row?.lastWaveAssigned).toBe(1500);
    expect(row?.lastWaveSentAt).toBe(1700000000000);
    expect(row?.lastRunStatus).toMatch(/succeeded-via-manual-recovery/);
    expect(row?.pendingRunId).toBeUndefined();
  });

  test("manual-finished: rejects when required fields are missing", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t, { lastRunStatus: "partial-failure" });
    await expect(
      t.mutation(internal.broadcast.rampRunner.recoverFromPartialFailure, {
        recovery: "manual-finished",
        reason: "test",
        // missing broadcastId, segmentId, sentAt, assigned
      }),
    ).rejects.toThrow(/broadcastId, segmentId, sentAt, assigned are all required/i);
  });

  test("discard-and-rotate: bumps waveLabelOffset so next cron uses a FRESH label", async () => {
    // P1 #2 fix: without this, next cron retries the SAME waveLabel and
    // assignAndExportWave rejects because contacts are already stamped.
    const t = convexTest(schema, modules);
    await seedRampConfig(t, {
      currentTier: 1,
      waveLabelOffset: 3, // current next would be wave-(2+3)=wave-5
      lastRunStatus: "partial-failure",
      pendingRunId: "run-stuck",
      pendingRunStartedAt: Date.now(),
    });
    const result = await t.mutation(
      internal.broadcast.rampRunner.recoverFromPartialFailure,
      {
        recovery: "discard-and-rotate",
        reason: "wave-5 is unrecoverable; discarding the stamped batch",
      },
    );
    expect(result.ok).toBe(true);
    expect(result.recovery).toBe("discard-and-rotate");
    expect(result.newWaveLabelOffset).toBe(4);
    expect(result.nextWaveLabel).toBe("wave-6");

    const row = await loadRow(t);
    expect(row?.waveLabelOffset).toBe(4);
    // Tier NOT advanced — we never sent.
    expect(row?.currentTier).toBe(1);
    expect(row?.lastRunStatus).toMatch(/partial-failure-discarded-rotated/);
    expect(row?.pendingRunId).toBeUndefined();
  });

  test("noop when status is not partial-failure", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t, { lastRunStatus: "succeeded" });
    const result = await t.mutation(
      internal.broadcast.rampRunner.recoverFromPartialFailure,
      {
        recovery: "discard-and-rotate",
        reason: "operator confused, no actual partial-failure",
      },
    );
    expect(result.noop).toBe(true);
    expect(result.currentStatus).toBe("succeeded");
  });
});

// ----------------------------------------------------------------------------
// End-to-end: the race scenario the lease prevents
// ----------------------------------------------------------------------------

describe("end-to-end: lease prevents duplicate-send race", () => {
  test("first claim wins; second is rejected without ANY side effect path being taken", async () => {
    // This is the scenario reviewer flagged: two concurrent runs both pass the
    // kill-gate / tier-bounds checks above, both attempt to claim. With the
    // lease, only ONE wins. The other returns claim-rejected and the runner
    // exits before assignAndExportWave / createProLaunchBroadcast / sendProLaunchBroadcast
    // are ever called.
    const t = convexTest(schema, modules);
    await seedRampConfig(t);

    const claimA = await t.mutation(internal.broadcast.rampRunner._claimTierForRun, {
      runId: "run-A",
      expectedCurrentTier: 0,
    });
    const claimB = await t.mutation(internal.broadcast.rampRunner._claimTierForRun, {
      runId: "run-B",
      expectedCurrentTier: 0,
    });

    // Exactly one wins.
    expect([claimA.ok, claimB.ok].filter(Boolean).length).toBe(1);

    // The winner can record success and clear the lease.
    const winner = claimA.ok ? "run-A" : "run-B";
    await t.mutation(internal.broadcast.rampRunner._recordWaveSent, {
      runId: winner,
      expectedCurrentTier: 0,
      newTier: 1,
      waveLabel: "wave-3",
      broadcastId: "bc-1",
      segmentId: "seg-1",
      assigned: 500,
      sentAt: Date.now(),
    });

    // After success: lease cleared, tier advanced.
    const row = await loadRow(t);
    expect(row?.currentTier).toBe(1);
    expect(row?.pendingRunId).toBeUndefined();
  });
});
