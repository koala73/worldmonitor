import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");

const USER = { subject: "user-tests-alertrules", tokenIdentifier: "clerk|user-tests-alertrules" };
const VARIANT = "full";

/**
 * Seed a PRO entitlement for the test user. Required before invoking any
 * public alertRules mutation (setAlertRules, setDigestSettings, setQuietHours)
 * — those now gate on `assertProEntitlement`. Without this seed, every
 * pre-existing test would fail with PRO_REQUIRED because convex-test starts
 * with an empty `entitlements` table.
 *
 * Call at the start of any test that uses a public mutation OR that
 * exercises setNotificationConfigForUser via the HTTP path.
 */
async function seedProEntitlement(
  t: ReturnType<typeof convexTest>,
  userId = USER.subject,
  validUntil = Date.now() + 30 * 24 * 60 * 60 * 1000,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("entitlements", {
      userId,
      planKey: "pro_monthly",
      features: {
        tier: 1,
        maxDashboards: 10,
        apiAccess: true,
        apiRateLimit: 1000,
        prioritySupport: true,
        exportFormats: ["json", "csv"],
      },
      validUntil,
      updatedAt: Date.now(),
    });
  });
}

// ---------------------------------------------------------------------------
// Cross-field invariant: realtime is for `critical`-tier events only.
// Both `(realtime, all)` and `(realtime, high)` are forbidden.
// See plans/forbid-realtime-all-events.md.
// ---------------------------------------------------------------------------

describe("alertRules — realtime+non-critical cross-field invariant", () => {
  test("setAlertRules({sensitivity:'all'}) against existing realtime row → throws", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t);
    const asUser = t.withIdentity(USER);
    // Seed an existing row in realtime mode with critical sensitivity (compatible
    // under the tightened rule — only 'critical' is allowed alongside realtime).
    await asUser.mutation(api.alertRules.setAlertRules, {
      variant: VARIANT,
      enabled: true,
      eventTypes: [],
      sensitivity: "critical",
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
    ).rejects.toThrow(/INCOMPATIBLE_DELIVERY|Real-time delivery is for Critical/i);
  });

  test("setAlertRules({sensitivity:'high'}) against existing realtime row → throws (tightened rule)", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t);
    const asUser = t.withIdentity(USER);
    // Seed compatible realtime+critical state.
    await asUser.mutation(api.alertRules.setAlertRules, {
      variant: VARIANT,
      enabled: true,
      eventTypes: [],
      sensitivity: "critical",
      channels: [],
    });
    // Attempting to widen to 'high' is now ALSO forbidden — was allowed under
    // the previous rule, tightened 2026-04-27.
    await expect(
      asUser.mutation(api.alertRules.setAlertRules, {
        variant: VARIANT,
        enabled: true,
        eventTypes: [],
        sensitivity: "high",
        channels: [],
      }),
    ).rejects.toThrow(/INCOMPATIBLE_DELIVERY|Real-time delivery is for Critical/i);
  });

  test("setAlertRules({sensitivity:'all'}) against existing daily-digest row → succeeds", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t);
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
    await seedProEntitlement(t);
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
    ).rejects.toThrow(/INCOMPATIBLE_DELIVERY|Real-time delivery is for Critical/i);
  });

  test("setDigestSettings({digestMode:'daily'}) against existing sensitivity:'all' realtime → succeeds, sensitivity preserved", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t);
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
// Insert-only default: sensitivity:'critical' on fresh insert ONLY (under the
// tightened rule, was 'high' before 2026-04-27). Patch path must NEVER silently
// rewrite an existing row's
// sensitivity when the caller omits the field.
// ---------------------------------------------------------------------------

describe("alertRules — insert-only default for sensitivity", () => {
  test("setAlertRulesForUser with no existing row, sensitivity omitted → defaults to 'critical'", async () => {
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
    // Under the tightened rule (2026-04-27), realtime insert default is 'critical'
    // not 'high' — only 'critical' is compatible with the implicit realtime mode.
    expect(rows[0]?.sensitivity).toBe("critical");
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

  test("setQuietHoursForUser with no existing row → inserts with sensitivity:'critical', not 'all'/'high'", async () => {
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
    expect(rows[0]?.sensitivity).toBe("critical");
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
    await seedProEntitlement(t);
    await expect(
      t.mutation(internal.alertRules.setNotificationConfigForUser, {
        userId: USER.subject,
        variant: VARIANT,
        digestMode: "realtime",
        sensitivity: "all",
      }),
    ).rejects.toThrow(/INCOMPATIBLE_DELIVERY|Real-time delivery is for Critical/i);
  });

  test("daily+all → realtime+critical lands atomically (no race) — tightened rule requires critical", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t);
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
      sensitivity: "critical",
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("alertRules")
        .withIndex("by_user_variant", (q) => q.eq("userId", USER.subject).eq("variant", VARIANT))
        .collect(),
    );
    expect(rows[0]?.digestMode).toBe("realtime");
    expect(rows[0]?.sensitivity).toBe("critical");
  });

  test("setNotificationConfigForUser({digestMode:'realtime', sensitivity:'high'}) → throws (tightened rule)", async () => {
    // The tightened rule (2026-04-27) forbids realtime+high alongside realtime+all.
    const t = convexTest(schema, modules);
    await seedProEntitlement(t);
    await expect(
      t.mutation(internal.alertRules.setNotificationConfigForUser, {
        userId: USER.subject,
        variant: VARIANT,
        digestMode: "realtime",
        sensitivity: "high",
      }),
    ).rejects.toThrow(/INCOMPATIBLE_DELIVERY|Real-time delivery is for Critical/i);
  });

  test("partial update {enabled:true} against existing forbidden row → throws (re-validation)", async () => {
    // Existing row in forbidden state (e.g. pre-migration). Partial update that
    // doesn't touch the pair must still reject because the pair derived from
    // existing+incoming is still forbidden.
    const t = convexTest(schema, modules);
    await seedProEntitlement(t);
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
    ).rejects.toThrow(/INCOMPATIBLE_DELIVERY|Real-time delivery is for Critical/i);
  });

  test("free user (no entitlement) calling setNotificationConfigForUser → throws PRO_REQUIRED", async () => {
    // Layer-2 gate: setNotificationConfigForUser is reachable from the public
    // `/set-notification-config` HTTP action; a free-tier user hitting that
    // endpoint must be rejected at the mutation, not just by the relay.
    //
    // Note on identity context: unlike the public `setAlertRules` /
    // `setDigestSettings` mutations (which derive `userId` from `ctx.auth`),
    // `setNotificationConfigForUser` takes `userId` as an arg — the HTTP
    // action sets it from the verified Clerk JWT. The entitlement check
    // reads the arg-supplied userId, so a `t.withIdentity(...)` wrapper is
    // intentionally absent from these tests.
    const t = convexTest(schema, modules);
    // Deliberately NO seedProEntitlement — the user is free.
    await expect(
      t.mutation(internal.alertRules.setNotificationConfigForUser, {
        userId: USER.subject,
        variant: VARIANT,
        digestMode: "daily",
        sensitivity: "high",
      }),
    ).rejects.toThrow(/PRO_REQUIRED|Notifications are a PRO feature/i);
  });

  test("expired entitlement (validUntil < now) → throws PRO_REQUIRED", async () => {
    // Mirrors entitlements.ts FREE_TIER_DEFAULTS fallback: an expired
    // entitlement is treated identically to no entitlement. The mutation gate
    // must apply the same semantics.
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, USER.subject, Date.now() - 1000); // expired 1s ago
    await expect(
      t.mutation(internal.alertRules.setNotificationConfigForUser, {
        userId: USER.subject,
        variant: VARIANT,
        digestMode: "daily",
        sensitivity: "high",
      }),
    ).rejects.toThrow(/PRO_REQUIRED|Notifications are a PRO feature/i);
  });

  test("omitted sensitivity on patch preserves existing value", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t);
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
// Layer-2 entitlement gate: public mutations reject free-tier callers.
// (Discovered 2026-04-28: 7 of 28 enabled alertRules rows belonged to
// free-tier users despite the UI paywall — the relay's PRO filter has been
// silently masking the bug at delivery time. This gate is the primary
// defense at write time.)
// ---------------------------------------------------------------------------

describe("alertRules — layer-2 entitlement gate (PRO_REQUIRED)", () => {
  test("setAlertRules from a free-tier user → throws PRO_REQUIRED", async () => {
    const t = convexTest(schema, modules);
    // No seedProEntitlement — the user has no entitlement row, treated as free.
    const asFreeUser = t.withIdentity(USER);
    await expect(
      asFreeUser.mutation(api.alertRules.setAlertRules, {
        variant: VARIANT,
        enabled: true,
        eventTypes: [],
        sensitivity: "critical",
        channels: [],
      }),
    ).rejects.toThrow(/PRO_REQUIRED|Notifications are a PRO feature/i);
  });

  test("setDigestSettings from a free-tier user → throws PRO_REQUIRED", async () => {
    const t = convexTest(schema, modules);
    const asFreeUser = t.withIdentity(USER);
    await expect(
      asFreeUser.mutation(api.alertRules.setDigestSettings, {
        variant: VARIANT,
        digestMode: "daily",
        digestHour: 8,
        digestTimezone: "UTC",
      }),
    ).rejects.toThrow(/PRO_REQUIRED|Notifications are a PRO feature/i);
  });

  test("setQuietHours from a free-tier user → throws PRO_REQUIRED", async () => {
    const t = convexTest(schema, modules);
    const asFreeUser = t.withIdentity(USER);
    await expect(
      asFreeUser.mutation(api.alertRules.setQuietHours, {
        variant: VARIANT,
        quietHoursEnabled: true,
        quietHoursStart: 22,
        quietHoursEnd: 7,
        quietHoursTimezone: "UTC",
      }),
    ).rejects.toThrow(/PRO_REQUIRED|Notifications are a PRO feature/i);
  });

  test("setAlertRules with expired entitlement → throws PRO_REQUIRED", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, USER.subject, Date.now() - 1000); // expired
    const asUser = t.withIdentity(USER);
    await expect(
      asUser.mutation(api.alertRules.setAlertRules, {
        variant: VARIANT,
        enabled: true,
        eventTypes: [],
        sensitivity: "critical",
        channels: [],
      }),
    ).rejects.toThrow(/PRO_REQUIRED|Notifications are a PRO feature/i);
  });

  test("setAlertRules with PRO entitlement → succeeds (control)", async () => {
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
    const rows = await asUser.query(api.alertRules.getAlertRules, {});
    expect(rows).toHaveLength(1);
  });

  test("INTENTIONAL: setAlertRulesForUser internal mutation stays UNGATED for operator/migration paths", async () => {
    // The *ForUser internal mutations are reachable only via `npx convex run`
    // (deploy-key auth) or trusted server-side code paths. They are intentionally
    // NOT entitlement-gated so operator cleanup scripts (e.g. disabling
    // notifications for free users that got rows in via a UI-gate hole) can
    // still run. The HTTP-reachable setNotificationConfigForUser IS gated;
    // see its dedicated tests above.
    const t = convexTest(schema, modules);
    // No seedProEntitlement — free user.
    await t.mutation(internal.alertRules.setAlertRulesForUser, {
      userId: USER.subject,
      variant: VARIANT,
      enabled: false,
      eventTypes: [],
      sensitivity: "critical",
      channels: [],
    });
    // No throw expected — operator cleanup write succeeded against a free user.
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("alertRules")
        .withIndex("by_user_variant", (q) => q.eq("userId", USER.subject).eq("variant", VARIANT))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.enabled).toBe(false);
  });
});
