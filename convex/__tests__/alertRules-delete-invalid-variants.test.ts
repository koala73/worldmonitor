import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ALERT_RULE_EVENT_TYPES_MAX } from "../../shared/alert-rule-shape";

/**
 * Cleanup for rows that `listShapeViolations` reports as VARIANT_INVALID
 * (legacy probe rows from the Strix pentest, 2026-10-27). The operator passes
 * ids from the audit; the mutation re-reads each row and deletes it only when
 * its variant is still outside the registry, so a stale id list cannot remove
 * a row the dashboard can still reach.
 */

const modules = import.meta.glob("../**/*.ts");
const USER = "user-delete-invalid-variants";

const base = { userId: USER, enabled: false, eventTypes: [], sensitivity: "high" as const, channels: [], updatedAt: 1 };

async function seed(t: ReturnType<typeof convexTest>, rows: Array<Record<string, unknown>>) {
  return await t.run(async (ctx) => {
    const ids: Id<"alertRules">[] = [];
    for (const row of rows) ids.push(await ctx.db.insert("alertRules", { ...base, ...row } as never));
    return ids;
  });
}

async function storedVariants(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("alertRules").withIndex("by_user", (q) => q.eq("userId", USER)).collect())
      .map((r) => r.variant)
      .sort(),
  );
}

describe("deleteInvalidVariantRules", () => {
  test("deletes the listed rows whose variant is outside the registry", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, [{ variant: "sweep-0" }, { variant: "strix-cap-probe", enabled: true }, { variant: "full" }]);

    const res = await t.mutation(internal.alertRules.deleteInvalidVariantRules, { ids: ids.slice(0, 2) });

    expect(res.deleted).toEqual([ids[0], ids[1]]);
    expect(res.skipped).toEqual([]);
    expect(await storedVariants(t)).toEqual(["full"]);
  });

  test("dryRun reports what it would delete and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, [{ variant: "sweep-1" }, { variant: "sweep-2" }]);

    const res = await t.mutation(internal.alertRules.deleteInvalidVariantRules, { ids: [...ids, ids[0]], dryRun: true });

    expect(res.deleted).toEqual(ids);
    expect(await storedVariants(t)).toEqual(["sweep-1", "sweep-2"]);
  });

  test("keeps registry-variant rows even when they break other shape rules", async () => {
    const t = convexTest(schema, modules);
    const tooManyEventTypes = Array.from({ length: ALERT_RULE_EVENT_TYPES_MAX + 1 }, (_, i) => `event_${i}`);
    const ids = await seed(t, [{ variant: "energy", eventTypes: tooManyEventTypes }, { variant: "tech" }]);

    const res = await t.mutation(internal.alertRules.deleteInvalidVariantRules, { ids });

    expect(res.deleted).toEqual([]);
    expect(res.skipped).toEqual([
      { id: ids[0], reason: "VARIANT_VALID" },
      { id: ids[1], reason: "VARIANT_VALID" },
    ]);
    expect(await storedVariants(t)).toEqual(["energy", "tech"]);
  });

  test("skips ids that no longer exist, so a re-run is a no-op", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, [{ variant: "sweep-3" }]);
    await t.mutation(internal.alertRules.deleteInvalidVariantRules, { ids });

    const again = await t.mutation(internal.alertRules.deleteInvalidVariantRules, { ids });

    expect(again.deleted).toEqual([]);
    expect(again.skipped).toEqual([{ id: ids[0], reason: "NOT_FOUND" }]);
  });

  test("stops before the transaction read limit and hands back the rest", async () => {
    // ~0.9 MiB per row; 20 of them is past Convex's 16 MiB read limit in prod.
    // convex-test does not enforce that limit for db.get, so this pins the
    // byte budget's batching rather than the limit itself.
    const oversized = Array.from({ length: 7000 }, (_, i) => `${i}`.padEnd(128, "x"));
    const t = convexTest(schema, modules);
    const ids = await seed(t, Array.from({ length: 20 }, (_, i) => ({ variant: `size-probe-${i}`, eventTypes: oversized })));

    const first = await t.mutation(internal.alertRules.deleteInvalidVariantRules, { ids });
    expect(first.deleted.length).toBeGreaterThan(0);
    expect(first.remaining.length).toBeGreaterThan(0);
    expect([...first.deleted, ...first.remaining]).toEqual(ids);

    const second = await t.mutation(internal.alertRules.deleteInvalidVariantRules, { ids: first.remaining });
    expect(second.remaining).toEqual([]);
    expect(await storedVariants(t)).toEqual([]);
  });

  test("refuses more ids than one call may delete", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, Array.from({ length: 101 }, (_, i) => ({ variant: `sweep-${i}` })));

    await expect(t.mutation(internal.alertRules.deleteInvalidVariantRules, { ids })).rejects.toThrow(/at most 100/);
    expect((await storedVariants(t)).length).toBe(101);
  });
});
