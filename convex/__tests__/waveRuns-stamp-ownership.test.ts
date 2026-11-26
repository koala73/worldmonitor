import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");
const runId = "stamp-test-run";
const waveLabel = "test-wave-2";
const email = "recipient@example.com";

async function setup() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("broadcastRampConfig", {
      key: "current", active: true, rampCurve: [100], currentTier: 0,
      waveLabelPrefix: "test-wave", waveLabelOffset: 1,
      bounceKillThreshold: 0.04, complaintKillThreshold: 0.001, killGateTripped: false,
    });
    await ctx.db.insert("registrations", {
      email, normalizedEmail: email, registeredAt: Date.now(), appVersion: "test",
    });
  });
  await t.mutation(internal.broadcast.waveRuns._claimWaveRunLease, {
    runId, waveLabel, requestedCount: 1, batchSize: 1,
  });
  await t.mutation(internal.broadcast.waveRuns._persistPickedBatch, { runId, contacts: [email] });
  await t.mutation(internal.broadcast.waveRuns._markPickComplete, {
    runId, segmentId: "test-segment", totalCount: 1, underfilled: false,
  });
  const contact = await t.run((ctx) => ctx.db.query("wavePickedContacts").first());
  return { t, args: { contactId: contact!._id, runId, normalizedEmail: email, waveLabel } };
}

async function read(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => ({
    registration: await ctx.db.query("registrations").first(),
    contact: await ctx.db.query("wavePickedContacts").first(),
    run: await ctx.db.query("waveRuns").first(),
  }));
}

describe("contact push preserves wave stamp ownership", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  test("a discarded terminal run rejects late push completion without minting a stamp", async () => {
    const { t, args } = await setup();
    await t.mutation(internal.broadcast.waveRuns._markPickFailed, {
      runId, substatus: "persist-failed", error: "synthetic terminal failure before broadcast",
    });
    await t.mutation(internal.broadcast.waveRuns.discardWaveRun, { runId, reason: "test discard" });
    const before = await read(t);
    expect(await t.mutation(internal.broadcast.waveRuns._markContactPushed, args))
      .toEqual({ ok: false, reason: "run-not-pushing" });
    expect(await read(t)).toEqual(before);
    expect((await read(t)).registration!.proLaunchWave).toBeUndefined();
  });

  test.each(["test-wave-1", waveLabel, "test-wave-3"])("retains existing %s label and assignment time", async (owner) => {
    const { t, args } = await setup();
    await t.mutation(internal.broadcast.audienceWaveExport._stampWaveByNormalizedEmail, {
      normalizedEmail: email, waveLabel: owner, assignedAt: 123,
    });
    expect(await t.mutation(internal.broadcast.waveRuns._markContactPushed, args)).toEqual({ ok: true, stampResult: "alreadyStamped" });
    const state = await read(t);
    expect(state.registration).toMatchObject({ proLaunchWave: owner, proLaunchWaveAssignedAt: 123 });
    expect(state.contact!.status).toBe("pushed");
    expect(state.run!.pushedCount).toBe(1);
    expect(await t.mutation(internal.broadcast.waveRuns._markContactPushed, args)).toEqual({ ok: false, reason: "not-pending" });
    expect(await read(t)).toEqual(state);
  });

  test("a late push worker preserves ownership acquired during the provider request and subsequent cleanup", async () => {
    const { t } = await setup();
    vi.stubEnv("RESEND_API_KEY", "synthetic-key");
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(async () => { entered(); await pending; return Response.json({ id: "test-contact" }); });
    vi.stubGlobal("fetch", fetchMock);
    const pushing = t.action(internal.broadcast.waveRuns.pushBatchAction, { runId, batchN: 0 });
    await started;
    try {
      await t.mutation(internal.broadcast.audienceWaveExport._stampWaveByNormalizedEmail, {
        normalizedEmail: email, waveLabel: "legacy-wave", assignedAt: 456,
      });
    } finally { release(); }
    expect(await pushing).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const pushed = await read(t);
    expect(pushed.registration).toMatchObject({ proLaunchWave: "legacy-wave", proLaunchWaveAssignedAt: 456 });
    expect(pushed.run!.pushedCount).toBe(1);
    expect(pushed.contact!.status).toBe("pushed");
    await t.mutation(internal.broadcast.waveRuns._markPickFailed, {
      runId, substatus: "persist-failed", error: "synthetic terminal failure before broadcast",
    });
    await t.mutation(internal.broadcast.waveRuns._cleanupDiscardedWavePickedContacts, { runId });
    expect((await read(t)).registration).toEqual(pushed.registration);
  });
});

// The reverse direction of the suite above. `_markContactPushed` preserves an
// existing stamp, and `_cleanupDiscardedWavePickedContacts` only unstamps a
// row whose label still matches its own run — but the legacy CLI stamper
// compared against its OWN label only, so it rewrote ownership another wave
// had already committed, and rewrote `proLaunchWaveAssignedAt` with it. The
// contact then sat in two Resend segments, received two launch emails, and
// was out of reach of the discard-time unstamp.
describe("the legacy wave stamper preserves ownership it does not hold", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  const stamp = (t: ReturnType<typeof convexTest>, label: string, assignedAt: number) =>
    t.mutation(internal.broadcast.audienceWaveExport._stampWaveByNormalizedEmail, {
      normalizedEmail: email, waveLabel: label, assignedAt,
    });

  test("a row the production pipeline already stamped is reported, not overwritten", async () => {
    const { t, args } = await setup();
    expect(await t.mutation(internal.broadcast.waveRuns._markContactPushed, args))
      .toEqual({ ok: true, stampResult: "stamped" });
    const owned = (await read(t)).registration!;
    expect(owned.proLaunchWave).toBe(waveLabel);

    expect(await stamp(t, "test-wave-9", 999)).toEqual({ result: "ownedByOtherWave" });
    const after = (await read(t)).registration!;
    expect(after.proLaunchWave).toBe(waveLabel);
    expect(after.proLaunchWaveAssignedAt).toBe(owned.proLaunchWaveAssignedAt);
  });

  test("the discard-time unstamp still reaches a contact the CLI ran over", async () => {
    const { t, args } = await setup();
    await t.mutation(internal.broadcast.waveRuns._markContactPushed, args);
    await stamp(t, "test-wave-9", 999);
    await t.mutation(internal.broadcast.waveRuns._markPickFailed, {
      runId, substatus: "persist-failed", error: "synthetic terminal failure before broadcast",
    });
    await t.mutation(internal.broadcast.waveRuns._cleanupDiscardedWavePickedContacts, { runId });
    // Only reachable because the label still belongs to this run.
    expect((await read(t)).registration!.proLaunchWave).toBeUndefined();
  });

  test("an unstamped row and a re-stamp of the same label are unchanged", async () => {
    const { t } = await setup();
    expect(await stamp(t, waveLabel, 123)).toEqual({ result: "stamped" });
    expect(await stamp(t, waveLabel, 456)).toEqual({ result: "alreadyStamped" });
    const row = (await read(t)).registration!;
    expect(row.proLaunchWave).toBe(waveLabel);
    expect(row.proLaunchWaveAssignedAt).toBe(123);
  });
});
