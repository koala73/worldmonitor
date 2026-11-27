/**
 * The Black Friday audience scan at production size.
 *
 * In production the scan read every table one indexed lookup at a time:
 * about seven sequential reads per account, three per registration. At about
 * 50k accounts and 48k registrations the action ran for 15 minutes and the
 * CLI call failed, and the wave pick, which runs the same scan, could not
 * start. convex-test is in memory, so time proves nothing here: these tests
 * count index ranges (each `db.query` or `db.get`), which is what the
 * production runtime was waiting on, and run with Convex's transaction
 * limits enforced.
 */
import { convexTest } from "convex-test";
import { HeadroomTracker } from "convex-test/dist/headroom.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { getFeaturesForPlan } from "../lib/entitlements";
import { segmentKey, versionFor, type AccountGroup } from "../broadcast/_blackFridayAudience";
import { Reservoir, scanAudience } from "../broadcast/blackFriday";
import { BLACK_FRIDAY_LOCALES } from "../broadcast/blackFridayEmailContent";

const modules = import.meta.glob("../**/*.ts");

const DAY = 24 * 60 * 60 * 1000;
const OFFER_START = Date.UTC(2026, 10, 26);
const NOW = Date.UTC(2026, 10, 28, 12, 0, 0);

const newTest = () => convexTest({ schema, modules, transactionLimits: true });
type T = ReturnType<typeof newTest>;

/** Count index ranges per transaction while `fn` runs. */
async function countIndexRanges(fn: () => Promise<unknown>): Promise<{ total: number; maxPerTransaction: number }> {
  const perTracker = new Map<object, number>();
  const original = HeadroomTracker.prototype.trackIndexRange;
  const spy = vi.spyOn(HeadroomTracker.prototype, "trackIndexRange").mockImplementation(function (this: object) {
    perTracker.set(this, (perTracker.get(this) ?? 0) + 1);
    return original.call(this);
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  const counts = [...perTracker.values()];
  return { total: counts.reduce((a, b) => a + b, 0), maxPerTransaction: Math.max(0, ...counts) };
}

async function seedFreeUsers(t: T, n: number): Promise<void> {
  await t.run(async (ctx) => {
    for (let i = 0; i < n; i++) {
      const email = `free-${i}@example.com`;
      await ctx.db.insert("users", {
        userId: `free-${i}`,
        email,
        normalizedEmail: email,
        localePrimary: "en",
        firstSeenAt: NOW - 90 * DAY,
        lastSeenAt: NOW - DAY,
      });
    }
  });
}

async function seedWaitlist(t: T, n: number): Promise<void> {
  await t.run(async (ctx) => {
    for (let i = 0; i < n; i++) {
      const email = `wait-${i}@example.com`;
      await ctx.db.insert("registrations", { email, normalizedEmail: email, registeredAt: NOW - 200 * DAY });
    }
  });
}

const scanCtx = (t: T) => ({
  runQuery: (ref: any, args: any) => t.query(ref, args), // eslint-disable-line @typescript-eslint/no-explicit-any
});

describe("Black Friday audience scan cost", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("reads about one index range per scanned row, and no query comes near Convex's 4,096", async () => {
    const t = newTest();
    // Over a page of each table and several lookup chunks per page.
    const ROWS = 1_100;
    await seedFreeUsers(t, ROWS);
    await seedWaitlist(t, ROWS);
    // Every 7th registration is an account holder's address, and every other
    // one of those carries the launch stamp, so the batched lookups must hand
    // each answer back to its own row across chunk and page boundaries.
    let hasAccount = 0;
    let stampedViaRegistration = 0;
    await t.run(async (ctx) => {
      const registrations = await ctx.db.query("registrations").collect();
      for (const [i, registration] of registrations.entries()) {
        if (i % 7 !== 0) continue;
        hasAccount++;
        const email = `free-${i}@example.com`;
        const stamp = i % 2 === 0 ? { blackFridayLaunchWave: "bf-new-buyer-en-waitlist-1" } : {};
        if (i % 2 === 0) stampedViaRegistration++;
        await ctx.db.patch(registration._id, { email, normalizedEmail: email, ...stamp });
      }
    });

    let report: Awaited<ReturnType<typeof scanAudience>> | undefined;
    const ranges = await countIndexRanges(async () => {
      report = await t.action(internal.broadcast.blackFriday.blackFridayAudience, { send: "launch" });
    });

    expect(report!.scanned).toEqual({ users: ROWS, registrations: ROWS });
    expect(hasAccount).toBe(158);
    expect(report!.groups.free).toEqual({ eligible: ROWS, alreadySent: stampedViaRegistration, toSend: ROWS - stampedViaRegistration });
    expect(report!.groups.waitlist).toEqual({ eligible: ROWS - hasAccount, alreadySent: 0, toSend: ROWS - hasAccount });
    expect(report!.excluded.waitlist).toEqual({ "has-account": hasAccount });
    // One lookup per eligible account (the registration stamp) and one per
    // registration (has it an account), plus pages and the small tables.
    // The per-row version read about 7 per account and 3 per registration.
    expect(ranges.total).toBeLessThanOrEqual(2 * ROWS * 1.05 + 100);
    expect(ranges.maxPerTransaction).toBeLessThanOrEqual(300);
  }, 60_000);

  test("the export re-check stays inside Convex's limits for a full batch of the worst-case accounts", async () => {
    const t = newTest();
    const BATCH = 250;
    // Every lookup the account rules make returns a row: subscription history,
    // an expired entitlement, a removed enterprise seat, and a registration.
    const emails: string[] = [];
    await t.run(async (ctx) => {
      const accountId = await ctx.db.insert("enterpriseAccounts", {
        name: "Acme", contractStart: NOW - DAY, contractEnd: NOW + 300 * DAY, dailyRequestAllowance: 1,
        perMinuteBurst: 1, monthlyInputTokens: 1, monthlyOutputTokens: 1, overagePerThousandRequestsUsd: 0,
        overagePerMillionInputTokensUsd: 0, overagePerMillionOutputTokensUsd: 0, breakerMultiple: 1, seatCap: 5000,
        allowedProviders: [], createdAt: NOW, updatedAt: NOW,
      });
      for (let i = 0; i < BATCH; i++) {
        const userId = `lapsed-${i}`;
        const email = `${userId}@example.com`;
        emails.push(email);
        await ctx.db.insert("users", { userId, email, normalizedEmail: email, localePrimary: "en", firstSeenAt: NOW - 90 * DAY, lastSeenAt: NOW - DAY });
        await ctx.db.insert("subscriptions", {
          userId, dodoSubscriptionId: `sub_${i}`, dodoProductId: "pdt_pro_monthly", planKey: "pro_monthly",
          status: "cancelled", currentPeriodStart: NOW - 70 * DAY, currentPeriodEnd: NOW - 40 * DAY, rawPayload: {}, updatedAt: NOW,
        });
        await ctx.db.insert("entitlements", { userId, planKey: "pro_monthly", features: getFeaturesForPlan("pro_monthly"), validUntil: NOW - 40 * DAY, updatedAt: NOW });
        await ctx.db.insert("enterpriseMembers", { accountId, userId, email, status: "removed", role: "member", updatedAt: NOW });
        await ctx.db.insert("registrations", { email, normalizedEmail: email, registeredAt: NOW - 200 * DAY });
      }
    });
    let dropped: string[] = [];
    const ranges = await countIndexRanges(async () => {
      dropped = await t.query(internal.broadcast.blackFriday._ineligibleNow, {
        send: "launch", version: "lapsed", locale: "en", recipient: "account", emails,
      });
    });
    expect(dropped).toEqual([]);
    // users lookup + 6 account reads + the registration stamp = 8 per email.
    expect(ranges.maxPerTransaction).toBeLessThanOrEqual(8 * BATCH);
    expect(ranges.maxPerTransaction).toBeLessThan(4_096 / 2);
  }, 60_000);
});

describe("Black Friday audience scan equivalence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Accounts and registrations that hit every rule, including the traps of a table-at-once scan. */
  async function seedTraps(t: T): Promise<{ accounts: string[]; waitlist: string[] }> {
    const accounts: string[] = [];
    const waitlist: string[] = [];
    await t.run(async (ctx) => {
      const user = async (userId: string, email: string | undefined, extra: Record<string, unknown> = {}) => {
        await ctx.db.insert("users", {
          userId, email, normalizedEmail: email, localePrimary: "en", firstSeenAt: NOW - 90 * DAY, lastSeenAt: NOW - DAY, ...extra,
        });
        if (email) accounts.push(email);
      };
      const sub = async (userId: string, planKey: string, extra: Record<string, unknown> = {}) => {
        await ctx.db.insert("subscriptions", {
          userId, dodoSubscriptionId: `sub_${userId}_${planKey}_${Math.random()}`, dodoProductId: `pdt_${planKey}`, planKey,
          status: "active", currentPeriodStart: NOW - 10 * DAY, currentPeriodEnd: NOW + 20 * DAY, rawPayload: {}, updatedAt: NOW, ...extra,
        } as never);
      };
      const reg = async (email: string, extra: Record<string, unknown> = {}) => {
        await ctx.db.insert("registrations", { email, normalizedEmail: email, registeredAt: NOW - 200 * DAY, ...extra });
        waitlist.push(email);
      };
      const enterprise = await ctx.db.insert("enterpriseAccounts", {
        name: "Acme", contractStart: NOW - DAY, contractEnd: NOW + 300 * DAY, dailyRequestAllowance: 1,
        perMinuteBurst: 1, monthlyInputTokens: 1, monthlyOutputTokens: 1, overagePerThousandRequestsUsd: 0,
        overagePerMillionInputTokensUsd: 0, overagePerMillionOutputTokensUsd: 0, breakerMultiple: 1, seatCap: 50,
        allowedProviders: [], createdAt: NOW, updatedAt: NOW,
      });

      await user("free", "free@example.com");
      await user("free-fr", "free-fr@example.com", { localePrimary: "fr" });
      await user("no-email", undefined);
      // Suppressed and not an address: the suppression is reported, as before.
      await user("suppressed-no-at", "not-an-address");
      await ctx.db.insert("emailSuppressions", { normalizedEmail: "not-an-address", reason: "manual", suppressedAt: NOW });
      await user("suppressed", "suppressed@example.com");
      await ctx.db.insert("emailSuppressions", { normalizedEmail: "suppressed@example.com", reason: "unsubscribe", suppressedAt: NOW });
      await user("deleting", "deleting@example.com");
      await ctx.db.insert("accountDeletions", { userId: "deleting", userIdHash: "h", source: "self", status: "pending", step: "follows", startedAt: NOW, updatedAt: NOW } as never);
      // An enterprise seat by email only, one by user id only, and a removed one.
      await user("member-email", "member-email@example.com");
      await ctx.db.insert("enterpriseMembers", { accountId: enterprise, email: "member-email@example.com", status: "active", role: "member", updatedAt: NOW });
      await user("member-user", "member-user@example.com");
      await ctx.db.insert("enterpriseMembers", { accountId: enterprise, userId: "member-user", status: "active", role: "member", updatedAt: NOW });
      await user("member-removed", "member-removed@example.com");
      await ctx.db.insert("enterpriseMembers", { accountId: enterprise, userId: "member-removed", email: "member-removed@example.com", status: "removed", role: "member", updatedAt: NOW });
      // A different case in the seat's email is a different index key.
      await user("member-case", "member-case@example.com");
      await ctx.db.insert("enterpriseMembers", { accountId: enterprise, email: "Member-Case@example.com", status: "active", role: "member", updatedAt: NOW });
      await user("monthly", "monthly@example.com");
      await sub("monthly", "pro_monthly");
      await user("monthly-cancelling", "monthly-cancelling@example.com");
      await sub("monthly-cancelling", "pro_monthly", { cancelScheduledAt: NOW - DAY });
      await user("on-hold", "on-hold@example.com");
      await sub("on-hold", "pro_monthly", { status: "on_hold" });
      await user("lapsed-two", "lapsed-two@example.com");
      await sub("lapsed-two", "pro_monthly", { status: "cancelled", currentPeriodEnd: NOW - 40 * DAY });
      await sub("lapsed-two", "api_starter", { status: "expired", currentPeriodEnd: NOW - 20 * DAY });
      await user("yearly", "yearly@example.com");
      await sub("yearly", "pro_annual", { currentPeriodStart: OFFER_START - 100 * DAY });
      await user("converted", "converted@example.com");
      await sub("converted", "pro_annual", { currentPeriodStart: OFFER_START + DAY, status: "cancelled", currentPeriodEnd: NOW - DAY });
      // Two entitlements: the first one written is the one that counts.
      await user("two-entitlements", "two-entitlements@example.com");
      await ctx.db.insert("entitlements", { userId: "two-entitlements", planKey: "pro_monthly", features: getFeaturesForPlan("pro_monthly"), validUntil: NOW + 10 * DAY, updatedAt: NOW });
      await ctx.db.insert("entitlements", { userId: "two-entitlements", planKey: "free", features: getFeaturesForPlan("free"), validUntil: 0, updatedAt: NOW });
      await user("expired-entitlement", "expired-entitlement@example.com");
      await ctx.db.insert("entitlements", { userId: "expired-entitlement", planKey: "pro_monthly", features: getFeaturesForPlan("pro_monthly"), validUntil: NOW - DAY, updatedAt: NOW });
      // Stamped on the account, and stamped only on the registration.
      await user("stamped", "stamped@example.com", { blackFridayLaunchWave: "bf-new-buyer-en-account-1" });
      await user("reg-stamped", "reg-stamped@example.com");
      await ctx.db.insert("registrations", { email: "reg-stamped@example.com", normalizedEmail: "reg-stamped@example.com", registeredAt: NOW, blackFridayLaunchWave: "bf-new-buyer-en-waitlist-1" });
      waitlist.push("reg-stamped@example.com");
      // Two accounts on one address: the first one scanned counts.
      await user("dup-1", "dup@example.com");
      await user("dup-2", "dup@example.com", { localePrimary: "de" });

      await reg("wait@example.com");
      await reg("wait-zh@qq.com");
      await reg("wait-stamped@example.com", { blackFridayLaunchWave: "bf-new-buyer-en-waitlist-1" });
      await reg("wait-suppressed@example.com");
      await ctx.db.insert("emailSuppressions", { normalizedEmail: "wait-suppressed@example.com", reason: "bounce", suppressedAt: NOW });
      await reg("free@example.com");
      await reg("wait-customer@example.com");
      await ctx.db.insert("customers", { userId: "gone", email: "wait-customer@example.com", normalizedEmail: "wait-customer@example.com", createdAt: NOW, updatedAt: NOW });
      await reg("wait-legacy@example.com");
      await ctx.db.insert("customers", { userId: "gone-2", email: " Wait-Legacy@example.com ", createdAt: NOW, updatedAt: NOW });
      // An empty normalizedEmail is not a legacy row: its `email` does not count.
      await reg("wait-empty-norm@example.com");
      await ctx.db.insert("customers", { userId: "gone-3", email: "wait-empty-norm@example.com", normalizedEmail: "", createdAt: NOW, updatedAt: NOW });
      await reg("wait-dup@example.com");
      await reg("wait-dup@example.com");
    });
    return { accounts: [...new Set(accounts)], waitlist: [...new Set(waitlist)] };
  }

  test("every segment the scan picks is exactly what the export re-check keeps", async () => {
    const t = newTest();
    const emails = await seedTraps(t);
    const groups: Array<AccountGroup | "waitlist"> = ["free", "lapsed", "monthly", "waitlist"];
    let checked = 0;
    for (const group of groups) {
      const recipient = group === "waitlist" ? "waitlist" : "account";
      const version = versionFor("launch", group);
      for (const locale of BLACK_FRIDAY_LOCALES) {
        const key = segmentKey(version, locale, recipient);
        const reservoir = new Reservoir<string>(Number.MAX_SAFE_INTEGER);
        await scanAudience(scanCtx(t), "launch", { accounts: recipient === "account", waitlist: recipient === "waitlist" }, { key, reservoir });
        const candidates = recipient === "account" ? emails.accounts : emails.waitlist;
        const dropped = await t.query(internal.broadcast.blackFriday._ineligibleNow, {
          send: "launch", version, locale, recipient, emails: candidates,
        });
        const kept = candidates.filter((email) => !dropped.includes(email)).sort();
        expect([...reservoir.values()].sort(), key).toEqual(kept);
        checked += kept.length;
      }
    }
    expect(checked).toBeGreaterThan(5);

    const report = await t.action(internal.broadcast.blackFriday.blackFridayAudience, { send: "launch" });
    expect(report.excluded.accounts).toEqual({
      "no-email": 1,
      suppressed: 2,
      "account-deleting": 1,
      "enterprise-member": 2,
      "monthly-cancel-scheduled": 1,
      "on-hold": 1,
      "pro-yearly": 1,
      "converted-during-offer": 1,
      "entitled-without-subscription": 1,
      "duplicate-email": 1,
    });
    expect(report.excluded.waitlist).toEqual({
      "has-account": 2, suppressed: 1, customer: 2, "duplicate-email": 1,
    });
    expect(report.segments).toEqual({
      "new-buyer/en/account": { eligible: 7, alreadySent: 2, toSend: 5 },
      "new-buyer/fr/account": { eligible: 1, alreadySent: 0, toSend: 1 },
      "lapsed/en/account": { eligible: 1, alreadySent: 0, toSend: 1 },
      "monthly-switch/en/account": { eligible: 1, alreadySent: 0, toSend: 1 },
      "new-buyer/en/waitlist": { eligible: 4, alreadySent: 1, toSend: 3 },
      "new-buyer/zh/waitlist": { eligible: 1, alreadySent: 0, toSend: 1 },
    });
  });
});
