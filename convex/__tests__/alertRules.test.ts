import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");

const USER = { subject: "user-tests-alertrules", tokenIdentifier: "clerk|user-tests-alertrules" };
const VARIANT = "full";

// ---------------------------------------------------------------------------
// Cross-field invariant: (digestMode='realtime', sensitivity='all') is forbidden.
// See plans/forbid-realtime-all-events.md.
// ---------------------------------------------------------------------------

describe("alertRules — (realtime, all) cross-field invariant", () => {
  test("setAlertRules({sensitivity:'all'}) against existing realtime row → throws", async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity(USER);
    // Seed an existing row in realtime mode with high sensitivity (compatible).
    await asUser.mutation(api.alertRules.setAlertRules, {
      variant: VARIANT,
      enabled: true,
      eventTypes: [],
      sensitivity: "high",
      channels: [],
    });
    // Attempting to widen to 'all' must throw INCOMPATIBLE_DELIVERY.
    await expect(
      asUser.mutation(api.alertRules.setAlertRules, {
        variant: VARIANT,
        enabled: true,
        eventTypes: [],
        sensitivity: "all",
        channels: [],
      }),
    ).rejects.toThrow(/INCOMPATIBLE_DELIVERY|Real-time delivery requires/i);
  });

  test("setAlertRules({sensitivity:'all'}) against existing daily-digest row → succeeds", async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity(USER);
    // Seed a daily-digest row.
    await asUser.mutation(api.alertRules.setDigestSettings, {
      variant: VARIANT,
      digestMode: "daily",
      digestHour: 8,
      digestTimezone: "UTC",
    });
    await asUser.mutation(api.alertRules.setAlertRules, {
      variant: VARIANT,
      enabled: true,
      eventTypes: [],
      sensitivity: "all",
      channels: [],
    });
    const rows = await asUser.query(api.alertRules.getAlertRules, {});
    expect(rows.find((r) => r.variant === VARIANT)?.sensitivity).toBe("all");
    expect(rows.find((r) => r.variant === VARIANT)?.digestMode).toBe("daily");
  });

  test("setDigestSettings({digestMode:'realtime'}) against existing sensitivity:'all' digest → throws", async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity(USER);
    await asUser.mutation(api.alertRules.setDigestSettings, {
      variant: VARIANT,
      digestMode: "daily",
    });
    await asUser.mutation(api.alertRules.setAlertRules, {
      variant: VARIANT,
      enabled: true,
      eventTypes: [],
      sensitivity: "all",
      channels: [],
    });
    await expect(
      asUser.mutation(api.alertRules.setDigestSettings, {
        variant: VARIANT,
        digestMode: "realtime",
      }),
    ).rejects.toThrow(/INCOMPATIBLE_DELIVERY|Real-time delivery requires/i);
  });

  test("setDigestSettings({digestMode:'daily'}) against existing sensitivity:'all' realtime → succeeds, sensitivity preserved", async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity(USER);
    // Seed via direct insert to bypass the validators (simulates pre-migration row).
    await t.run(async (ctx) => {
      await ctx.db.insert("alertRules", {
        userId: USER.subject,
        variant: VARIANT,
        enabled: true,
        eventTypes: [],
        sensitivity: "all",
        channels: [],
        updatedAt: Date.now(),
        // digestMode absent → effective 'realtime'
      });
    });
    await asUser.mutation(api.alertRules.setDigestSettings, {
      variant: VARIANT,
      digestMode: "daily",
      digestHour: 8,
      digestTimezone: "UTC",
    });
    const rows = await asUser.query(api.alertRules.getAlertRules, {});
    const row = rows.find((r) => r.variant === VARIANT);
    expect(row?.digestMode).toBe("daily");
    expect(row?.sensitivity).toBe("all");
  });
});

// ---------------------------------------------------------------------------
// Insert-only default flip: sensitivity:'all' → sensitivity:'high' on fresh
// insert ONLY. Patch path must NEVER silently rewrite an existing row's
// sensitivity when the caller omits the field.
// ---------------------------------------------------------------------------

describe("alertRules — insert-only default for sensitivity", () => {
  test("setAlertRulesForUser with no existing row, sensitivity omitted → defaults to 'high'", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.alertRules.setAlertRulesForUser, {
      userId: USER.subject,
      variant: VARIANT,
      enabled: true,
      eventTypes: [],
      // sensitivity intentionally omitted
      channels: [],
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("alertRules")
        .withIndex("by_user_variant", (q) => q.eq("userId", USER.subject).eq("variant", VARIANT))
        .collect(),
    );
    expect(rows[0]?.sensitivity).toBe("high");
  });

  test("setAlertRulesForUser with existing daily+all row, sensitivity omitted → preserves 'all'", async () => {
    // The patch-vs-insert subtlety: omitted sensitivity on a digest user must NOT
    // silently narrow to 'high'. This is the regression Codex flagged in round 3.
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("alertRules", {
        userId: USER.subject,
        variant: VARIANT,
        enabled: true,
        eventTypes: [],
        sensitivity: "all",
        channels: [],
        digestMode: "daily",
        digestHour: 8,
        digestTimezone: "UTC",
        updatedAt: Date.now(),
      });
    });
    await t.mutation(internal.alertRules.setAlertRulesForUser, {
      userId: USER.subject,
      variant: VARIANT,
      enabled: true,
      eventTypes: ["something"],
      // sensitivity omitted — must be preserved
      channels: ["email"],
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("alertRules")
        .withIndex("by_user_variant", (q) => q.eq("userId", USER.subject).eq("variant", VARIANT))
        .collect(),
    );
    expect(rows[0]?.sensitivity).toBe("all");
    expect(rows[0]?.digestMode).toBe("daily");
    expect(rows[0]?.eventTypes).toEqual(["something"]);
  });

  test("setQuietHoursForUser with no existing row → inserts with sensitivity:'high', not 'all'", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.alertRules.setQuietHoursForUser, {
      userId: USER.subject,
      variant: VARIANT,
      quietHoursEnabled: true,
      quietHoursStart: 22,
      quietHoursEnd: 7,
      quietHoursTimezone: "UTC",
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("alertRules")
        .withIndex("by_user_variant", (q) => q.eq("userId", USER.subject).eq("variant", VARIANT))
        .collect(),
    );
    expect(rows[0]?.sensitivity).toBe("high");
  });

  test("setQuietHoursForUser does NOT throw on pre-migration forbidden row (Greptile P1)", async () => {
    // Before fix: assertCompatibleDeliveryMode was called on every quiet-hours
    // save, so pre-migration (realtime, all) rows would fail with INCOMPATIBLE_DELIVERY
    // → generic 500 (no passthrough on set-quiet-hours HTTP action). Quiet-hours
    // updates on a forbidden row must succeed because they don't touch the pair.
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("alertRules", {
        userId: USER.subject,
        variant: VARIANT,
        enabled: true,
        eventTypes: [],
        sensitivity: "all",
        channels: [],
        // digestMode absent → effective 'realtime' (forbidden pair)
        updatedAt: Date.now(),
      });
    });
    await t.mutation(internal.alertRules.setQuietHoursForUser, {
      userId: USER.subject,
      variant: VARIANT,
      quietHoursEnabled: true,
      quietHoursStart: 22,
      quietHoursEnd: 7,
      quietHoursTimezone: "UTC",
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("alertRules")
        .withIndex("by_user_variant", (q) => q.eq("userId", USER.subject).eq("variant", VARIANT))
        .collect(),
    );
    expect(rows[0]?.quietHoursEnabled).toBe(true);
    expect(rows[0]?.quietHoursStart).toBe(22);
    // Sensitivity preserved — no silent migration via this path.
    expect(rows[0]?.sensitivity).toBe("all");
  });
});

// ---------------------------------------------------------------------------
// Atomic mutation: setNotificationConfigForUser handles pair-flip transitions
// that the legacy two-call sequence races against.
// ---------------------------------------------------------------------------

describe("alertRules — setNotificationConfigForUser atomic pair update", () => {
  test("rejects (realtime, all) atomically", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.alertRules.setNotificationConfigForUser, {
        userId: USER.subject,
        variant: VARIANT,
        digestMode: "realtime",
        sensitivity: "all",
      }),
    ).rejects.toThrow(/INCOMPATIBLE_DELIVERY|Real-time delivery requires/i);
  });

  test("daily+all → realtime+high lands atomically (no race)", async () => {
    const t = convexTest(schema, modules);
    // Seed daily+all (the legitimate prior state).
    await t.run(async (ctx) => {
      await ctx.db.insert("alertRules", {
        userId: USER.subject,
        variant: VARIANT,
        enabled: true,
        eventTypes: [],
        sensitivity: "all",
        channels: [],
        digestMode: "daily",
        digestHour: 8,
        digestTimezone: "UTC",
        updatedAt: Date.now(),
      });
    });
    await t.mutation(internal.alertRules.setNotificationConfigForUser, {
      userId: USER.subject,
      variant: VARIANT,
      digestMode: "realtime",
      sensitivity: "high",
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("alertRules")
        .withIndex("by_user_variant", (q) => q.eq("userId", USER.subject).eq("variant", VARIANT))
        .collect(),
    );
    expect(rows[0]?.digestMode).toBe("realtime");
    expect(rows[0]?.sensitivity).toBe("high");
  });

  test("partial update {enabled:true} against existing forbidden row → throws (re-validation)", async () => {
    // Existing row in forbidden state (e.g. pre-migration). Partial update that
    // doesn't touch the pair must still reject because the pair derived from
    // existing+incoming is still forbidden.
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("alertRules", {
        userId: USER.subject,
        variant: VARIANT,
        enabled: false,
        eventTypes: [],
        sensitivity: "all",
        channels: [],
        // digestMode absent → effective 'realtime'
        updatedAt: Date.now(),
      });
    });
    await expect(
      t.mutation(internal.alertRules.setNotificationConfigForUser, {
        userId: USER.subject,
        variant: VARIANT,
        enabled: true,
        // no digestMode/sensitivity in args — but existing pair is forbidden
      }),
    ).rejects.toThrow(/INCOMPATIBLE_DELIVERY|Real-time delivery requires/i);
  });

  test("omitted sensitivity on patch preserves existing value", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("alertRules", {
        userId: USER.subject,
        variant: VARIANT,
        enabled: true,
        eventTypes: [],
        sensitivity: "critical",
        channels: [],
        digestMode: "daily",
        digestHour: 8,
        digestTimezone: "UTC",
        updatedAt: Date.now(),
      });
    });
    await t.mutation(internal.alertRules.setNotificationConfigForUser, {
      userId: USER.subject,
      variant: VARIANT,
      digestHour: 14, // unrelated change
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("alertRules")
        .withIndex("by_user_variant", (q) => q.eq("userId", USER.subject).eq("variant", VARIANT))
        .collect(),
    );
    expect(rows[0]?.sensitivity).toBe("critical");
    expect(rows[0]?.digestHour).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// Temp migration: _listAffectedUserEmails returns recipients for the courtesy
// email. Joins forbidden-state alertRules rows with verified email channels.
// ---------------------------------------------------------------------------

describe("alertRules — _listAffectedUserEmails (TEMP migration helper)", () => {
  const SECRET = "test-secret-list-emails";

  function withSecret(t: ReturnType<typeof convexTest>) {
    process.env.MIGRATION_ADMIN_SECRET = SECRET;
    return t;
  }

  test("rejects without admin secret", async () => {
    const t = withSecret(convexTest(schema, modules));
    await expect(
      t.query(api.alertRules._listAffectedUserEmails, { adminSecret: "wrong" }),
    ).rejects.toThrow(/UNAUTHORIZED/);
  });

  test("returns recipients with verified email; skips users without an email channel", async () => {
    const t = withSecret(convexTest(schema, modules));
    const now = Date.now();
    await t.run(async (ctx) => {
      // User A: forbidden state + verified email → should appear
      await ctx.db.insert("alertRules", {
        userId: "user-a", variant: "full", enabled: true,
        eventTypes: [], sensitivity: "all", channels: [], updatedAt: now,
        // digestMode absent → effective realtime
      });
      await ctx.db.insert("notificationChannels", {
        userId: "user-a", channelType: "email", email: "a@example.com",
        verified: true, linkedAt: now,
      });
      // User B: forbidden state but UNverified email → should be skipped
      await ctx.db.insert("alertRules", {
        userId: "user-b", variant: "full", enabled: true,
        eventTypes: [], sensitivity: "all", channels: [], updatedAt: now,
      });
      await ctx.db.insert("notificationChannels", {
        userId: "user-b", channelType: "email", email: "b@example.com",
        verified: false, linkedAt: now,
      });
      // User C: forbidden state but NO email channel (only telegram) → should be skipped
      await ctx.db.insert("alertRules", {
        userId: "user-c", variant: "full", enabled: false,
        eventTypes: [], sensitivity: "all", channels: [], updatedAt: now,
      });
      await ctx.db.insert("notificationChannels", {
        userId: "user-c", channelType: "telegram", chatId: "12345",
        verified: true, linkedAt: now,
      });
      // User D: NOT in forbidden state (digestMode='daily') → should be skipped
      await ctx.db.insert("alertRules", {
        userId: "user-d", variant: "full", enabled: true,
        eventTypes: [], sensitivity: "all", channels: [],
        digestMode: "daily", digestHour: 8, digestTimezone: "UTC", updatedAt: now,
      });
      await ctx.db.insert("notificationChannels", {
        userId: "user-d", channelType: "email", email: "d@example.com",
        verified: true, linkedAt: now,
      });
    });

    const r = await t.query(api.alertRules._listAffectedUserEmails, { adminSecret: SECRET });
    expect(r.recipients).toHaveLength(1);
    expect(r.recipients[0]).toMatchObject({
      userId: "user-a",
      email: "a@example.com",
      enabled: true,
    });
    // affectedRowCount counts ALL forbidden rows, regardless of email channel
    expect(r.affectedRowCount).toBe(3); // A, B, C (D is daily so not forbidden)
  });

  test("preserves enabled flag in the recipient row (so caller can filter to actively-harassed users)", async () => {
    const t = withSecret(convexTest(schema, modules));
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("alertRules", {
        userId: "user-disabled-forbidden", variant: "full", enabled: false,
        eventTypes: [], sensitivity: "all", channels: [], updatedAt: now,
      });
      await ctx.db.insert("notificationChannels", {
        userId: "user-disabled-forbidden", channelType: "email",
        email: "disabled@example.com", verified: true, linkedAt: now,
      });
    });
    const r = await t.query(api.alertRules._listAffectedUserEmails, { adminSecret: SECRET });
    expect(r.recipients[0]).toMatchObject({ enabled: false, email: "disabled@example.com" });
  });
});
