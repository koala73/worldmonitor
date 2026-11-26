import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");
const waveLabel = "test-wave-1";
const runId = "test-run";

async function setup(picking = false) {
  const t = convexTest(schema, modules);
  const contacts = Array.from({ length: picking ? 1 : 100 }, (_, i) => `recipient-${i}@example.com`);
  await t.run(async (ctx) => {
    await ctx.db.insert("broadcastRampConfig", {
      key: "current", active: true, rampCurve: [100, 200], currentTier: 0,
      waveLabelPrefix: "test-wave", waveLabelOffset: 0,
      bounceKillThreshold: 0.04, complaintKillThreshold: 0.001, killGateTripped: false,
    });
    for (const email of contacts) {
      await ctx.db.insert("registrations", {
        email, normalizedEmail: email,
        registeredAt: Date.now(), appVersion: "test",
      });
    }
  });
  await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
    runId, waveLabel, requestedCount: contacts.length, batchSize: 100,
  });
  await t.mutation(internal.broadcast.waveRuns._persistPickedBatch, {
    runId, contacts,
  });
  if (picking) return t;
  await t.mutation(internal.broadcast.waveRuns._markPickComplete, {
    runId, segmentId: "test-segment", totalCount: contacts.length, underfilled: false,
  });
  await t.mutation(internal.broadcast.waveRuns._markPushingStarted, { runId });
  const picked = await t.run((ctx) => ctx.db.query("wavePickedContacts").collect());
  for (const contact of picked) {
    await t.mutation(internal.broadcast.waveRuns._markContactPushed, {
      contactId: contact._id, runId, normalizedEmail: contact.normalizedEmail, waveLabel,
    });
  }
  return t;
}

async function state(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => ({
    run: await ctx.db.query("waveRuns").first(),
    config: await ctx.db.query("broadcastRampConfig").first(),
    registration: await ctx.db.query("registrations").first(),
    contacts: await ctx.db.query("wavePickedContacts").collect(),
  }));
}

describe("discard never makes emailed recipients eligible again", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  test("an interrupted picker can be discarded without permitting late completion", async () => {
    const t = await setup(true);
    await expect(t.mutation(internal.broadcast.waveRuns.discardWaveRun, { runId, reason: "picker stopped" })).resolves.toMatchObject({ ok: true });
    await expect(t.mutation(internal.broadcast.waveRuns._markPickComplete, {
      runId, segmentId: "late-segment", totalCount: 1, underfilled: false,
    })).rejects.toThrow(/expected picking/);
    expect(await t.mutation(internal.broadcast.waveRuns._cleanupDiscardedWavePickedContacts, { runId })).toMatchObject({ deleted: 1, hasMore: false });
    expect(await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
      runId: "next-run", waveLabel: "test-wave-2", requestedCount: 1, batchSize: 1,
    })).toMatchObject({ ok: true });
  });

  test("a successfully sent broadcast retains its stamp through discard and direct cleanup", async () => {
    const t = await setup();
    vi.stubEnv("RESEND_API_KEY", "synthetic-key");
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return Response.json({ id: "test-broadcast" });
    });
    await t.action(internal.broadcast.waveRuns.finalizeWaveAction, { runId });
    expect(urls).toEqual(["https://api.resend.com/broadcasts", "https://api.resend.com/broadcasts/test-broadcast/send"]);
    const before = await state(t);
    expect(before.run!.status).toBe("sent");
    await expect(t.mutation(internal.broadcast.waveRuns.discardWaveRun, { runId, reason: "test" })).rejects.toThrow(/discard/i);
    expect(await t.action(internal.broadcast.waveRuns.cleanupDiscardedWavePickedContactsAction, { runId })).toEqual({ deleted: 0, unstamped: 0, hasMore: false });
    expect(await state(t)).toEqual(before);
  });

  test("discard and cleanup cannot erase stamps while the send request is in flight", async () => {
    const t = await setup();
    vi.stubEnv("RESEND_API_KEY", "synthetic-key");
    let release!: () => void;
    let entered!: () => void;
    const sending = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.endsWith("/send")) { entered(); await pending; }
      return Response.json({ id: "test-broadcast" });
    });
    const finalizing = t.action(internal.broadcast.waveRuns.finalizeWaveAction, { runId }).catch((error) => error);
    await sending;
    let discardError: unknown;
    let cleanup;
    try {
      discardError = await t.mutation(internal.broadcast.waveRuns.discardWaveRun, { runId, reason: "test" }).then(() => null, (error) => error);
      cleanup = await t.mutation(internal.broadcast.waveRuns._cleanupDiscardedWavePickedContacts, { runId });
    } finally { release(); }
    await finalizing;
    expect(discardError).toBeInstanceOf(Error);
    expect(cleanup).toEqual({ deleted: 0, unstamped: 0, hasMore: false });
    const after = await state(t);
    expect(after.run!.status).toBe("sent");
    expect(after.registration!.proLaunchWave).toBe(waveLabel);
  });

  test.each(["pushing", "create-broadcast-failed", "send-broadcast-failed"])("preserves %s runs", async (phase) => {
    const t = await setup();
    if (phase === "send-broadcast-failed") await t.mutation(internal.broadcast.waveRuns._markBroadcastCreated, { runId, broadcastId: "test-broadcast" });
    if (phase !== "pushing") await t.mutation(internal.broadcast.waveRuns._markFinalizeFailed, { runId, substatus: phase as "create-broadcast-failed" | "send-broadcast-failed", error: "synthetic failure" });
    const before = await state(t);
    await expect(t.mutation(internal.broadcast.waveRuns.discardWaveRun, { runId, reason: "test" })).rejects.toThrow(/discard/i);
    expect(await t.mutation(internal.broadcast.waveRuns._cleanupDiscardedWavePickedContacts, { runId })).toEqual({ deleted: 0, unstamped: 0, hasMore: false });
    expect(await state(t)).toEqual(before);
  });

  test("a terminal failure with a broadcast ID is excluded from direct and daily cleanup", async () => {
    const t = await setup();
    await t.mutation(internal.broadcast.waveRuns._markBroadcastCreated, { runId, broadcastId: "test-broadcast" });
    // Model a legacy or delayed failure marker after broadcast creation.
    await t.run(async (ctx) => {
      const run = await ctx.db.query("waveRuns").first();
      await ctx.db.patch(run!._id, {
        status: "failed", failureSubstatus: "discarded-by-operator",
        updatedAt: Date.now() - 48 * 60 * 60 * 1000,
      });
    });
    const before = await state(t);
    await expect(t.mutation(internal.broadcast.waveRuns.discardWaveRun, { runId, reason: "test" })).rejects.toThrow(/discard/i);
    expect(await t.query(internal.broadcast.waveRuns._listFailedWaveRunsForCleanup, {})).toEqual([]);
    expect(await t.mutation(internal.broadcast.waveRuns._cleanupDiscardedWavePickedContacts, { runId })).toEqual({ deleted: 0, unstamped: 0, hasMore: false });
    expect(await state(t)).toEqual(before);
  });
});

// The daily cron is the safety net for a failed run the operator forgot to
// discard. `_listFailedWaveRunsForCleanup` used to `take(100)` and only then
// filter: every row in the range shares one index key, so that is always the
// OLDEST 100 failed runs, and nothing ever moves a run out of that prefix —
// cleanup deletes `wavePickedContacts` rows and unstamps registrations but
// never patches the `waveRuns` row, and a run that failed after its broadcast
// was created is never cleanable at all. Once 100 such runs sit at the head,
// the net reaches nothing newer, and every contact a forgotten wave pushed
// stays stamped and excluded from every future wave for good.
describe("the daily cleanup scan is not starved by uncleanable failed runs", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  const DAY = 24 * 60 * 60 * 1000;

  async function seedFailedRuns(count: number, make: (i: number) => Record<string, unknown>) {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let i = 0; i < count; i++) {
        await ctx.db.insert("waveRuns", {
          runId: `blocker-${i}`, waveLabel: `blocker-wave-${i}`,
          requestedCount: 1, batchSize: 1, totalCount: 1, underfilled: false,
          pushedCount: 0, failedCount: 0,
          status: "failed", createdAt: Date.now() - 10 * DAY, updatedAt: Date.now() - 10 * DAY,
          ...make(i),
        });
      }
    });
    return t;
  }

  test("a newer cleanable run is found behind 100 permanently uncleanable ones", async () => {
    // Failed AFTER the broadcast was created: never cleanable, and never
    // leaves the `status: "failed"` range.
    const t = await seedFailedRuns(100, (i) => ({
      broadcastId: `broadcast-${i}`, failureSubstatus: "send-broadcast-failed",
    }));
    await t.run(async (ctx) => {
      await ctx.db.insert("waveRuns", {
        runId: "forgotten-run", waveLabel: "forgotten-wave",
        requestedCount: 1, batchSize: 1, totalCount: 1, underfilled: false,
        pushedCount: 1, failedCount: 0,
        status: "failed", failureSubstatus: "persist-failed",
        createdAt: Date.now() - 2 * DAY, updatedAt: Date.now() - 2 * DAY,
      });
    });
    expect(await t.query(internal.broadcast.waveRuns._listFailedWaveRunsForCleanup, {}))
      .toEqual(["forgotten-run"]);
  });

  test("the per-tick cleanup budget still caps how many runs are returned", async () => {
    const t = await seedFailedRuns(130, () => ({ failureSubstatus: "persist-failed" }));
    const candidates = await t.query(internal.broadcast.waveRuns._listFailedWaveRunsForCleanup, {});
    expect(candidates).toHaveLength(100);
    expect(candidates[0]).toBe("blocker-0");
  });

  test("positive control: a run inside the 24h window is still left alone", async () => {
    const t = await seedFailedRuns(1, () => ({
      failureSubstatus: "persist-failed", updatedAt: Date.now() - 60 * 1000,
    }));
    expect(await t.query(internal.broadcast.waveRuns._listFailedWaveRunsForCleanup, {})).toEqual([]);
  });
});
