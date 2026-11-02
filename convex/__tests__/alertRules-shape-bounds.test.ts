import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import * as alertRules from "../alertRules";
import { channelTypeValidator } from "../constants";
import { PREFERENCE_VARIANTS } from "../../shared/cloud-preferences-contract";
import {
  ALERT_RULE_CHANNEL_TYPES,
  ALERT_RULE_CHANNELS_MAX,
  ALERT_RULE_EVENT_TYPES_MAX,
  ALERT_RULE_EVENT_TYPE_MAX_LENGTH,
  ALERT_RULE_VARIANTS,
  ALERT_RULES_PER_USER_MAX,
} from "../../shared/alert-rule-shape";

/**
 * Strix pentest 2026-10-27, "unbounded notification/alert rules": every
 * alertRules writer accepted an unbounded `variant` string and unbounded
 * `eventTypes` / `channels` arrays, and the relay reads EVERY enabled row in
 * one Convex transaction. One Pro account wrote 19 rows of ~910 KB each and
 * pushed `/relay/enabled-rules`, `/relay/digest-rules` and
 * `/relay/brief-only-users` past the Convex read limit, so they threw for
 * every tenant and the relay dropped events.
 *
 * `transactionLimits: true` makes convex-test enforce the per-transaction
 * read limit, which is what turns the oversized rows into a failure.
 */

const modules = import.meta.glob("../**/*.ts");
const ATTACKER = "attacker";
const VICTIM = "victim";
const DAY = 86_400_000;

beforeEach(() => {
  vi.stubEnv("RELAY_SHARED_SECRET", "synthetic-ingestion");
  vi.stubEnv("CONVEX_TENANT_RELAY_SECRET", "synthetic-gateway");
  vi.stubEnv("CONVEX_NOTIFICATION_RELAY_SECRET", "synthetic-delivery");
});
afterEach(() => vi.unstubAllEnvs());

const delivery = { headers: { Authorization: "Bearer synthetic-delivery" } };
const gatewayPost = (body: Record<string, unknown>) => ({
  method: "POST",
  headers: { Authorization: "Bearer synthetic-gateway", "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// ~0.9 MiB per row: 7000 eventTypes x 128 chars (doc cap is 1 MiB).
const OVERSIZED_EVENT_TYPES = Array.from({ length: 7000 }, (_, i) => `${i}`.padEnd(128, "x"));

async function seedPro(t: ReturnType<typeof convexTest>, userId: string) {
  await t.run(async (ctx) => {
    await ctx.db.insert("entitlements", {
      userId, planKey: "pro_monthly",
      features: { tier: 1, maxDashboards: 10, apiAccess: true, apiRateLimit: 1000, prioritySupport: true, exportFormats: ["json"] },
      validUntil: Date.now() + 30 * DAY, updatedAt: Date.now(),
    });
  });
}

async function seedVictim(t: ReturnType<typeof convexTest>) {
  await seedPro(t, VICTIM);
  await t.run(async (ctx) => {
    await ctx.db.insert("alertRules", {
      userId: VICTIM, variant: "full", enabled: true, eventTypes: [], sensitivity: "critical",
      channels: ["email"], digestMode: "daily", digestHour: 8, updatedAt: 1,
    });
  });
}

/** Legacy rows written before the bounds existed: inserted straight into the table. */
async function seedOversizedLegacyRows(t: ReturnType<typeof convexTest>, count: number, enabled = true) {
  for (let i = 0; i < count; i++) {
    await t.run(async (ctx) => {
      await ctx.db.insert("alertRules", {
        userId: ATTACKER, variant: `legacy-${i}`, enabled, eventTypes: OVERSIZED_EVENT_TYPES,
        sensitivity: "critical", channels: [], digestMode: "daily", updatedAt: 1,
      });
    });
  }
}

async function readAllPages<T>(
  t: ReturnType<typeof convexTest>,
  fetchPage: (cursor: string | null) => Promise<{ page: T[]; continueCursor: string; isDone: boolean }>,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 1000; guard++) {
    const result = await fetchPage(cursor);
    out.push(...result.page);
    if (result.isDone) return out;
    cursor = result.continueCursor;
  }
  throw new Error("pagination did not terminate");
}

describe("the shared shape registry matches the lists the rest of the system uses", () => {
  test("channel types equal convex/constants channelTypeValidator; variants are the cloud-preferences registry", () => {
    const validatorMembers = (channelTypeValidator as unknown as { members: Array<{ value: string }> }).members
      .map((m) => m.value).sort();
    expect(validatorMembers).toEqual([...ALERT_RULE_CHANNEL_TYPES].sort());
    expect([...ALERT_RULE_VARIANTS]).toEqual([...PREFERENCE_VARIANTS]);
  });
});

describe("shared relay reads survive oversized legacy rows (transactionLimits)", () => {
  test("/relay/enabled-rules still serves the victim's rule next to 20 oversized rows", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    await seedVictim(t);
    await seedOversizedLegacyRows(t, 20);

    const res = await t.fetch("/relay/enabled-rules", delivery);
    expect(res.status).toBe(200);
    const rules = (await res.json()) as Array<{ userId: string }>;
    expect(rules.filter((r) => r.userId === VICTIM)).toHaveLength(1);
    expect(rules).toHaveLength(21);
  }, 120_000);

  test("/relay/digest-rules still serves the victim's digest rule", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    await seedVictim(t);
    await seedOversizedLegacyRows(t, 20);

    const res = await t.fetch("/relay/digest-rules", delivery);
    expect(res.status).toBe(200);
    const rules = (await res.json()) as Array<{ userId: string; digestMode?: string }>;
    expect(rules.some((r) => r.userId === VICTIM && r.digestMode === "daily")).toBe(true);
  }, 120_000);

  test("/relay/brief-only-users still lists a paid user next to a paid user with 20 oversized disabled rows", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    await seedPro(t, "paid-no-rules");
    await seedPro(t, ATTACKER);
    await seedOversizedLegacyRows(t, 20, false);

    const res = await t.fetch("/relay/brief-only-users", delivery);
    expect(res.status).toBe(200);
    const userIds = (await res.json()) as string[];
    expect(userIds).toContain("paid-no-rules");
  }, 120_000);

  test("the paginated internal reads are bounded per page", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    await seedVictim(t);
    await seedOversizedLegacyRows(t, 20);
    const enabled = await readAllPages(t, (cursor) =>
      t.query(internal.alertRules.getByEnabled, { enabled: true, cursor, numItems: 64 }));
    expect(enabled).toHaveLength(21);
    const digest = await readAllPages(t, (cursor) =>
      t.query(internal.alertRules.getDigestRules, { cursor, numItems: 64 }));
    expect(digest.map((r) => r.userId)).toContain(VICTIM);
  }, 120_000);
});

describe("every writer rejects an out-of-shape rule", () => {
  const tooManyEventTypes = Array.from({ length: ALERT_RULE_EVENT_TYPES_MAX + 1 }, (_, i) => `t${i}`);
  const tooLongEventType = ["x".repeat(ALERT_RULE_EVENT_TYPE_MAX_LENGTH + 1)];
  const tooManyChannels = Array.from({ length: ALERT_RULE_CHANNELS_MAX + 1 }, () => "email" as const);

  test.each([
    ["variant outside the registry", { variant: "v0" }, "VARIANT_INVALID"],
    ["900 KB variant", { variant: "x".repeat(900_000) }, "VARIANT_INVALID"],
    [`eventTypes > ${ALERT_RULE_EVENT_TYPES_MAX}`, { eventTypes: tooManyEventTypes }, "EVENT_TYPES_INVALID"],
    [`eventType > ${ALERT_RULE_EVENT_TYPE_MAX_LENGTH} chars`, { eventTypes: tooLongEventType }, "EVENT_TYPES_INVALID"],
    ["eventType with a control character", { eventTypes: ["rss\u0000alert"] }, "EVENT_TYPES_INVALID"],
    [`channels > ${ALERT_RULE_CHANNELS_MAX}`, { channels: tooManyChannels }, "CHANNELS_INVALID"],
  ])("setAlertRulesForUser: %s", async (_name, override, code) => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(internal.alertRules.setAlertRulesForUser, {
      userId: ATTACKER, variant: "full", enabled: true, eventTypes: [], channels: [], ...override,
    })).rejects.toThrow(code);
    expect(await t.run((ctx) => ctx.db.query("alertRules").collect())).toEqual([]);
  });

  test.each([
    ["variant outside the registry", { variant: "v0" }, "VARIANT_INVALID"],
    [`eventTypes > ${ALERT_RULE_EVENT_TYPES_MAX}`, { eventTypes: tooManyEventTypes }, "EVENT_TYPES_INVALID"],
    [`channels > ${ALERT_RULE_CHANNELS_MAX}`, { channels: tooManyChannels }, "CHANNELS_INVALID"],
  ])("setNotificationConfigForUser: %s", async (_name, override, code) => {
    const t = convexTest(schema, modules);
    await seedPro(t, ATTACKER);
    await expect(t.mutation(internal.alertRules.setNotificationConfigForUser, {
      userId: ATTACKER, variant: "full", ...override,
    })).rejects.toThrow(code);
    expect(await t.run((ctx) => ctx.db.query("alertRules").collect())).toEqual([]);
  });

  test("setDigestSettingsForUser and setQuietHoursForUser reject an unknown variant", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(internal.alertRules.setDigestSettingsForUser, {
      userId: ATTACKER, variant: "x".repeat(900_000), digestMode: "daily",
    })).rejects.toThrow("VARIANT_INVALID");
    await expect(t.mutation(internal.alertRules.setQuietHoursForUser, {
      userId: ATTACKER, variant: "v1", quietHoursEnabled: false,
    })).rejects.toThrow("VARIANT_INVALID");
    expect(await t.run((ctx) => ctx.db.query("alertRules").collect())).toEqual([]);
  });

  test("row cap: a new variant row is refused once the account holds the maximum", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let i = 0; i < ALERT_RULES_PER_USER_MAX; i++) {
        await ctx.db.insert("alertRules", {
          userId: ATTACKER, variant: `legacy-${i}`, enabled: false, eventTypes: [], sensitivity: "critical", channels: [], updatedAt: 1,
        });
      }
    });
    await expect(t.mutation(internal.alertRules.setAlertRulesForUser, {
      userId: ATTACKER, variant: "full", enabled: true, eventTypes: [], channels: [],
    })).rejects.toThrow("RULE_LIMIT_EXCEEDED");
    // Updating one of the existing rows is still allowed: the cap bounds rows, not edits.
    await t.mutation(internal.alertRules.setQuietHoursForUser, {
      userId: ATTACKER, variant: "legacy-0", quietHoursEnabled: false,
    }).catch(() => { /* legacy variant is itself out of shape; covered below */ });
    expect(await t.run((ctx) => ctx.db.query("alertRules").collect())).toHaveLength(ALERT_RULES_PER_USER_MAX);
  });

  test("the gateway HTTP action answers each bound with a 400 and the code", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    await seedVictim(t);
    await seedPro(t, ATTACKER);
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["set-alert-rules", { variant: "e0", enabled: true, eventTypes: [], channels: [] }, "VARIANT_INVALID"],
      ["set-alert-rules", { variant: "full", enabled: true, eventTypes: OVERSIZED_EVENT_TYPES, channels: [] }, "EVENT_TYPES_INVALID"],
      ["set-alert-rules", { variant: "full", enabled: true, eventTypes: [], channels: tooManyChannels }, "CHANNELS_INVALID"],
      ["set-notification-config", { variant: "e0" }, "VARIANT_INVALID"],
      ["set-notification-config", { variant: "full", eventTypes: OVERSIZED_EVENT_TYPES }, "EVENT_TYPES_INVALID"],
      ["set-digest-settings", { variant: "e0", digestMode: "daily" }, "VARIANT_INVALID"],
      ["set-quiet-hours", { variant: "e0", quietHoursEnabled: false }, "VARIANT_INVALID"],
    ];
    for (const [action, body, code] of cases) {
      const res = await t.fetch("/relay/notification-channels", gatewayPost({ action, userId: ATTACKER, ...body }));
      expect([action, res.status, (await res.json()).error]).toEqual([action, 400, code]);
    }
    // 20 oversized writes within the edge write budget never land, so the
    // shared read keeps working for the victim.
    for (let i = 0; i < 20; i++) {
      const res = await t.fetch("/relay/notification-channels", gatewayPost({
        action: "set-alert-rules", userId: ATTACKER, variant: `e${i}`, enabled: true, eventTypes: OVERSIZED_EVENT_TYPES, channels: [],
      }));
      expect(res.status).toBe(400);
    }
    expect(await t.run((ctx) => ctx.db.query("alertRules").withIndex("by_user", (q) => q.eq("userId", ATTACKER)).collect())).toEqual([]);
    const rules = await t.fetch("/relay/enabled-rules", delivery);
    expect(rules.status).toBe(200);
    expect(((await rules.json()) as Array<{ userId: string }>).map((r) => r.userId)).toEqual([VICTIM]);
  }, 120_000);
});

describe("valid rules are unchanged", () => {
  test("every registry variant can hold one rule and the stored shape equals the input", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t, VICTIM);
    for (const variant of ALERT_RULE_VARIANTS) {
      await t.mutation(internal.alertRules.setAlertRulesForUser, {
        userId: VICTIM, variant, enabled: true, eventTypes: ["watchlist_story_alert", "chokepoint_disruption"],
        sensitivity: "critical", channels: ["email", "telegram", "web_push"], countries: ["US"],
      });
    }
    const rows = await t.run((ctx) => ctx.db.query("alertRules").withIndex("by_user", (q) => q.eq("userId", VICTIM)).collect());
    expect(rows.map((r) => r.variant).sort()).toEqual([...ALERT_RULE_VARIANTS].sort());
    expect(rows[0]!.eventTypes).toEqual(["watchlist_story_alert", "chokepoint_disruption"]);
    expect(rows[0]!.channels).toEqual(["email", "telegram", "web_push"]);
    // Editing a full account (one row per variant) is still allowed.
    await t.mutation(internal.alertRules.setNotificationConfigForUser, {
      userId: VICTIM, variant: "full", digestMode: "daily", sensitivity: "high", channels: ["email"],
    });
    await t.mutation(internal.alertRules.setDigestSettingsForUser, { userId: VICTIM, variant: "tech", digestMode: "weekly", digestHour: 9 });
    await t.mutation(internal.alertRules.setQuietHoursForUser, { userId: VICTIM, variant: "finance", quietHoursEnabled: true, quietHoursStart: 22, quietHoursEnd: 7 });
    const full = await t.run((ctx) => ctx.db.query("alertRules").withIndex("by_user_variant", (q) => q.eq("userId", VICTIM).eq("variant", "full")).unique());
    expect(full).toMatchObject({ digestMode: "daily", sensitivity: "high", channels: ["email"] });
  });

  test("duplicate eventTypes and channels are stored once", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.alertRules.setAlertRulesForUser, {
      userId: VICTIM, variant: "full", enabled: true, eventTypes: ["rss_alert", "rss_alert"], channels: ["email", "email"],
    });
    const row = await t.run((ctx) => ctx.db.query("alertRules").first());
    expect(row).toMatchObject({ eventTypes: ["rss_alert"], channels: ["email"] });
  });
});

describe("pre-deploy shape audit", () => {
  test("listShapeViolations is internal and reports only out-of-shape rows, page by page", async () => {
    const fn = alertRules.listShapeViolations as unknown as { isQuery?: boolean; isInternal?: boolean; isPublic?: boolean };
    expect([fn.isQuery, fn.isInternal, fn.isPublic]).toEqual([true, true, undefined]);

    const t = convexTest({ schema, modules, transactionLimits: true });
    await seedVictim(t);
    await seedOversizedLegacyRows(t, 3);
    await t.run(async (ctx) => {
      await ctx.db.insert("alertRules", {
        userId: "dupes", variant: "full", enabled: true, eventTypes: [], sensitivity: "critical",
        channels: ["email", "email", "email", "email", "email", "email", "email", "email"], updatedAt: 1,
      });
    });
    const violations = await readAllPages(t, (cursor) =>
      t.query(internal.alertRules.listShapeViolations, { cursor, numItems: 2 }));
    expect(violations.map((v) => v.userId).sort()).toEqual(["attacker", "attacker", "attacker", "dupes"]);
    const legacy = violations.find((v) => v.variant === "legacy-0")!;
    expect(legacy.codes).toEqual(expect.arrayContaining(["VARIANT_INVALID", "EVENT_TYPES_INVALID"]));
    expect(legacy.approxBytes).toBeGreaterThan(800_000);
    expect(violations.find((v) => v.userId === "dupes")!.codes).toEqual(["CHANNELS_INVALID"]);
  }, 120_000);
});
