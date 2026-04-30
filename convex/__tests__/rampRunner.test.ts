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
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");

const __dirname = dirname(fileURLToPath(import.meta.url));
const runnerSrc = readFileSync(
  resolve(__dirname, "..", "broadcast", "rampRunner.ts"),
  "utf-8",
);

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
    pendingWaveLabel: string | undefined;
    pendingSegmentId: string | undefined;
    pendingAssigned: number | undefined;
    pendingExportAt: number | undefined;
    pendingBroadcastId: string | undefined;
    pendingBroadcastAt: number | undefined;
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
      pendingWaveLabel: overrides.pendingWaveLabel,
      pendingSegmentId: overrides.pendingSegmentId,
      pendingAssigned: overrides.pendingAssigned,
      pendingExportAt: overrides.pendingExportAt,
      pendingBroadcastId: overrides.pendingBroadcastId,
      pendingBroadcastAt: overrides.pendingBroadcastAt,
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

  test("rejects EVEN A STALE lease — no automatic time-based override (P1#1)", async () => {
    // P1#1 fix: a wall-clock-based override has the same failure mode the
    // lease exists to prevent. assignAndExportWave can legitimately exceed
    // any cutoff for large rampCurve sizes / slow Resend, and overriding
    // mid-flight lets a second run race and duplicate-send. Recovery from
    // a genuinely-stuck lease is operator-only via forceReleaseLease.
    const t = convexTest(schema, modules);
    await seedRampConfig(t, {
      pendingRunId: "run-very-old",
      pendingRunStartedAt: Date.now() - 6 * 60 * 60 * 1000, // 6 hours ago
    });
    const result = await t.mutation(internal.broadcast.rampRunner._claimTierForRun, {
      runId: "run-fresh",
      expectedCurrentTier: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("lease-held");
    expect(result.heldBy).toBe("run-very-old");
    const row = await loadRow(t);
    // Lease is unchanged.
    expect(row?.pendingRunId).toBe("run-very-old");
  });
});

// ----------------------------------------------------------------------------
// forceReleaseLease — operator-only stale-lease recovery
// ----------------------------------------------------------------------------

describe("forceReleaseLease — operator-only stale-lease recovery (P1#1)", () => {
  test("clears the lease and sets lastRunStatus=partial-failure so recoverFromPartialFailure can pick up", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t, {
      pendingRunId: "run-wedged",
      pendingRunStartedAt: Date.now() - 6 * 60 * 60 * 1000,
      // Mid-flight progress preserved so the operator can decide between
      // manual-finished and discard-and-rotate from persisted state.
      pendingWaveLabel: "wave-7",
      pendingSegmentId: "seg-wedged",
      pendingAssigned: 5000,
      pendingBroadcastId: "bc-wedged",
    });
    const result = await t.mutation(
      internal.broadcast.rampRunner.forceReleaseLease,
      { reason: "cron action wedged 6h, no partial-failure recorded" },
    );
    expect(result.ok).toBe(true);
    expect(result.releasedRunId).toBe("run-wedged");

    const row = await loadRow(t);
    expect(row?.pendingRunId).toBeUndefined();
    expect(row?.pendingRunStartedAt).toBeUndefined();
    expect(row?.lastRunStatus).toBe("partial-failure");
    expect(row?.lastRunError).toMatch(/forced-release/i);
    // Pending progress markers preserved.
    expect(row?.pendingWaveLabel).toBe("wave-7");
    expect(row?.pendingSegmentId).toBe("seg-wedged");
    expect(row?.pendingBroadcastId).toBe("bc-wedged");
  });

  test("noop when no lease is held", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    const result = await t.mutation(
      internal.broadcast.rampRunner.forceReleaseLease,
      { reason: "no-op test" },
    );
    expect(result.ok).toBe(true);
    expect(result.noop).toBe(true);
  });

  test("after force-release, a fresh claim can succeed", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t, {
      pendingRunId: "run-stuck",
      pendingRunStartedAt: Date.now() - 60 * 60 * 1000,
    });
    await t.mutation(internal.broadcast.rampRunner.forceReleaseLease, {
      reason: "stuck",
    });
    const claim = await t.mutation(
      internal.broadcast.rampRunner._claimTierForRun,
      { runId: "run-recovered", expectedCurrentTier: 0 },
    );
    expect(claim.ok).toBe(true);
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

  test("HARD NO-OP when runId differs — does NOT write status/error/active either (P1#2)", async () => {
    // P1#2 fix: a lost-lease run must NOT overwrite the winner's authoritative
    // outcome state. Previously, lease-mismatch only suppressed the lease-clear
    // but still wrote lastRunStatus / lastRunError / killGateTripped / active —
    // which clobbered the operator's recovery decisions.
    const t = convexTest(schema, modules);
    await seedRampConfig(t, {
      pendingRunId: "run-OTHER",
      pendingRunStartedAt: Date.now(),
      lastRunStatus: "succeeded", // operator/winner-set
      killGateTripped: false,
      active: true,
    });
    const result = await t.mutation(
      internal.broadcast.rampRunner._recordRunOutcome,
      {
        runId: "run-MINE",
        status: "partial-failure",
        error: "should not land",
        killGate: true,
        killGateReason: "should not land",
        deactivate: true,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("lease-lost");

    const row = await loadRow(t);
    // Lease unchanged.
    expect(row?.pendingRunId).toBe("run-OTHER");
    // ALL outcome fields unchanged — no stomp.
    expect(row?.lastRunStatus).toBe("succeeded");
    expect(row?.lastRunError).toBeUndefined();
    expect(row?.killGateTripped).toBe(false);
    expect(row?.killGateReason).toBeUndefined();
    expect(row?.active).toBe(true);
  });

  test("HARD NO-OP when lease is cleared (operator already took control)", async () => {
    // The other lease-lost case: operator already called forceReleaseLease /
    // recoverFromPartialFailure, clearing pendingRunId. The displaced run's
    // catch block tries to write — must be no-op too.
    const t = convexTest(schema, modules);
    await seedRampConfig(t, {
      pendingRunId: undefined,
      lastRunStatus: "partial-failure", // operator-set
    });
    const result = await t.mutation(
      internal.broadcast.rampRunner._recordRunOutcome,
      {
        runId: "run-DISPLACED",
        status: "succeeded",
        error: "should not land",
      },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("lease-lost");
    const row = await loadRow(t);
    expect(row?.lastRunStatus).toBe("partial-failure"); // operator's status preserved
  });
});

// ----------------------------------------------------------------------------
// _recordPendingExport / _recordPendingBroadcast — per-step persistence (P1#4)
// ----------------------------------------------------------------------------

describe("_recordPendingExport — persists progress + lease-validates", () => {
  test("persists waveLabel/segmentId/assigned/exportAt when lease is owned", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t, {
      pendingRunId: "run-X",
      pendingRunStartedAt: Date.now(),
    });
    const result = await t.mutation(
      internal.broadcast.rampRunner._recordPendingExport,
      {
        runId: "run-X",
        waveLabel: "wave-5",
        segmentId: "seg-export",
        assigned: 1500,
      },
    );
    expect(result.ok).toBe(true);
    const row = await loadRow(t);
    expect(row?.pendingWaveLabel).toBe("wave-5");
    expect(row?.pendingSegmentId).toBe("seg-export");
    expect(row?.pendingAssigned).toBe(1500);
    expect(row?.pendingExportAt).toBeTypeOf("number");
  });

  test("throws when lease has been force-released (P1#1+P1#4 interaction)", async () => {
    // The runner's _recordPendingExport call protects against operator
    // force-releasing the lease while assignAndExportWave was running.
    const t = convexTest(schema, modules);
    await seedRampConfig(t, { pendingRunId: undefined }); // no lease
    await expect(
      t.mutation(internal.broadcast.rampRunner._recordPendingExport, {
        runId: "run-DISPLACED",
        waveLabel: "wave-5",
        segmentId: "seg-export",
        assigned: 1500,
      }),
    ).rejects.toThrow(/lease lost/i);
  });

  test("throws when lease is owned by a different run", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t, {
      pendingRunId: "run-OTHER",
      pendingRunStartedAt: Date.now(),
    });
    await expect(
      t.mutation(internal.broadcast.rampRunner._recordPendingExport, {
        runId: "run-MINE",
        waveLabel: "wave-5",
        segmentId: "seg-export",
        assigned: 1500,
      }),
    ).rejects.toThrow(/lease lost/i);
  });
});

describe("_recordPendingBroadcast — persists broadcastId + lease-validates", () => {
  test("persists broadcastId/broadcastAt when lease is owned", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t, {
      pendingRunId: "run-Y",
      pendingRunStartedAt: Date.now(),
      pendingWaveLabel: "wave-5",
      pendingSegmentId: "seg-export",
      pendingAssigned: 1500,
      pendingExportAt: Date.now() - 1000,
    });
    const result = await t.mutation(
      internal.broadcast.rampRunner._recordPendingBroadcast,
      { runId: "run-Y", broadcastId: "bc-created" },
    );
    expect(result.ok).toBe(true);
    const row = await loadRow(t);
    expect(row?.pendingBroadcastId).toBe("bc-created");
    expect(row?.pendingBroadcastAt).toBeTypeOf("number");
    // Earlier persisted state preserved.
    expect(row?.pendingWaveLabel).toBe("wave-5");
  });

  test("throws when lease has been force-released", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t, { pendingRunId: undefined });
    await expect(
      t.mutation(internal.broadcast.rampRunner._recordPendingBroadcast, {
        runId: "run-DISPLACED",
        broadcastId: "bc-created",
      }),
    ).rejects.toThrow(/lease lost/i);
  });
});

describe("_recordWaveSent — clears all pending* progress markers (P1#4)", () => {
  test("on success, every pending* field is cleared so the next run starts fresh", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t, {
      currentTier: 1,
      pendingRunId: "run-Z",
      pendingRunStartedAt: Date.now(),
      pendingWaveLabel: "wave-5",
      pendingSegmentId: "seg-test",
      pendingAssigned: 1500,
      pendingExportAt: Date.now() - 5000,
      pendingBroadcastId: "bc-test",
      pendingBroadcastAt: Date.now() - 1000,
    });
    await t.mutation(internal.broadcast.rampRunner._recordWaveSent, {
      runId: "run-Z",
      expectedCurrentTier: 1,
      newTier: 2,
      waveLabel: "wave-5",
      broadcastId: "bc-test",
      segmentId: "seg-test",
      assigned: 1500,
      sentAt: Date.now(),
    });
    const row = await loadRow(t);
    expect(row?.pendingWaveLabel).toBeUndefined();
    expect(row?.pendingSegmentId).toBeUndefined();
    expect(row?.pendingAssigned).toBeUndefined();
    expect(row?.pendingExportAt).toBeUndefined();
    expect(row?.pendingBroadcastId).toBeUndefined();
    expect(row?.pendingBroadcastAt).toBeUndefined();
    // And the lease is also cleared.
    expect(row?.pendingRunId).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// clearPartialFailure — fail-closed unless operator confirms no export (P1#3)
// ----------------------------------------------------------------------------

// PR 2 (post-launch-stabilization, 2026-04-30) replaced the monolithic
// `runDailyRamp` body with a state-machine-based scheduler call. The two
// source-grep tests that lived here previously (PR #3476 review rounds 3
// and 4) protected against regressions in the now-removed
// `_recordPendingExport` call ordering and `pool-drained vs partial-failure`
// routing. Both branches are gone — `pickWaveAction` (in waveRuns.ts) now
// owns underfill / persist-failure handling, and the legacy
// `_recordPendingExport` mutation remains in this module only for
// `recoverFromPartialFailure` to use against any legacy partial-failure
// rows. New behaviour is tested in `convex/__tests__/waveRuns.test.ts`.

describe("clearPartialFailure — confirmNoExport guard (P1#3)", () => {
  test("REFUSES when any pending* progress marker is set — even with confirmNoExport=true", async () => {
    // P1#3 fix: confirmNoExport is a literal-true gate, but the operator
    // could still get it wrong. The persisted pending* markers are the
    // authoritative signal that the export DID run. Refuse loudly.
    const t = convexTest(schema, modules);
    await seedRampConfig(t, {
      lastRunStatus: "partial-failure",
      pendingSegmentId: "seg-stamped", // export ran
    });
    await expect(
      t.mutation(internal.broadcast.rampRunner.clearPartialFailure, {
        reason: "operator thinks no export happened",
        confirmNoExport: true,
      }),
    ).rejects.toThrow(/refused: pending progress markers present/i);
  });

  test("clears when no pending* markers AND confirmNoExport=true (truly pre-export failure)", async () => {
    // Genuine case: assignAndExportWave threw before any contact stamping or
    // segment creation, so no pending* markers were persisted. Operator
    // confirms zero stamps in audience tables, calls clearPartialFailure.
    const t = convexTest(schema, modules);
    await seedRampConfig(t, {
      lastRunStatus: "partial-failure",
      pendingRunId: "run-Q",
      pendingRunStartedAt: Date.now(),
      // no pendingWaveLabel/SegmentId/BroadcastId
    });
    const result = await t.mutation(
      internal.broadcast.rampRunner.clearPartialFailure,
      {
        reason: "assignAndExportWave threw on Resend timeout before stamping",
        confirmNoExport: true,
      },
    );
    expect(result.ok).toBe(true);
    const row = await loadRow(t);
    expect(row?.lastRunStatus).toMatch(/partial-failure-cleared/);
    expect(row?.pendingRunId).toBeUndefined();
  });

  test("noop when status isn't partial-failure", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t, { lastRunStatus: "succeeded" });
    const result = await t.mutation(
      internal.broadcast.rampRunner.clearPartialFailure,
      { reason: "test", confirmNoExport: true },
    );
    expect(result.noop).toBe(true);
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

  test("manual-finished: rejects when required fields are missing AND no persisted fallback", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t, { lastRunStatus: "partial-failure" });
    await expect(
      t.mutation(internal.broadcast.rampRunner.recoverFromPartialFailure, {
        recovery: "manual-finished",
        reason: "test",
        // missing broadcastId, segmentId, sentAt, assigned
      }),
    ).rejects.toThrow(/missing required field/i);
  });

  test("manual-finished: AUTO-FILLS from persisted pending* state when operator omits args (P1#4)", async () => {
    // P1#4 fix: when the action dies after _recordPendingExport /
    // _recordPendingBroadcast but before _recordWaveSent (Convex action
    // timeout), recovery doesn't require operator to dig broadcastId/segmentId
    // out of the Resend dashboard. Persisted state is the source of truth.
    const t = convexTest(schema, modules);
    await seedRampConfig(t, {
      currentTier: 1,
      lastRunStatus: "partial-failure",
      pendingRunId: "run-died",
      pendingRunStartedAt: Date.now(),
      pendingWaveLabel: "wave-5",
      pendingSegmentId: "seg-persisted",
      pendingAssigned: 1500,
      pendingExportAt: Date.now() - 60000,
      pendingBroadcastId: "bc-persisted",
      pendingBroadcastAt: Date.now() - 30000,
    });
    const result = await t.mutation(
      internal.broadcast.rampRunner.recoverFromPartialFailure,
      {
        recovery: "manual-finished",
        reason: "Action timed out; manual send completed via Resend dashboard",
        sentAt: 1700000000000, // operator-only
        // broadcastId/segmentId/assigned/waveLabel — all OMITTED, fall back to persisted
      },
    );
    expect(result.ok).toBe(true);
    expect(result.advancedToTier).toBe(2);
    expect(result.broadcastId).toBe("bc-persisted");
    expect(result.segmentId).toBe("seg-persisted");
    expect(result.assigned).toBe(1500);
    expect(result.waveLabel).toBe("wave-5");
    expect(result.usedPersistedFallback).toEqual({
      broadcastId: true,
      segmentId: true,
      assigned: true,
      waveLabel: true,
    });

    const row = await loadRow(t);
    expect(row?.currentTier).toBe(2);
    expect(row?.lastWaveBroadcastId).toBe("bc-persisted");
    expect(row?.lastWaveSegmentId).toBe("seg-persisted");
    expect(row?.lastWaveAssigned).toBe(1500);
    expect(row?.lastWaveLabel).toBe("wave-5");
    expect(row?.lastWaveSentAt).toBe(1700000000000);
    // ALL pending* cleared.
    expect(row?.pendingWaveLabel).toBeUndefined();
    expect(row?.pendingSegmentId).toBeUndefined();
    expect(row?.pendingAssigned).toBeUndefined();
    expect(row?.pendingExportAt).toBeUndefined();
    expect(row?.pendingBroadcastId).toBeUndefined();
    expect(row?.pendingBroadcastAt).toBeUndefined();
    expect(row?.pendingRunId).toBeUndefined();
  });

  test("manual-finished: operator override beats persisted fallback when both supplied", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfig(t, {
      currentTier: 1,
      lastRunStatus: "partial-failure",
      pendingBroadcastId: "bc-persisted",
      pendingSegmentId: "seg-persisted",
      pendingAssigned: 1500,
      pendingWaveLabel: "wave-5",
    });
    const result = await t.mutation(
      internal.broadcast.rampRunner.recoverFromPartialFailure,
      {
        recovery: "manual-finished",
        reason: "broadcast was re-created with a different id during manual recovery",
        broadcastId: "bc-OVERRIDE",
        segmentId: "seg-OVERRIDE",
        assigned: 1234,
        waveLabel: "wave-5-retry",
        sentAt: 1700000000000,
      },
    );
    expect(result.broadcastId).toBe("bc-OVERRIDE");
    expect(result.segmentId).toBe("seg-OVERRIDE");
    expect(result.assigned).toBe(1234);
    expect(result.waveLabel).toBe("wave-5-retry");
    expect(result.usedPersistedFallback?.broadcastId).toBe(false);
    expect(result.usedPersistedFallback?.segmentId).toBe(false);
    expect(result.usedPersistedFallback?.assigned).toBe(false);
    expect(result.usedPersistedFallback?.waveLabel).toBe(false);
  });

  test("manual-finished: rejects when sentAt is omitted even with full persisted fallback", async () => {
    // sentAt is operator-only — no progress marker captures send-completion time.
    const t = convexTest(schema, modules);
    await seedRampConfig(t, {
      lastRunStatus: "partial-failure",
      pendingWaveLabel: "wave-5",
      pendingSegmentId: "seg-persisted",
      pendingAssigned: 1500,
      pendingBroadcastId: "bc-persisted",
    });
    await expect(
      t.mutation(internal.broadcast.rampRunner.recoverFromPartialFailure, {
        recovery: "manual-finished",
        reason: "test",
        // sentAt omitted, all others fall back
      }),
    ).rejects.toThrow(/missing required field.*sentAt/i);
  });

  test("discard-and-rotate: bumps waveLabelOffset + clears ALL pending* state", async () => {
    // Without offset bump, next cron retries the SAME waveLabel and
    // assignAndExportWave rejects because contacts are already stamped.
    // P1#4: also verify pending* are cleared so they don't leak into a
    // future recovery surface.
    const t = convexTest(schema, modules);
    await seedRampConfig(t, {
      currentTier: 1,
      waveLabelOffset: 3, // current next would be wave-(2+3)=wave-5
      lastRunStatus: "partial-failure",
      pendingRunId: "run-stuck",
      pendingRunStartedAt: Date.now(),
      pendingWaveLabel: "wave-5",
      pendingSegmentId: "seg-stamped",
      pendingAssigned: 1500,
      pendingBroadcastId: "bc-stamped",
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
    // All pending* cleared.
    expect(row?.pendingWaveLabel).toBeUndefined();
    expect(row?.pendingSegmentId).toBeUndefined();
    expect(row?.pendingAssigned).toBeUndefined();
    expect(row?.pendingBroadcastId).toBeUndefined();
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

// ───────────────────────────────────────────────────────────────────────────
// PR2 review-fix 7: runDailyRamp checks pendingRunId before scheduling
// ───────────────────────────────────────────────────────────────────────────

describe("runDailyRamp — pendingRunId guard (PR2 review-fix 7)", () => {
  test("refuses to schedule pickWaveAction when broadcastRampConfig.pendingRunId is held by a failed run", async () => {
    // Scenario: a wave hit `persist-failed` (or `segment-create-failed` /
    // `batch-failure-rate-exceeded`) — status='failed' but lease HELD.
    // _listInFlightWaveRuns excludes failed runs, so without this guard
    // runDailyRamp would schedule a new pickWaveAction whose
    // _claimWaveRunLease would refuse with `lease-held` — operator sees
    // wave-scheduled but ramp is actually blocked.
    const t = convexTest(schema, modules);
    await seedRampConfig(t, {
      pendingRunId: "stuck-run-1",
      pendingRunStartedAt: Date.now() - 5 * 60_000,
      pendingWaveLabel: "pro-launch-wave-4",
    });
    // Insert a corresponding waveRuns row in failed/persist-failed.
    await t.run(async (ctx) => {
      await ctx.db.insert("waveRuns", {
        runId: "stuck-run-1",
        waveLabel: "pro-launch-wave-4",
        status: "failed",
        failureSubstatus: "persist-failed",
        requestedCount: 100, totalCount: 0, underfilled: false,
        pushedCount: 0, failedCount: 0, batchSize: 50,
        createdAt: Date.now() - 5 * 60_000,
        updatedAt: Date.now() - 5 * 60_000,
      });
    });

    const result = await t.action(
      internal.broadcast.rampRunner.runDailyRamp,
      {},
    );
    // Must surface the lease-held condition, NOT report wave-scheduled.
    expect(result).toMatchObject({
      status: "lease-held-by-failed-run",
    });
    expect(result.detail).toContain("stuck-run-1");
    expect(result.detail).toContain("persist-failed");

    // Drain any incidentally scheduled functions to silence convex-test's
    // scheduler-dispatch artifact.
    await t.finishInProgressScheduledFunctions().catch(() => {});
  });

  test("schedules pickWaveAction normally when no lease is held", async () => {
    // Sanity: the pendingRunId guard should be a no-op on a clean ramp.
    const t = convexTest(schema, modules);
    await seedRampConfig(t);
    const result = await t.action(
      internal.broadcast.rampRunner.runDailyRamp,
      {},
    );
    expect(result.status).toBe("wave-scheduled");
    await t.finishInProgressScheduledFunctions().catch(() => {});
  });
});
