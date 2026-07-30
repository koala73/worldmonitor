/**
 * alertRules.countries — country-scope persistence + normalization tests.
 *
 * Layer 2 of the country-scoping PR (independent of the followed-countries
 * primitive). Covers:
 *  - normalize-on-write: trim, uppercase, regex filter, dedupe
 *  - cap at COUNTRIES_MAX (50) — throws on overflow
 *  - backward compat: omitted on insert → field absent on row
 *  - preserve-on-omit: caller omits `countries` → existing value retained
 *  - explicit reset: caller passes [] → row stores []
 *  - shape-only validation: 'XX' (real shape, fake country) is stored;
 *    semantic validation lives in the relay filter
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");

const USER = { subject: "user-tests-countries", tokenIdentifier: "clerk|user-tests-countries" };
const VARIANT = "full";

async function seedProEntitlement(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("entitlements", {
      userId: USER.subject,
      planKey: "pro_monthly",
      features: {
        tier: 1,
        maxDashboards: 10,
        apiAccess: true,
        apiRateLimit: 1000,
        prioritySupport: true,
        exportFormats: ["json", "csv"],
      },
      validUntil: Date.now() + 30 * 24 * 60 * 60 * 1000,
      updatedAt: Date.now(),
    });
  });
}

async function readRow(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    return await ctx.db
      .query("alertRules")
      .withIndex("by_user_variant", (q) => q.eq("userId", USER.subject).eq("variant", VARIANT))
      .unique();
  });
}

describe("alertRules.countries — persistence + normalization", () => {
  test("plain alpha-2 list is stored as-is", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t);
    const asUser = t.withIdentity(USER);
    await asUser.mutation(api.alertRules.setAlertRules, {
      variant: VARIANT,
      enabled: true,
      eventTypes: [],
      sensitivity: "critical",
      channels: [],
      countries: ["US", "GB"],
    });
    const row = await readRow(t);
    expect(row?.countries).toEqual(["US", "GB"]);
  });

  test("normalizes case + whitespace + dedupe", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t);
    const asUser = t.withIdentity(USER);
    await asUser.mutation(api.alertRules.setAlertRules, {
      variant: VARIANT,
      enabled: true,
      eventTypes: [],
      sensitivity: "critical",
      channels: [],
      countries: ["us", "GB", "us", "  IR  "],
    });
    const row = await readRow(t);
    expect(row?.countries).toEqual(["US", "GB", "IR"]);
  });

  test("drops malformed shapes (regex filter), keeps shape-valid 'XX'", async () => {
    // 'XX' is not a real ISO country but matches ^[A-Z]{2}$ — we deliberately
    // don't strict-validate against an ISO registry at the schema layer (the
    // relay's includes() check just won't match any real event country).
    // 'US123', '', 'United States' all fail the regex and are dropped.
    const t = convexTest(schema, modules);
    await seedProEntitlement(t);
    const asUser = t.withIdentity(USER);
    await asUser.mutation(api.alertRules.setAlertRules, {
      variant: VARIANT,
      enabled: true,
      eventTypes: [],
      sensitivity: "critical",
      channels: [],
      countries: ["XX", "US123", "", "United States", "G"],
    });
    const row = await readRow(t);
    expect(row?.countries).toEqual(["XX"]);
  });

  test("caps at 50 entries — throws COUNTRIES_LIMIT_EXCEEDED on 101", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t);
    const asUser = t.withIdentity(USER);
    // 101 unique 2-letter codes (cycles AA, AB, ... ; not real ISO but shape-valid).
    const codes: string[] = [];
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    outer: for (let i = 0; i < letters.length; i++) {
      for (let j = 0; j < letters.length; j++) {
        codes.push(letters[i] + letters[j]);
        if (codes.length >= 101) break outer;
      }
    }
    await expect(
      asUser.mutation(api.alertRules.setAlertRules, {
        variant: VARIANT,
        enabled: true,
        eventTypes: [],
        sensitivity: "critical",
        channels: [],
        countries: codes,
      }),
    ).rejects.toThrow(/COUNTRIES_LIMIT_EXCEEDED|capped at 50/);
  });

  test("backward compat: insert without countries field → field absent on row", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t);
    const asUser = t.withIdentity(USER);
    await asUser.mutation(api.alertRules.setAlertRules, {
      variant: VARIANT,
      enabled: true,
      eventTypes: [],
      sensitivity: "critical",
      channels: [],
    });
    const row = await readRow(t);
    expect(row).not.toBeNull();
    expect(row?.countries).toBeUndefined();
  });

  test("preserve-on-omit: existing countries:['US'] + caller omits → row still has ['US']", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t);
    const asUser = t.withIdentity(USER);
    // First write: seed countries.
    await asUser.mutation(api.alertRules.setAlertRules, {
      variant: VARIANT,
      enabled: true,
      eventTypes: [],
      sensitivity: "critical",
      channels: [],
      countries: ["US"],
    });
    // Second write: omit countries (e.g. user toggled 'enabled' on the form).
    await asUser.mutation(api.alertRules.setAlertRules, {
      variant: VARIANT,
      enabled: false,
      eventTypes: [],
      sensitivity: "critical",
      channels: [],
    });
    const row = await readRow(t);
    expect(row?.countries).toEqual(["US"]);
    expect(row?.enabled).toBe(false);
  });

  test("explicit reset: existing countries:['US'] + caller passes [] → row stores []", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t);
    const asUser = t.withIdentity(USER);
    await asUser.mutation(api.alertRules.setAlertRules, {
      variant: VARIANT,
      enabled: true,
      eventTypes: [],
      sensitivity: "critical",
      channels: [],
      countries: ["US"],
    });
    await asUser.mutation(api.alertRules.setAlertRules, {
      variant: VARIANT,
      enabled: true,
      eventTypes: [],
      sensitivity: "critical",
      channels: [],
      countries: [],
    });
    const row = await readRow(t);
    expect(row?.countries).toEqual([]);
  });

  test("setNotificationConfigForUser also forwards countries", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t);
    // setNotificationConfigForUser is internal — call via t.run / runMutation pattern.
    await t.mutation(internal.alertRules.setNotificationConfigForUser, {
      userId: USER.subject,
      variant: VARIANT,
      enabled: true,
      eventTypes: [],
      sensitivity: "critical",
      channels: [],
      countries: ["fr", "  DE", "FR"],
    });
    const row = await readRow(t);
    expect(row?.countries).toEqual(["FR", "DE"]);
  });

  test("setQuietHoursForUser first-row insert preserves supplied countries", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.alertRules.setQuietHoursForUser, {
      userId: USER.subject,
      variant: VARIANT,
      quietHoursEnabled: true,
      quietHoursStart: 22,
      quietHoursEnd: 7,
      countries: ["us", "GB", "us"],
    });
    const row = await readRow(t);
    expect(row?.countries).toEqual(["US", "GB"]);
    expect(row?.quietHoursEnabled).toBe(true);
  });

  test("setQuietHoursForUser first-row insert omitting countries leaves countries absent", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.alertRules.setQuietHoursForUser, {
      userId: USER.subject,
      variant: VARIANT,
      quietHoursEnabled: true,
      quietHoursStart: 22,
      quietHoursEnd: 7,
    });
    const row = await readRow(t);
    expect(row?.countries).toBeUndefined();
    expect(row?.quietHoursEnabled).toBe(true);
  });

  test("setDigestSettingsForUser first-row insert preserves supplied countries", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.alertRules.setDigestSettingsForUser, {
      userId: USER.subject,
      variant: VARIANT,
      digestMode: "daily",
      digestHour: 8,
      countries: ["il", " AE "],
    });
    const row = await readRow(t);
    expect(row?.countries).toEqual(["IL", "AE"]);
    expect(row?.digestMode).toBe("daily");
  });

  test("setDigestSettingsForUser first-row insert omitting countries leaves countries absent", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.alertRules.setDigestSettingsForUser, {
      userId: USER.subject,
      variant: VARIANT,
      digestMode: "daily",
      digestHour: 8,
    });
    const row = await readRow(t);
    expect(row?.countries).toBeUndefined();
    expect(row?.digestMode).toBe("daily");
  });
});
