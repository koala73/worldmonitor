/**
 * alertRules.tickers — watchlist ticker-scope persistence + normalization
 * tests (#4922 item e / U3). Server-side mirror of the U12 `countries`
 * field (see alertRules-countries.test.ts, the behavioural model).
 *
 * Covers:
 *  - normalize-on-write: trim, uppercase, regex filter, dedupe
 *  - shape: `^[A-Z][A-Z0-9&-]{0,11}(\.[A-Z]{1,3})?$` — plain symbols
 *    (AAPL), share-class/conglomerate forms (BRK-B, M&M.NS) and
 *    dot-suffixed listings incl. long NSE bases (RELIANCE.NS,
 *    BHARTIARTL.NS) pass; cashtag junk ($AAPL), carets (^GSPC),
 *    futures (GC=F) are silently dropped
 *  - cap at TICKERS_MAX (50) — throws on overflow
 *  - backward compat: omitted on insert → field absent on row
 *  - preserve-on-omit: caller omits `tickers` → existing value retained
 *  - explicit reset: caller passes [] → row stores []
 *  - internal mutations (setAlertRulesForUser, setNotificationConfigForUser)
 *    forward + normalize tickers — these are the API/http passthrough targets
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");

const USER = { subject: "user-tests-tickers", tokenIdentifier: "clerk|user-tests-tickers" };
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

describe("alertRules.tickers — persistence + normalization", () => {
  test("plain symbol list is stored as-is", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t);
    const asUser = t.withIdentity(USER);
    await asUser.mutation(api.alertRules.setAlertRules, {
      variant: VARIANT,
      enabled: true,
      eventTypes: ["watchlist_story_alert"],
      sensitivity: "critical",
      channels: [],
      tickers: ["AAPL", "MSFT"],
    });
    const row = await readRow(t);
    expect(row?.tickers).toEqual(["AAPL", "MSFT"]);
  });

  test("normalizes case + whitespace + dedupe (first-seen order)", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t);
    const asUser = t.withIdentity(USER);
    await asUser.mutation(api.alertRules.setAlertRules, {
      variant: VARIANT,
      enabled: true,
      eventTypes: [],
      sensitivity: "critical",
      channels: [],
      tickers: ["aapl", "MSFT", "AAPL", "  nvda  "],
    });
    const row = await readRow(t);
    expect(row?.tickers).toEqual(["AAPL", "MSFT", "NVDA"]);
  });

  test("drops malformed shapes, keeps every extractor-emittable symbol shape", async () => {
    // Watchlist entries can carry index/futures notation the ticker
    // extractor never emits — those are silently dropped at the schema
    // layer rather than rejected (the relay's intersection just won't
    // match them). Every NON-INDEX shared/stocks.json shape must survive:
    // the extractor emits exactly those for company-name hits, so a shape
    // dropped here is a ticker that can never alert (#4922 U3 review fix —
    // the earlier {1,6}-base regex silently dropped RELIANCE.NS, BRK-B,
    // M&M.NS and 8 more dictionary symbols).
    const t = convexTest(schema, modules);
    await seedProEntitlement(t);
    const asUser = t.withIdentity(USER);
    await asUser.mutation(api.alertRules.setAlertRules, {
      variant: VARIANT,
      enabled: true,
      eventTypes: [],
      sensitivity: "critical",
      channels: [],
      tickers: [
        "^GSPC", "GC=F", "$AAPL", "", "WAYTOOLONGSYMBOL", "two words",
        "brk-b", "m&m.ns", "reliance.ns", "BHARTIARTL.NS", "infy.ns", "V",
      ],
    });
    const row = await readRow(t);
    expect(row?.tickers).toEqual([
      "BRK-B", "M&M.NS", "RELIANCE.NS", "BHARTIARTL.NS", "INFY.NS", "V",
    ]);
  });

  test("caps at 50 entries — throws TICKERS_LIMIT_EXCEEDED on 51", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t);
    const asUser = t.withIdentity(USER);
    const symbols: string[] = [];
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    outer: for (let i = 0; i < letters.length; i++) {
      for (let j = 0; j < letters.length; j++) {
        symbols.push(`${letters[i]}${letters[j]}X`);
        if (symbols.length >= 51) break outer;
      }
    }
    await expect(
      asUser.mutation(api.alertRules.setAlertRules, {
        variant: VARIANT,
        enabled: true,
        eventTypes: [],
        sensitivity: "critical",
        channels: [],
        tickers: symbols,
      }),
    ).rejects.toThrow(/TICKERS_LIMIT_EXCEEDED|capped at 50/);
  });

  test("backward compat: insert without tickers field → field absent on row", async () => {
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
    expect(row?.tickers).toBeUndefined();
  });

  test("preserve-on-omit: existing tickers:['AAPL'] + caller omits → row still has ['AAPL']", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t);
    const asUser = t.withIdentity(USER);
    await asUser.mutation(api.alertRules.setAlertRules, {
      variant: VARIANT,
      enabled: true,
      eventTypes: ["watchlist_story_alert"],
      sensitivity: "critical",
      channels: [],
      tickers: ["AAPL"],
    });
    // Second write omits tickers (e.g. user toggled 'enabled' on the form).
    await asUser.mutation(api.alertRules.setAlertRules, {
      variant: VARIANT,
      enabled: false,
      eventTypes: ["watchlist_story_alert"],
      sensitivity: "critical",
      channels: [],
    });
    const row = await readRow(t);
    expect(row?.tickers).toEqual(["AAPL"]);
    expect(row?.enabled).toBe(false);
  });

  test("explicit reset: existing tickers:['AAPL'] + caller passes [] → row stores []", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t);
    const asUser = t.withIdentity(USER);
    await asUser.mutation(api.alertRules.setAlertRules, {
      variant: VARIANT,
      enabled: true,
      eventTypes: [],
      sensitivity: "critical",
      channels: [],
      tickers: ["AAPL"],
    });
    await asUser.mutation(api.alertRules.setAlertRules, {
      variant: VARIANT,
      enabled: true,
      eventTypes: [],
      sensitivity: "critical",
      channels: [],
      tickers: [],
    });
    const row = await readRow(t);
    expect(row?.tickers).toEqual([]);
  });

  test("setAlertRulesForUser (internal, /notification-channels set-alert-rules path) forwards + normalizes tickers", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.alertRules.setAlertRulesForUser, {
      userId: USER.subject,
      variant: VARIANT,
      enabled: true,
      eventTypes: ["watchlist_story_alert"],
      sensitivity: "critical",
      channels: [],
      tickers: ["nvda", " AAPL", "NVDA"],
    });
    const row = await readRow(t);
    expect(row?.tickers).toEqual(["NVDA", "AAPL"]);
  });

  test("setNotificationConfigForUser also forwards + normalizes tickers", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t);
    await t.mutation(internal.alertRules.setNotificationConfigForUser, {
      userId: USER.subject,
      variant: VARIANT,
      enabled: true,
      eventTypes: ["watchlist_story_alert"],
      sensitivity: "critical",
      channels: [],
      tickers: ["tsla", "  amd", "TSLA"],
    });
    const row = await readRow(t);
    expect(row?.tickers).toEqual(["TSLA", "AMD"]);
  });
});
