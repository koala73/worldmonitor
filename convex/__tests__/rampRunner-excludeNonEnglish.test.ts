/**
 * Tests for the `excludeNonEnglish` opt-in locale filter wired through
 * `broadcastRampConfig` → `runDailyRamp` → `pickWaveAction`.
 *
 * Lives in a separate file from `rampRunner.test.ts` to isolate from the
 * `runDailyRamp` scheduler tests there. Those tests schedule `pickWaveAction`
 * via `ctx.scheduler.runAfter` which causes convex-test's scheduler
 * simulator to leave deferred `_scheduled_functions` patches that fire
 * after the test transactions close — surfacing as
 * "Write outside of transaction 10001;_scheduled_functions" unhandled
 * rejections (CI-failing exit code 1) once the file accumulates enough
 * tests. Splitting the non-scheduler tests into a separate vitest file
 * avoids the timing collision.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");

async function seedRampConfigWithoutExcludeFlag(t: ReturnType<typeof convexTest>) {
  // Mirrors the helper in rampRunner.test.ts but does NOT pass
  // excludeNonEnglish — simulates a config row written before this
  // feature shipped.
  await t.run(async (ctx) => {
    await ctx.db.insert("broadcastRampConfig", {
      key: "current",
      active: true,
      rampCurve: [500, 1500, 5000],
      currentTier: 0,
      waveLabelPrefix: "wave",
      waveLabelOffset: 3,
      bounceKillThreshold: 0.04,
      complaintKillThreshold: 0.0008,
      killGateTripped: false,
    });
  });
}

describe("excludeNonEnglish — initRamp opt-in storage + getRampStatus exposure", () => {
  test("initRamp({excludeNonEnglish: true}) stores true; getRampStatus reflects it", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.broadcast.rampRunner.initRamp, {
      rampCurve: [1000],
      waveLabelPrefix: "test-wave",
      excludeNonEnglish: true,
    });
    const status = await t.query(
      internal.broadcast.rampRunner.getRampStatus,
      {},
    );
    expect(status.configured).toBe(true);
    expect(status.excludeNonEnglish).toBe(true);
  });

  test("initRamp({excludeNonEnglish: false}) stores false; round-trips", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.broadcast.rampRunner.initRamp, {
      rampCurve: [1000],
      waveLabelPrefix: "test-wave",
      excludeNonEnglish: false,
    });
    const status = await t.query(
      internal.broadcast.rampRunner.getRampStatus,
      {},
    );
    expect(status.excludeNonEnglish).toBe(false);
  });

  test("initRamp without excludeNonEnglish arg → defaults to false (NEVER silently true)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.broadcast.rampRunner.initRamp, {
      rampCurve: [1000],
      waveLabelPrefix: "test-wave",
      // no excludeNonEnglish
    });
    const status = await t.query(
      internal.broadcast.rampRunner.getRampStatus,
      {},
    );
    expect(status.excludeNonEnglish).toBe(false);
  });

  test("backwards compat — pre-existing config row missing field reads as false", async () => {
    const t = convexTest(schema, modules);
    // seedRampConfigWithoutExcludeFlag doesn't pass excludeNonEnglish —
    // simulates a row written before this feature shipped.
    await seedRampConfigWithoutExcludeFlag(t);
    const status = await t.query(
      internal.broadcast.rampRunner.getRampStatus,
      {},
    );
    expect(status.excludeNonEnglish).toBe(false);
  });

  test("abortRamp + initRamp({excludeNonEnglish: true}) cycle works", async () => {
    const t = convexTest(schema, modules);
    await seedRampConfigWithoutExcludeFlag(t);
    await t.mutation(internal.broadcast.rampRunner.abortRamp, {});
    await t.mutation(internal.broadcast.rampRunner.initRamp, {
      rampCurve: [1000],
      waveLabelPrefix: "test-wave",
      excludeNonEnglish: true,
    });
    const status = await t.query(
      internal.broadcast.rampRunner.getRampStatus,
      {},
    );
    expect(status.configured).toBe(true);
    expect(status.excludeNonEnglish).toBe(true);
  });
});
