import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import {
  ALL_ALERT_CHANNELS,
  ALL_ALERT_DIGEST_MODES,
  ALL_ALERT_SENSITIVITIES,
  FREE_ALERT_CHANNELS,
  FREE_ALERT_DIGEST_MODES,
  FREE_ALERT_MAX_COUNTRIES,
  FREE_ALERT_SENSITIVITIES,
  PAID_ALERT_MAX_COUNTRIES,
  firstAlertCapabilityViolation,
  resolveAlertCapabilities,
} from "../../shared/alert-capabilities";

const modules = import.meta.glob("../**/*.ts");

const USER = { subject: "user-tests-free-ladder" };
const VARIANT = "full";

async function seedEntitlement(
  t: ReturnType<typeof convexTest>,
  { tier = 1, planKey = "pro_monthly", validUntil = Date.now() + 30 * 24 * 60 * 60 * 1000 } = {},
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("entitlements", {
      userId: USER.subject,
      planKey,
      features: {
        tier,
        maxDashboards: 10,
        apiAccess: false,
        apiRateLimit: 0,
        prioritySupport: false,
        exportFormats: [],
      },
      validUntil,
      updatedAt: Date.now(),
    });
  });
}

// ---------------------------------------------------------------------------
// Catalog ↔ shared constants pinning. productCatalog.ts stays import-free
// (the product-config generator consumes it), so the ladder's values live
// twice by design; this test is the drift gate the catalog comment names.
// ---------------------------------------------------------------------------

describe("alert ladder — catalog and shared constants agree (#4273)", () => {
  test("free plan features match the shared FREE_* constants", () => {
    const free = PRODUCT_CATALOG.free!.features;
    expect(free.alertMaxCountries).toBe(FREE_ALERT_MAX_COUNTRIES);
    expect(free.alertChannels).toEqual([...FREE_ALERT_CHANNELS]);
    expect(free.alertSensitivities).toEqual([...FREE_ALERT_SENSITIVITIES]);
    expect(free.alertDigestModes).toEqual([...FREE_ALERT_DIGEST_MODES]);
    expect(free.aiDigestAccess).toBe(false);
  });

  test("every paid plan carries the full alert surface", () => {
    for (const [planKey, entry] of Object.entries(PRODUCT_CATALOG)) {
      if (entry.features.tier < 1) continue;
      expect(entry.features.alertMaxCountries, planKey).toBe(PAID_ALERT_MAX_COUNTRIES);
      expect(entry.features.alertChannels, planKey).toEqual([...ALL_ALERT_CHANNELS]);
      expect(entry.features.alertSensitivities, planKey).toEqual([...ALL_ALERT_SENSITIVITIES]);
      expect(entry.features.alertDigestModes, planKey).toEqual([...ALL_ALERT_DIGEST_MODES]);
      expect(entry.features.aiDigestAccess, planKey).toBe(true);
    }
  });

  test("free digest modes stay realtime-only until the digest cron is free-aware", () => {
    // scripts/seed-digest-notifications.mjs still delivers to tier >= 1 only.
    // Widening this array without that cron change would advertise a daily
    // digest free accounts never receive. Update both together.
    expect(FREE_ALERT_DIGEST_MODES).toEqual(["realtime"]);
  });
});

// ---------------------------------------------------------------------------
// resolveAlertCapabilities fallback semantics: BY TIER when a features
// object predates the fields — a stale paid row keeps full access, a free
// row fails closed to the ladder.
// ---------------------------------------------------------------------------

describe("resolveAlertCapabilities — by-tier fallback", () => {
  test("legacy paid features without alert fields keep the full surface", () => {
    const caps = resolveAlertCapabilities({ tier: 1 });
    expect(caps.maxCountries).toBe(PAID_ALERT_MAX_COUNTRIES);
    expect(caps.channels.has("slack")).toBe(true);
    expect(caps.sensitivities.has("all")).toBe(true);
    expect(caps.aiDigestAccess).toBe(true);
  });

  test("free / absent features fail closed to the ladder", () => {
    for (const features of [null, undefined, { tier: 0 }]) {
      const caps = resolveAlertCapabilities(features);
      expect(caps.maxCountries).toBe(FREE_ALERT_MAX_COUNTRIES);
      expect(caps.channels.has("slack")).toBe(false);
      expect(caps.channels.has("web_push")).toBe(true);
      expect(caps.channels.has("email")).toBe(true);
      expect(caps.sensitivities.has("critical")).toBe(true);
      expect(caps.sensitivities.has("high")).toBe(false);
      expect(caps.aiDigestAccess).toBe(false);
    }
  });

  test("violation order names the most specific rung first", () => {
    const caps = resolveAlertCapabilities({ tier: 0 });
    const violation = firstAlertCapabilityViolation(
      { channels: ["slack"], sensitivity: "high", countriesCount: 9 },
      caps,
    );
    expect(violation?.code).toBe("ALERT_CHANNEL_UPGRADE_REQUIRED");
    expect(violation?.value).toBe("slack");
    expect(violation?.upgradeUrl).toContain("/pro");
  });
});

// ---------------------------------------------------------------------------
// setNotificationConfigForUser — the UI's atomic write path, gated
// unconditionally on the caller's ladder.
// ---------------------------------------------------------------------------

describe("setNotificationConfigForUser — free alert ladder (#4273)", () => {
  test.each([
    [
      "4th country",
      { countries: ["UA", "TW", "LB", "IL"] },
      /ALERT_COUNTRIES_UPGRADE_REQUIRED/,
    ],
    [
      "slack channel",
      { channels: ["slack"] as Array<"slack"> },
      /ALERT_CHANNEL_UPGRADE_REQUIRED/,
    ],
    [
      "high sensitivity",
      { sensitivity: "high" as const, digestMode: "daily" as const },
      /ALERT_SENSITIVITY_UPGRADE_REQUIRED/,
    ],
    [
      "daily digest (until the cron is free-aware)",
      { digestMode: "daily" as const },
      /ALERT_DIGEST_MODE_UPGRADE_REQUIRED/,
    ],
    [
      "AI digest opt-in",
      { aiDigestEnabled: true, countries: ["UA"] },
      /AI_DIGEST_UPGRADE_REQUIRED/,
    ],
    [
      "worldwide scope (no countries)",
      { enabled: true, channels: ["web_push"] as Array<"web_push"> },
      /ALERT_COUNTRY_SCOPE_REQUIRED/,
    ],
  ])("free user asking for %s → structured 402 code", async (_name, args, code) => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.alertRules.setNotificationConfigForUser, {
        userId: USER.subject,
        variant: VARIANT,
        ...args,
      }),
    ).rejects.toThrow(code);
  });

  test("free user: full free-shaped insert succeeds at the ladder's edge", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.alertRules.setNotificationConfigForUser, {
      userId: USER.subject,
      variant: VARIANT,
      enabled: true,
      sensitivity: "critical",
      digestMode: "realtime",
      channels: ["web_push", "email"],
      countries: ["UA", "TW", "LB"],
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("alertRules")
        .withIndex("by_user_variant", (q) => q.eq("userId", USER.subject).eq("variant", VARIANT))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.channels).toEqual(["web_push", "email"]);
  });

  test("free user: disabling with no countries is allowed (disable is never gated)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.alertRules.setNotificationConfigForUser, {
      userId: USER.subject,
      variant: VARIANT,
      enabled: false,
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("alertRules")
        .withIndex("by_user_variant", (q) => q.eq("userId", USER.subject).eq("variant", VARIANT))
        .collect(),
    );
    expect(rows[0]?.enabled).toBe(false);
  });

  test("pro user: worldwide scope (no countries) stays allowed", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t);
    await t.mutation(internal.alertRules.setNotificationConfigForUser, {
      userId: USER.subject,
      variant: VARIANT,
      enabled: true,
      sensitivity: "critical",
      channels: ["web_push"],
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("alertRules")
        .withIndex("by_user_variant", (q) => q.eq("userId", USER.subject).eq("variant", VARIANT))
        .collect(),
    );
    expect(rows[0]?.enabled).toBe(true);
  });

  test("downgraded account can still disable a legacy wider-than-plan row", async () => {
    const t = convexTest(schema, modules);
    // A row written while the account was Pro: slack channel, daily+high.
    await t.run(async (ctx) => {
      await ctx.db.insert("alertRules", {
        userId: USER.subject,
        variant: VARIANT,
        enabled: true,
        eventTypes: [],
        sensitivity: "high",
        channels: ["slack"],
        digestMode: "daily",
        updatedAt: Date.now(),
      });
    });
    // No entitlement row any more (downgraded). Disabling touches no gated
    // field, so the untouched stored fields are not re-judged.
    await t.mutation(internal.alertRules.setNotificationConfigForUser, {
      userId: USER.subject,
      variant: VARIANT,
      enabled: false,
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("alertRules")
        .withIndex("by_user_variant", (q) => q.eq("userId", USER.subject).eq("variant", VARIANT))
        .collect(),
    );
    expect(rows[0]?.enabled).toBe(false);
  });

  test("pro user keeps the full surface", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t);
    await t.mutation(internal.alertRules.setNotificationConfigForUser, {
      userId: USER.subject,
      variant: VARIANT,
      enabled: true,
      sensitivity: "high",
      digestMode: "daily",
      channels: ["slack", "web_push"],
      aiDigestEnabled: true,
      countries: ["UA", "TW", "LB", "IL", "PL"],
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("alertRules")
        .withIndex("by_user_variant", (q) => q.eq("userId", USER.subject).eq("variant", VARIANT))
        .collect(),
    );
    expect(rows[0]?.sensitivity).toBe("high");
    expect(rows[0]?.channels).toContain("slack");
  });
});

// ---------------------------------------------------------------------------
// The relay-path *ForUser mutations gate only under enforceEntitlement, so
// operator cleanup stays open (see the INTENTIONAL test in alertRules.test.ts).
// ---------------------------------------------------------------------------

describe("enforceEntitlement flag on the relay-path mutations", () => {
  test("setAlertRulesForUser enforces the ladder only when flagged", async () => {
    const t = convexTest(schema, modules);
    const overLadder = {
      userId: USER.subject,
      variant: VARIANT,
      enabled: true,
      eventTypes: [],
      sensitivity: "critical" as const,
      channels: ["slack" as const],
    };
    // Operator path (no flag): writes even for a free user.
    await t.mutation(internal.alertRules.setAlertRulesForUser, overLadder);
    // User path (flagged): the same payload is denied.
    await expect(
      t.mutation(internal.alertRules.setAlertRulesForUser, { ...overLadder, enforceEntitlement: true }),
    ).rejects.toThrow(/ALERT_CHANNEL_UPGRADE_REQUIRED/);
  });

  test("setDigestSettingsForUser (flagged) denies a free daily digest", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.alertRules.setDigestSettingsForUser, {
        userId: USER.subject,
        variant: VARIANT,
        digestMode: "daily",
        enforceEntitlement: true,
      }),
    ).rejects.toThrow(/ALERT_DIGEST_MODE_UPGRADE_REQUIRED/);
  });

  test("setQuietHoursForUser (flagged) judges only a sent countries update", async () => {
    const t = convexTest(schema, modules);
    // Quiet-hours edit without countries: allowed for a free user.
    await t.mutation(internal.alertRules.setQuietHoursForUser, {
      userId: USER.subject,
      variant: VARIANT,
      quietHoursEnabled: true,
      quietHoursStart: 22,
      quietHoursEnd: 7,
      enforceEntitlement: true,
    });
    // Over-limit countries on the same path: denied.
    await expect(
      t.mutation(internal.alertRules.setQuietHoursForUser, {
        userId: USER.subject,
        variant: VARIANT,
        quietHoursEnabled: true,
        countries: ["UA", "TW", "LB", "IL"],
        enforceEntitlement: true,
      }),
    ).rejects.toThrow(/ALERT_COUNTRIES_UPGRADE_REQUIRED/);
  });
});

// ---------------------------------------------------------------------------
// notificationChannels — channel creation follows the same ladder.
// ---------------------------------------------------------------------------

describe("notificationChannels — free channel set (#4273)", () => {
  test("free user may create a web_push channel", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.notificationChannels.setWebPushChannelForUser, {
      userId: USER.subject,
      endpoint: "https://push.example/ep1",
      p256dh: "k",
      auth: "a",
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("notificationChannels")
        .withIndex("by_user_channel", (q) => q.eq("userId", USER.subject).eq("channelType", "web_push"))
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });

  test("free user creating a slack channel → ALERT_CHANNEL_UPGRADE_REQUIRED", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.notificationChannels.setChannelForUser, {
        userId: USER.subject,
        channelType: "slack",
        webhookEnvelope: "enc",
      }),
    ).rejects.toThrow(/ALERT_CHANNEL_UPGRADE_REQUIRED/);
  });

  test("free user creating an email channel with a verified account email succeeds", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.notificationChannels.setChannelForUser, {
      userId: USER.subject,
      channelType: "email",
      email: "user@example.com",
      verifiedAccountEmail: "user@example.com",
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("notificationChannels")
        .withIndex("by_user_channel", (q) => q.eq("userId", USER.subject).eq("channelType", "email"))
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// OAuth channel creation carries the same layer-2 gate: the start endpoints
// already deny free callers at the edge, but a lapsed entitlement mid-flow
// (or any future caller) must end at the mutation too.
// ---------------------------------------------------------------------------

describe("notificationChannels — OAuth creation paths gate on the ladder (#4273)", () => {
  test("free user: slack OAuth channel creation is denied at the mutation", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.notificationChannels.setSlackOAuthChannelForUser, {
        userId: USER.subject,
        webhookEnvelope: "enc",
      }),
    ).rejects.toThrow(/ALERT_CHANNEL_UPGRADE_REQUIRED/);
  });

  test("free user: discord OAuth channel creation is denied at the mutation", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.notificationChannels.setDiscordOAuthChannelForUser, {
        userId: USER.subject,
        webhookEnvelope: "enc",
      }),
    ).rejects.toThrow(/ALERT_CHANNEL_UPGRADE_REQUIRED/);
  });

  test("pro user: slack OAuth channel creation still succeeds", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t);
    await expect(
      t.mutation(internal.notificationChannels.setSlackOAuthChannelForUser, {
        userId: USER.subject,
        webhookEnvelope: "enc",
      }),
    ).resolves.toEqual({ isNew: true });
  });
});
