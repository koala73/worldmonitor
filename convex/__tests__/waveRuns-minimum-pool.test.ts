import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");

describe("direct picker calls enforce the minimum cohort", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  test.each([
    { available: 100, requestedCount: 99.5, proceeds: false },
    { available: 99, requestedCount: 100, proceeds: false },
    { available: 100, requestedCount: 99, proceeds: false },
    { available: 100, requestedCount: 100, proceeds: true },
  ])("$available eligible contacts, requestedCount=$requestedCount", async ({ available, requestedCount, proceeds }) => {
    const t = convexTest(schema, modules);
    vi.stubEnv("RESEND_API_KEY", "synthetic-key");
    const fetchMock = vi.fn(async () => Response.json({ id: "test-segment" }));
    vi.stubGlobal("fetch", fetchMock);
    await t.run(async (ctx) => {
      await ctx.db.insert("broadcastRampConfig", {
        key: "current", active: true, rampCurve: [requestedCount], currentTier: 0,
        waveLabelPrefix: "test-wave", waveLabelOffset: 0,
        bounceKillThreshold: 0.04, complaintKillThreshold: 0.001, killGateTripped: false,
      });
      for (let i = 0; i < available; i++) {
        await ctx.db.insert("registrations", {
          email: `recipient-${i}@example.com`, normalizedEmail: `recipient-${i}@example.com`,
          registeredAt: Date.now(), appVersion: "test",
        });
      }
    });
    const picking = t.action(internal.broadcast.waveRuns.pickWaveAction, {
      runId: "test-run", waveLabel: "test-wave-1", requestedCount,
    });
    if (!Number.isInteger(requestedCount)) {
      await expect(picking).rejects.toThrow("requestedCount must be a positive integer");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await t.run((ctx) => ctx.db.query("waveRuns").first())).toBeNull();
      return;
    }
    const result = await picking;
    const state = await t.run(async (ctx) => ({
      run: await ctx.db.query("waveRuns").first(),
      config: await ctx.db.query("broadcastRampConfig").first(),
      contacts: await ctx.db.query("wavePickedContacts").collect(),
    }));
    if (proceeds) {
      expect(result).toEqual({ ok: true });
      expect(state.run!.status).toBe("segment-created");
      expect(state.contacts).toHaveLength(100);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } else {
      expect(result).toEqual({ ok: false, reason: "pool-too-small" });
      expect(state.run).toMatchObject({ status: "failed", failureSubstatus: "pool-too-small" });
      expect(state.config!.active).toBe(false);
      expect(state.config!.pendingRunId).toBeUndefined();
      expect(state.contacts).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(state.run!.error).toContain("at least 100 eligible contacts");
      expect(state.run!.error).toContain("requestedCount >= 100");
      expect(state.run!.error).not.toContain("final wave manually");
    }
  });
});
