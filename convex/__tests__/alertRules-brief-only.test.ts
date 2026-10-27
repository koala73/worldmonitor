import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import * as alertRules from "../alertRules";
import { getFeaturesForPlan } from "../lib/entitlements";

const modules = import.meta.glob("../**/*.ts");
const DAY = 86_400_000;

// A paid user with no digest rule used to get no brief at all, while the
// dashboard's Latest Brief panel told them "the editorial team is writing your
// brief" forever (2026-10-27: 251 active paid users, including the owner).
// getBriefOnlyUsers lists the paid users the digest cron must compose a
// default brief for.
describe("alertRules.getBriefOnlyUsers", () => {
  test("is internal: it scans every user's entitlement", () => {
    const fn = alertRules.getBriefOnlyUsers as unknown as { isQuery?: boolean; isInternal?: boolean; isPublic?: boolean };
    expect(fn.isQuery).toBe(true);
    expect(fn.isInternal).toBe(true);
    expect(fn.isPublic).toBeUndefined();
  });

  test("lists active paid users without a digest rule or an AI-digest opt-out", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      const ent = (userId: string, planKey: string, validUntil: number) =>
        ctx.db.insert("entitlements", { userId, planKey, features: getFeaturesForPlan(planKey), validUntil, updatedAt: now });
      const rule = (userId: string, extra: Record<string, unknown>) =>
        ctx.db.insert("alertRules", {
          userId, variant: "full", enabled: true, eventTypes: [], sensitivity: "high", channels: [], updatedAt: now, ...extra,
        });

      await ent("user_pro_no_rules", "pro_monthly", now + 30 * DAY);
      await ent("user_pro_realtime_only", "pro_annual", now + 30 * DAY);
      await rule("user_pro_realtime_only", { digestMode: "realtime" });
      await ent("user_pro_disabled_daily", "pro_monthly", now + 30 * DAY);
      await rule("user_pro_disabled_daily", { enabled: false, digestMode: "daily" });

      await ent("user_pro_with_digest", "pro_monthly", now + 30 * DAY);
      await rule("user_pro_with_digest", { digestMode: "daily" });
      await ent("user_pro_opted_out", "pro_monthly", now + 30 * DAY);
      await rule("user_pro_opted_out", { digestMode: "realtime", aiDigestEnabled: false });
      await ent("user_free", "free", now + 30 * DAY);
      await ent("user_pro_expired", "pro_monthly", now - DAY);
    });

    const users = await t.query(internal.alertRules.getBriefOnlyUsers, {});
    expect([...users].sort()).toEqual([
      "user_pro_disabled_daily",
      "user_pro_no_rules",
      "user_pro_realtime_only",
    ]);
  });
});
