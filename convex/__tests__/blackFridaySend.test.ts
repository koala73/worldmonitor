import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { getFeaturesForPlan } from "../lib/entitlements";
import {
  accountLocale,
  classifyAccount,
  classifyWaitlist,
  groupsFor,
  sendFor,
  versionFor,
  waitlistLocale,
  type AccountFacts,
} from "../broadcast/_blackFridayAudience";
import {
  BLACK_FRIDAY_CONFIG_KEY,
  WAITLIST_CANARY_MAX,
  waveRefusal,
} from "../broadcast/blackFriday";
import { BLACK_FRIDAY_OFFER, BLACK_FRIDAY_VERSIONS } from "../broadcast/blackFridayEmailContent";

const modules = import.meta.glob("../**/*.ts");

const DAY = 24 * 60 * 60 * 1000;
const OFFER_START = Date.UTC(2026, 10, 26);
/** Mid-offer: launch sends are allowed, last-day sends are not yet. */
const NOW = Date.UTC(2026, 10, 28, 12, 0, 0);
/** The offer's last day, before the send cutoff. */
const LAST_DAY = Date.UTC(2026, 11, 4, 9, 0, 0);

type Sub = AccountFacts["subscriptions"][number];

function sub(overrides: Partial<Sub> & { planKey: string }): Sub {
  return {
    status: "active",
    currentPeriodStart: NOW - 10 * DAY,
    currentPeriodEnd: NOW + 20 * DAY,
    dodoSubscriptionId: `sub_${overrides.planKey}`,
    dodoProductId: `pdt_${overrides.planKey}`,
    rawPayload: {},
    ...overrides,
  } as Sub;
}

function facts(overrides: Partial<AccountFacts> = {}): AccountFacts {
  return {
    normalizedEmail: "person@example.com",
    suppressed: false,
    deleting: false,
    enterpriseMemberActive: false,
    subscriptions: [],
    entitlement: null,
    ...overrides,
  };
}

const classify = (overrides: Partial<AccountFacts> = {}) => classifyAccount(facts(overrides), NOW, OFFER_START);

describe("account eligibility", () => {
  test("no subscription history and no entitlement is a free account", () => {
    expect(classify()).toEqual({ eligible: true, group: "free" });
    // A free entitlement row is not a paid entitlement.
    expect(classify({ entitlement: { planKey: "free", validUntil: NOW + DAY } })).toEqual({
      eligible: true,
      group: "free",
    });
  });

  test("an ended subscription with nothing covering is lapsed", () => {
    for (const status of ["cancelled", "expired"] as const) {
      expect(
        classify({ subscriptions: [sub({ planKey: "pro_monthly", status, currentPeriodEnd: NOW - DAY })] }),
      ).toEqual({ eligible: true, group: "lapsed" });
    }
  });

  test("an active, non-cancelling Pro Monthly gets the switch email", () => {
    expect(classify({ subscriptions: [sub({ planKey: "pro_monthly" })] })).toEqual({
      eligible: true,
      group: "monthly",
    });
  });

  test.each([
    ["suppressed", { suppressed: true }, "suppressed"],
    ["no email", { normalizedEmail: undefined }, "no-email"],
    ["account being deleted", { deleting: true }, "account-deleting"],
    ["active enterprise member", { enterpriseMemberActive: true }, "enterprise-member"],
    ["Pro Yearly from before the offer", { subscriptions: [sub({ planKey: "pro_annual", currentPeriodStart: OFFER_START - 30 * DAY })] }, "pro-yearly"],
    ["bought Pro Yearly during the offer", { subscriptions: [sub({ planKey: "pro_annual", currentPeriodStart: OFFER_START + DAY })] }, "converted-during-offer"],
    [
      "bought Pro Yearly during the offer, then refunded",
      { subscriptions: [sub({ planKey: "pro_annual", status: "expired", currentPeriodStart: OFFER_START + DAY, currentPeriodEnd: NOW - 1 })] },
      "converted-during-offer",
    ],
    ["Pro Business", { subscriptions: [sub({ planKey: "pro_business_monthly" })] }, "pro-business"],
    ["API Starter", { subscriptions: [sub({ planKey: "api_starter" })] }, "api-plan"],
    ["API Business", { subscriptions: [sub({ planKey: "api_business" })] }, "api-plan"],
    ["Enterprise", { subscriptions: [sub({ planKey: "enterprise" })] }, "enterprise-plan"],
    [
      "Pro Monthly with a cancellation scheduled",
      { subscriptions: [sub({ planKey: "pro_monthly", rawPayload: { cancel_at_next_billing_date: true } })] },
      "monthly-cancel-scheduled",
    ],
    [
      "Pro Monthly with only cancelScheduledAt set",
      { subscriptions: [{ ...sub({ planKey: "pro_monthly" }), cancelScheduledAt: NOW - DAY }] },
      "monthly-cancel-scheduled",
    ],
    ["Pro Monthly on hold", { subscriptions: [sub({ planKey: "pro_monthly", status: "on_hold" })] }, "on-hold"],
    [
      "Pro Monthly on hold past its paid period",
      { subscriptions: [sub({ planKey: "pro_monthly", status: "on_hold", currentPeriodEnd: NOW - DAY })] },
      "on-hold",
    ],
    ["Pro at the MCP-only monthly price", { subscriptions: [sub({ planKey: "pro_monthly_mcp" })] }, "pro-monthly-mcp"],
    [
      "Pro Monthly cancelled but still inside the paid period",
      { subscriptions: [sub({ planKey: "pro_monthly", status: "cancelled" })] },
      "monthly-cancelled-still-covered",
    ],
    [
      "Pro Monthly alongside an API plan",
      { subscriptions: [sub({ planKey: "pro_monthly" }), sub({ planKey: "api_starter" })] },
      "api-plan",
    ],
    ["comped with no subscription", { entitlement: { planKey: "free", validUntil: 0, compUntil: NOW + DAY } }, "entitled-without-subscription"],
    ["still entitled with no live subscription", { entitlement: { planKey: "pro_monthly", validUntil: NOW + DAY } }, "entitled-without-subscription"],
  ] as Array<[string, Partial<AccountFacts>, string]>)("excludes: %s", (_name, overrides, reason) => {
    expect(classify(overrides)).toEqual({ eligible: false, reason });
  });

  test("an expired entitlement does not exclude", () => {
    expect(classify({ entitlement: { planKey: "pro_monthly", validUntil: NOW - DAY, compUntil: NOW - DAY } })).toEqual({
      eligible: true,
      group: "free",
    });
  });
});

describe("waitlist eligibility", () => {
  const base = { normalizedEmail: "w@example.com", suppressed: false, hasAccount: false, isCustomer: false };
  test("a registration with no account, no customer record and no suppression is eligible", () => {
    expect(classifyWaitlist(base)).toEqual({ eligible: true });
  });
  test.each([
    [{ suppressed: true }, "suppressed"],
    [{ hasAccount: true }, "has-account"],
    [{ isCustomer: true }, "customer"],
    [{ normalizedEmail: "" }, "no-email"],
  ] as Array<[Partial<typeof base>, string]>)("excludes %o", (overrides, reason) => {
    expect(classifyWaitlist({ ...base, ...overrides })).toEqual({ eligible: false, reason });
  });
});

describe("locale and version mapping", () => {
  test("accounts use the stored locale, Traditional Chinese and everyone else get English", () => {
    expect(accountLocale({ localePrimary: "fr" })).toBe("fr");
    expect(accountLocale({ localeTag: "de-AT", localePrimary: "de" })).toBe("de");
    expect(accountLocale({ localeTag: "zh-CN", localePrimary: "zh" })).toBe("zh");
    expect(accountLocale({ localeTag: "zh-TW", localePrimary: "zh" })).toBe("en");
    expect(accountLocale({ localePrimary: "ja" })).toBe("en");
    expect(accountLocale({ localePrimary: "pt" })).toBe("en");
    // No stored locale: the email-domain heuristic, else English.
    expect(accountLocale({ normalizedEmail: "a@qq.com" })).toBe("zh");
    expect(accountLocale({ normalizedEmail: "a@gmail.com" })).toBe("en");
    // A stored locale beats the heuristic.
    expect(accountLocale({ localePrimary: "es", normalizedEmail: "a@qq.com" })).toBe("es");
  });

  test("waitlist contacts use the email-domain heuristic, else English", () => {
    expect(waitlistLocale("a@163.com")).toBe("zh");
    expect(waitlistLocale("a@example.cn")).toBe("zh");
    expect(waitlistLocale("a@yandex.ru")).toBe("en");
    expect(waitlistLocale("a@yahoo.co.jp")).toBe("en");
    expect(waitlistLocale("a@example.fr")).toBe("en");
    expect(waitlistLocale("a@gmail.com")).toBe("en");
  });

  test("each group gets its version in each send, and every version has an audience", () => {
    expect(versionFor("launch", "free")).toBe("new-buyer");
    expect(versionFor("launch", "waitlist")).toBe("new-buyer");
    expect(versionFor("launch", "lapsed")).toBe("lapsed");
    expect(versionFor("launch", "monthly")).toBe("monthly-switch");
    expect(versionFor("last-day", "free")).toBe("last-day");
    expect(versionFor("last-day", "lapsed")).toBe("last-day");
    expect(versionFor("last-day", "waitlist")).toBe("last-day");
    expect(versionFor("last-day", "monthly")).toBe("last-day-switch");
    for (const version of BLACK_FRIDAY_VERSIONS) {
      const groups = groupsFor(version, "account");
      expect(groups).not.toBeNull();
      for (const group of groups ?? []) expect(versionFor(sendFor(version), group)).toBe(version);
    }
    expect(groupsFor("new-buyer", "waitlist")).toEqual(["waitlist"]);
    expect(groupsFor("last-day", "waitlist")).toEqual(["waitlist"]);
    for (const version of ["lapsed", "monthly-switch", "last-day-switch"] as const) {
      expect(groupsFor(version, "waitlist")).toBeNull();
    }
  });
});

describe("when a wave may start", () => {
  const healthy = {
    tripReason: null,
    waitlist: { broadcasts: 0, delivered: 0, bounced: 0, complained: 0, bounceRate: null, complaintRate: null, trusted: false, overThreshold: false },
  };
  const sentRun = (recipient: "account" | "waitlist", send: "launch" | "last-day", updatedAt = NOW - 30 * 60 * 60 * 1000, pushedCount = 500) => ({
    status: "sent" as const,
    updatedAt,
    pushedCount,
    campaign: { id: BLACK_FRIDAY_CONFIG_KEY, send, version: "new-buyer", locale: "en", recipient, holdBeforeSend: true },
  });
  const base = {
    now: NOW,
    send: "launch" as const,
    recipient: "account" as const,
    count: undefined as number | undefined,
    settleHours: 18,
    configured: true,
    killGateTripped: false,
    health: healthy,
    runs: [] as ReturnType<typeof sentRun>[],
  };

  test("an account launch wave may start mid-offer", () => {
    expect(waveRefusal(base)).toBeNull();
  });

  test("refuses without a config row, with the gate tripped, or with the lease held", () => {
    expect(waveRefusal({ ...base, configured: false })).toMatch(/initBlackFriday/);
    expect(waveRefusal({ ...base, killGateTripped: true, killGateReason: "bounce 9%" })).toMatch(/bounce 9%/);
    expect(waveRefusal({ ...base, health: { ...healthy, tripReason: "waitlist broadcasts: bounce 6%" } })).toMatch(/bounce 6%/);
    expect(waveRefusal({ ...base, leaseHeldBy: "run-1" })).toMatch(/run-1/);
  });

  test("the offer clock bounds both sends", () => {
    const end = BLACK_FRIDAY_OFFER.endsAtMs;
    expect(waveRefusal({ ...base, now: end + 1 })).toMatch(/end of the offer/);
    expect(waveRefusal({ ...base, now: end - 60 * 60 * 1000 })).toMatch(/end of the offer/);
    expect(waveRefusal({ ...base, send: "last-day" })).toMatch(/final 24 hours/);
    expect(waveRefusal({ ...base, send: "last-day", now: LAST_DAY })).toBeNull();
    expect(waveRefusal({ ...base, now: LAST_DAY })).toMatch(/last-day versions/);
  });

  test("the waitlist waits for accounts, starts with a canary, then needs trusted stats and a settle window", () => {
    const waitlist = { ...base, recipient: "waitlist" as const, count: 400 };
    expect(waveRefusal(waitlist)).toMatch(/account holders go first/);
    const afterAccounts = { ...waitlist, runs: [sentRun("account", "launch")] };
    expect(waveRefusal(afterAccounts)).toBeNull();
    expect(waveRefusal({ ...afterAccounts, count: undefined })).toMatch(/pass a count/);
    expect(waveRefusal({ ...afterAccounts, count: WAITLIST_CANARY_MAX + 1 })).toMatch(/canary/);

    const afterCanary = { ...afterAccounts, count: 5000, runs: [sentRun("account", "launch"), sentRun("waitlist", "launch")] };
    expect(waveRefusal(afterCanary)).toMatch(/100 are needed.*allowance is used up/);
    // A canary that exported only 80 can be topped up inside the 500 allowance, never beyond it.
    const smallCanary = { ...afterAccounts, runs: [sentRun("account", "launch"), sentRun("waitlist", "launch", NOW - 30 * 60 * 60 * 1000, 80)] };
    expect(waveRefusal({ ...smallCanary, count: 420 })).toBeNull();
    expect(waveRefusal({ ...smallCanary, count: 421 })).toMatch(/at most 420/);
    expect(
      waveRefusal({ ...smallCanary, count: 100, runs: [sentRun("account", "launch"), sentRun("waitlist", "launch", NOW - 60 * 60 * 1000, 80)] }),
    ).toMatch(/only 1\.0h since the last waitlist wave/);
    const trusted = { ...healthy, waitlist: { ...healthy.waitlist, delivered: 380, trusted: true } };
    expect(waveRefusal({ ...afterCanary, health: trusted })).toBeNull();
    expect(
      waveRefusal({ ...afterCanary, health: trusted, runs: [sentRun("account", "launch"), sentRun("waitlist", "launch", NOW - 3 * 60 * 60 * 1000)] }),
    ).toMatch(/only 3\.0h since the last waitlist wave/);
  });

  test("the last-day waitlist reminder needs its own account wave first, but no second ramp", () => {
    const lastDay = { ...base, now: LAST_DAY, send: "last-day" as const, recipient: "waitlist" as const };
    expect(waveRefusal({ ...lastDay, runs: [sentRun("account", "launch")] })).toMatch(/account holders go first/);
    expect(waveRefusal({ ...lastDay, runs: [sentRun("account", "last-day")] })).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Against the database
// ───────────────────────────────────────────────────────────────────────────

const newTest = () => convexTest(schema, modules);
type T = ReturnType<typeof newTest>;

async function seedUser(
  t: T,
  id: string,
  opts: {
    email?: string;
    locale?: string;
    localeTag?: string;
    subs?: Array<{ planKey: string; status?: "active" | "on_hold" | "cancelled" | "expired"; start?: number; end?: number; rawPayload?: unknown }>;
    entitlement?: { planKey: string; validUntil: number; compUntil?: number };
    suppressed?: boolean;
    enterpriseMember?: boolean;
  } = {},
): Promise<string> {
  const email = opts.email ?? `${id}@example.com`;
  await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      userId: id,
      email,
      normalizedEmail: email,
      localePrimary: opts.locale ?? "en",
      localeTag: opts.localeTag,
      firstSeenAt: NOW - 90 * DAY,
      lastSeenAt: NOW - DAY,
    });
    for (const [index, s] of (opts.subs ?? []).entries()) {
      await ctx.db.insert("subscriptions", {
        userId: id,
        dodoSubscriptionId: `sub_${id}_${index}`,
        dodoProductId: `pdt_${s.planKey}`,
        planKey: s.planKey,
        status: s.status ?? "active",
        currentPeriodStart: s.start ?? NOW - 10 * DAY,
        currentPeriodEnd: s.end ?? NOW + 20 * DAY,
        rawPayload: s.rawPayload ?? {},
        updatedAt: NOW,
      });
    }
    if (opts.entitlement) {
      await ctx.db.insert("entitlements", {
        userId: id,
        planKey: opts.entitlement.planKey,
        features: getFeaturesForPlan(opts.entitlement.planKey),
        validUntil: opts.entitlement.validUntil,
        compUntil: opts.entitlement.compUntil,
        updatedAt: NOW,
      });
    }
    if (opts.suppressed) {
      await ctx.db.insert("emailSuppressions", { normalizedEmail: email, reason: "bounce", suppressedAt: NOW });
    }
    if (opts.enterpriseMember) {
      const accountId = await ctx.db.insert("enterpriseAccounts", {
        name: "Acme",
        contractStart: NOW - DAY,
        contractEnd: NOW + 300 * DAY,
        dailyRequestAllowance: 1,
        perMinuteBurst: 1,
        monthlyInputTokens: 1,
        monthlyOutputTokens: 1,
        overagePerThousandRequestsUsd: 0,
        overagePerMillionInputTokensUsd: 0,
        overagePerMillionOutputTokensUsd: 0,
        breakerMultiple: 1,
        seatCap: 5,
        allowedProviders: [],
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert("enterpriseMembers", { accountId, userId: id, email, status: "active", role: "member", updatedAt: NOW });
    }
  });
  return email;
}

async function seedRegistration(t: T, email: string, extra: Record<string, unknown> = {}): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("registrations", { email, normalizedEmail: email, registeredAt: NOW - 200 * DAY, ...extra });
  });
}

/** A small audience with one of everything. */
async function seedAudience(t: T): Promise<void> {
  await seedUser(t, "free-en-1");
  await seedUser(t, "free-en-2");
  await seedUser(t, "free-fr", { locale: "fr" });
  await seedUser(t, "free-zh-tw", { locale: "zh", localeTag: "zh-TW" });
  await seedUser(t, "lapsed-en", { subs: [{ planKey: "pro_monthly", status: "cancelled", end: NOW - 40 * DAY }] });
  await seedUser(t, "monthly-en", { subs: [{ planKey: "pro_monthly" }], entitlement: { planKey: "pro_monthly", validUntil: NOW + 20 * DAY } });
  await seedUser(t, "monthly-de", { locale: "de", subs: [{ planKey: "pro_monthly" }] });
  await seedUser(t, "monthly-cancelling", { subs: [{ planKey: "pro_monthly", rawPayload: { cancel_at_next_billing_date: true } }] });
  await seedUser(t, "monthly-hold", { subs: [{ planKey: "pro_monthly", status: "on_hold" }] });
  await seedUser(t, "yearly", { subs: [{ planKey: "pro_annual", start: OFFER_START - 100 * DAY }] });
  await seedUser(t, "converted", { subs: [{ planKey: "pro_annual", start: OFFER_START + DAY }] });
  await seedUser(t, "api", { subs: [{ planKey: "api_starter" }] });
  await seedUser(t, "business", { subs: [{ planKey: "pro_business_monthly" }] });
  await seedUser(t, "comped", { entitlement: { planKey: "free", validUntil: 0, compUntil: NOW + 30 * DAY } });
  await seedUser(t, "bounced", { suppressed: true });
  await seedUser(t, "member", { enterpriseMember: true });

  await seedRegistration(t, "wait-1@example.com");
  await seedRegistration(t, "wait-2@example.com");
  await seedRegistration(t, "wait-zh@qq.com");
  // Already has an account: not a waitlist contact.
  await seedRegistration(t, "free-en-1@example.com");
  await seedRegistration(t, "wait-suppressed@example.com");
  await seedRegistration(t, "wait-customer@example.com");
  await seedRegistration(t, "wait-old-customer@example.com");
  await t.run(async (ctx) => {
    await ctx.db.insert("emailSuppressions", { normalizedEmail: "wait-suppressed@example.com", reason: "unsubscribe", suppressedAt: NOW });
    await ctx.db.insert("customers", { userId: "gone", email: "wait-customer@example.com", normalizedEmail: "wait-customer@example.com", createdAt: NOW, updatedAt: NOW });
    // A customer row from before normalizedEmail existed.
    await ctx.db.insert("customers", { userId: "gone-2", email: "Wait-Old-Customer@example.com", createdAt: NOW, updatedAt: NOW });
    // The PRO-launch ramp's row: nothing in this campaign may touch it.
    await ctx.db.insert("broadcastRampConfig", {
      key: "current", active: true, rampCurve: [500, 1500], currentTier: 0,
      waveLabelPrefix: "wave", waveLabelOffset: 3,
      bounceKillThreshold: 0.04, complaintKillThreshold: 0.0008, killGateTripped: false,
      lastWaveLabel: "wave-3", lastWaveBroadcastId: "bro_pro_launch",
    });
  });
}

type FetchCall = { url: string; method: string; body: Record<string, unknown> | null };

/** A Resend stand-in that records every call and never reaches the network. */
function stubResend(): FetchCall[] {
  const calls: FetchCall[] = [];
  let next = 0;
  vi.stubEnv("RESEND_API_KEY", "synthetic-key");
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" && init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ url, method: init?.method ?? "GET", body });
    next += 1;
    if (url.endsWith("/segments")) return Response.json({ id: `seg_${next}` });
    if (url.endsWith("/broadcasts")) return Response.json({ id: `bro_${next}` });
    return Response.json({ id: `obj_${next}` });
  });
  return calls;
}

const count = (calls: FetchCall[], suffix: string) => calls.filter((call) => call.url.endsWith(suffix)).length;

/** Run the pipeline steps the scheduler would run, up to the hold. */
async function driveToHold(t: T, runId: string): Promise<void> {
  for (let batch = 0; batch < 5; batch++) {
    const pushed = await t.action(internal.broadcast.waveRuns.pushBatchAction, { runId, batchN: batch });
    if (pushed.reason === "finalize-scheduled" || pushed.reason === "no-pending-finalize-scheduled") break;
  }
  expect(await t.action(internal.broadcast.waveRuns.finalizeWaveAction, { runId })).toEqual({ ok: true, reason: "held-for-release" });
}

async function startReal(t: T, args: { version: string; locale: string; recipient: "account" | "waitlist"; count?: number; wave?: number }) {
  const result = await t.action(internal.broadcast.blackFriday.startBlackFridayWave, { ...args, dryRun: false });
  if (result.dryRun) throw new Error("expected a real run");
  return result;
}

async function stamps(t: T) {
  return t.run(async (ctx) => {
    const users = await ctx.db.query("users").collect();
    const registrations = await ctx.db.query("registrations").collect();
    return {
      users: Object.fromEntries(users.map((u) => [u.userId, { launch: u.blackFridayLaunchWave, lastDay: u.blackFridayLastDayWave }])),
      registrations: Object.fromEntries(
        registrations.map((r) => [r.normalizedEmail, { launch: r.blackFridayLaunchWave, lastDay: r.blackFridayLastDayWave, proLaunch: r.proLaunchWave }]),
      ),
    };
  });
}

describe("Black Friday send against the database", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  test("the audience report counts every group, segment and exclusion, and calls nothing", async () => {
    const t = newTest();
    await seedAudience(t);
    const calls = stubResend();
    const report = await t.action(internal.broadcast.blackFriday.blackFridayAudience, { send: "launch" });

    expect(report.groups).toEqual({
      free: { eligible: 4, alreadySent: 0, toSend: 4 },
      lapsed: { eligible: 1, alreadySent: 0, toSend: 1 },
      monthly: { eligible: 2, alreadySent: 0, toSend: 2 },
      waitlist: { eligible: 3, alreadySent: 0, toSend: 3 },
    });
    expect(report.segments).toEqual({
      // The Traditional Chinese reader is in the English segment.
      "new-buyer/en/account": { eligible: 3, alreadySent: 0, toSend: 3 },
      "new-buyer/fr/account": { eligible: 1, alreadySent: 0, toSend: 1 },
      "lapsed/en/account": { eligible: 1, alreadySent: 0, toSend: 1 },
      "monthly-switch/en/account": { eligible: 1, alreadySent: 0, toSend: 1 },
      "monthly-switch/de/account": { eligible: 1, alreadySent: 0, toSend: 1 },
      "new-buyer/en/waitlist": { eligible: 2, alreadySent: 0, toSend: 2 },
      "new-buyer/zh/waitlist": { eligible: 1, alreadySent: 0, toSend: 1 },
    });
    expect(report.excluded.accounts).toEqual({
      "monthly-cancel-scheduled": 1,
      "on-hold": 1,
      "pro-yearly": 1,
      "converted-during-offer": 1,
      "api-plan": 1,
      "pro-business": 1,
      "entitled-without-subscription": 1,
      suppressed: 1,
      "enterprise-member": 1,
    });
    expect(report.excluded.waitlist).toEqual({ "has-account": 1, suppressed: 1, customer: 2 });
    expect(report.scanned).toEqual({ users: 16, registrations: 7 });
    const accountsOnly = await t.action(internal.broadcast.blackFriday.blackFridayAudience, { send: "launch", scope: "accounts" });
    expect(accountsOnly.scanned).toEqual({ users: 16, registrations: 0 });
    expect(accountsOnly.groups.free).toEqual(report.groups.free);
    expect(accountsOnly.groups.waitlist.eligible).toBe(0);
    // Counts only: no address leaves the action.
    expect(JSON.stringify(report)).not.toContain("@");
    expect(calls).toEqual([]);
  });

  test("a wave is a dry run unless dryRun is exactly false: no Resend call, no lease, no row", async () => {
    const t = newTest();
    await seedAudience(t);
    await t.mutation(internal.broadcast.blackFriday.initBlackFriday, {});
    const calls = stubResend();
    const before = await t.run(async (ctx) => JSON.stringify(await ctx.db.query("broadcastRampConfig").collect()));

    for (const dryRun of [undefined, true] as const) {
      const result = await t.action(internal.broadcast.blackFriday.startBlackFridayWave, {
        version: "new-buyer", locale: "en", recipient: "account", ...(dryRun === undefined ? {} : { dryRun }),
      });
      expect(result).toEqual({
        dryRun: true,
        segment: "new-buyer/en/account",
        waveLabel: "bf-new-buyer-en-account-1",
        eligible: 3, alreadySent: 0, toSend: 3, wouldPick: 3,
        wouldRefuse: null,
      });
    }
    // Refusals are reported, not thrown, in a dry run.
    const waitlist = await t.action(internal.broadcast.blackFriday.startBlackFridayWave, {
      version: "new-buyer", locale: "en", recipient: "waitlist", count: 100,
    });
    expect(waitlist).toMatchObject({ dryRun: true, toSend: 2, wouldPick: 2, wouldRefuse: expect.stringMatching(/account holders go first/) });

    expect(calls).toEqual([]);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("waveRuns").collect()).toEqual([]);
      expect(await ctx.db.query("wavePickedContacts").collect()).toEqual([]);
      expect(JSON.stringify(await ctx.db.query("broadcastRampConfig").collect())).toBe(before);
    });
    expect(Object.values((await stamps(t)).users).every((s) => s.launch === undefined)).toBe(true);
  });

  test("a real wave refuses before initBlackFriday, and for a version the recipient type does not get", async () => {
    const t = newTest();
    await seedAudience(t);
    const calls = stubResend();
    await expect(
      t.action(internal.broadcast.blackFriday.startBlackFridayWave, { version: "new-buyer", locale: "en", recipient: "account", dryRun: false }),
    ).rejects.toThrow(/initBlackFriday/);
    await expect(
      t.action(internal.broadcast.blackFriday.startBlackFridayWave, { version: "lapsed", locale: "en", recipient: "waitlist" }),
    ).rejects.toThrow(/not sent to waitlist/);
    await expect(
      t.action(internal.broadcast.blackFriday.startBlackFridayWave, { version: "new-buyer", locale: "it", recipient: "account" }),
    ).rejects.toThrow(/unknown locale/);
    expect(calls).toEqual([]);
  });

  test("a real wave stamps its contacts, holds the broadcast, and sends only on release", async () => {
    const t = newTest();
    await seedAudience(t);
    await t.mutation(internal.broadcast.blackFriday.initBlackFriday, {});
    const calls = stubResend();

    const started = await startReal(t, { version: "new-buyer", locale: "en", recipient: "account" });
    expect(started).toMatchObject({ segment: "new-buyer/en/account", waveLabel: "bf-new-buyer-en-account-1", picked: 3, toSend: 3 });
    expect(calls.filter((c) => c.url.endsWith("/segments")).map((c) => c.body)).toEqual([{ name: "black-friday-2026-bf-new-buyer-en-account-1" }]);

    await driveToHold(t, started.runId);
    expect(count(calls, "/contacts")).toBe(3);
    expect(count(calls, "/broadcasts")).toBe(1);
    expect(calls.some((c) => c.url.endsWith("/send"))).toBe(false);

    // The broadcast is this segment's version and locale, with Resend's unsubscribe token.
    const broadcast = calls.find((c) => c.url.endsWith("/broadcasts"))!.body!;
    expect(broadcast).toMatchObject({
      segment_id: started.segmentId,
      subject: "70% off WorldMonitor Pro until December 4",
      from: "Elie from WorldMonitor <news@worldmonitor.app>",
    });
    expect(broadcast.html).toContain('href="{{{RESEND_UNSUBSCRIBE_URL}}}"');
    expect(broadcast.html).toContain("You are receiving this email because you have a WorldMonitor account.");
    expect(broadcast.text).toContain("{{{RESEND_UNSUBSCRIBE_URL}}}");

    // Stamps: the three English free accounts, on `users`, for the launch send only.
    const afterPush = await stamps(t);
    const stamped = Object.entries(afterPush.users).filter(([, s]) => s.launch !== undefined).map(([id]) => id).sort();
    expect(stamped).toEqual(["free-en-1", "free-en-2", "free-zh-tw"]);
    expect(Object.values(afterPush.users).every((s) => s.lastDay === undefined)).toBe(true);
    expect(Object.values(afterPush.registrations).every((s) => s.launch === undefined && s.proLaunch === undefined)).toBe(true);

    // A second finalize (overlapping batches, a generic resume) must not send a held broadcast.
    expect(await t.action(internal.broadcast.waveRuns.finalizeWaveAction, { runId: started.runId })).toEqual({ ok: false, reason: "held-awaiting-release" });
    await t.mutation(internal.broadcast.waveRuns.resumeFinalizeWaveRun, { runId: started.runId, confirmedNotSent: true });
    expect(await t.action(internal.broadcast.waveRuns.finalizeWaveAction, { runId: started.runId })).toEqual({ ok: false, reason: "held-awaiting-release" });
    expect(calls.some((c) => c.url.endsWith("/send"))).toBe(false);

    // While it is held, no other wave may start.
    await expect(startReal(t, { version: "lapsed", locale: "en", recipient: "account" })).rejects.toThrow(/holds the lease/);

    // Release is a dry run by default.
    const preview = await t.action(internal.broadcast.blackFriday.releaseBlackFridayBroadcast, { runId: started.runId });
    expect(preview).toMatchObject({ dryRun: true, released: false, recipients: 3, wouldRefuse: null, segment: "new-buyer/en/account" });
    expect(calls.some((c) => c.url.endsWith("/send"))).toBe(false);

    const released = await t.action(internal.broadcast.blackFriday.releaseBlackFridayBroadcast, { runId: started.runId, dryRun: false });
    expect(released).toMatchObject({ dryRun: false, released: true });
    expect(await t.action(internal.broadcast.waveRuns.finalizeWaveAction, { runId: started.runId })).toEqual({ ok: true });
    expect(calls.filter((c) => c.url.endsWith("/send")).map((c) => c.url)).toEqual([
      `https://api.resend.com/broadcasts/${preview.broadcastId}/send`,
    ]);

    const status = await t.query(internal.broadcast.blackFriday.getBlackFridayStatus, {});
    expect(status.leaseHeldBy).toBeUndefined();
    expect(status.runs).toHaveLength(1);
    expect(status.runs[0]).toMatchObject({ status: "sent", pushedCount: 3, held: false });

    // The PRO-launch ramp's row is exactly as it was.
    const proLaunch = await t.run(async (ctx) =>
      ctx.db.query("broadcastRampConfig").withIndex("by_key", (q) => q.eq("key", "current")).unique(),
    );
    expect(proLaunch).toMatchObject({ active: true, currentTier: 0, waveLabelOffset: 3, lastWaveLabel: "wave-3", lastWaveBroadcastId: "bro_pro_launch" });
    expect(proLaunch!.pendingRunId).toBeUndefined();

    // Idempotent: the same segment again has no one left, creates nothing and frees the lease.
    const callsBefore = calls.length;
    const again = await t.action(internal.broadcast.blackFriday.startBlackFridayWave, { version: "new-buyer", locale: "en", recipient: "account", wave: 2 });
    expect(again).toMatchObject({ dryRun: true, eligible: 3, alreadySent: 3, toSend: 0, wouldPick: 0 });
    await expect(startReal(t, { version: "new-buyer", locale: "en", recipient: "account", wave: 2 })).rejects.toThrow(/nothing to send/);
    expect(calls.length).toBe(callsBefore);
    expect((await t.query(internal.broadcast.blackFriday.getBlackFridayStatus, {})).leaseHeldBy).toBeUndefined();
    // A used label is refused outright.
    await expect(startReal(t, { version: "new-buyer", locale: "en", recipient: "account" })).rejects.toThrow(/already used/);
  });

  test("a discarded held wave unstamps its contacts and frees the lease", async () => {
    const t = newTest();
    await seedAudience(t);
    await t.mutation(internal.broadcast.blackFriday.initBlackFriday, {});
    const calls = stubResend();
    const started = await startReal(t, { version: "monthly-switch", locale: "de", recipient: "account" });
    await driveToHold(t, started.runId);
    expect((await stamps(t)).users["monthly-de"]!.launch).toBe("bf-monthly-switch-de-account-1");

    await t.mutation(internal.broadcast.waveRuns.discardHeldCampaignRun, { runId: started.runId, reason: "wrong copy" });
    await t.action(internal.broadcast.waveRuns.cleanupDiscardedWavePickedContactsAction, { runId: started.runId });
    expect((await stamps(t)).users["monthly-de"]!.launch).toBeUndefined();
    const status = await t.query(internal.broadcast.blackFriday.getBlackFridayStatus, {});
    expect(status.leaseHeldBy).toBeUndefined();
    expect(status.runs[0]).toMatchObject({ status: "failed", failureSubstatus: "discarded-by-operator" });
    expect(calls.some((c) => c.url.endsWith("/send"))).toBe(false);
    // Releasing it now is refused, and a released run cannot be discarded.
    await expect(
      t.action(internal.broadcast.blackFriday.releaseBlackFridayBroadcast, { runId: started.runId, dryRun: false }),
    ).rejects.toThrow(/not a held broadcast/);

    const second = await startReal(t, { version: "monthly-switch", locale: "de", recipient: "account", wave: 2 });
    await driveToHold(t, second.runId);
    await t.action(internal.broadcast.blackFriday.releaseBlackFridayBroadcast, { runId: second.runId, dryRun: false });
    await expect(
      t.mutation(internal.broadcast.waveRuns.discardHeldCampaignRun, { runId: second.runId, reason: "too late" }),
    ).rejects.toThrow(/not a held, unreleased/);
    await t.finishInProgressScheduledFunctions().catch(() => {});
  });

  test("a held broadcast that sat too long is refused: its segment may hold people who have since bought", async () => {
    const t = newTest();
    await seedAudience(t);
    await t.mutation(internal.broadcast.blackFriday.initBlackFriday, {});
    const calls = stubResend();
    const started = await startReal(t, { version: "lapsed", locale: "en", recipient: "account" });
    await driveToHold(t, started.runId);
    vi.setSystemTime(NOW + 7 * 60 * 60 * 1000);
    // A generic recovery command touches the run but must not make the draft look fresh.
    await t.mutation(internal.broadcast.waveRuns.resumeFinalizeWaveRun, { runId: started.runId, confirmedNotSent: true });
    await expect(
      t.action(internal.broadcast.blackFriday.releaseBlackFridayBroadcast, { runId: started.runId, dryRun: false }),
    ).rejects.toThrow(/held too long/);
    expect(calls.some((c) => c.url.endsWith("/send"))).toBe(false);
  });

  test("the kill gate reads all the campaign's broadcasts, trips on a bad rate, and blocks starts and releases", async () => {
    const t = newTest();
    await seedAudience(t);
    await t.mutation(internal.broadcast.blackFriday.initBlackFriday, {});
    const calls = stubResend();
    const first = await startReal(t, { version: "new-buyer", locale: "en", recipient: "account" });
    await driveToHold(t, first.runId);
    const { broadcastId } = await t.action(internal.broadcast.blackFriday.releaseBlackFridayBroadcast, { runId: first.runId, dryRun: false });
    await t.action(internal.broadcast.waveRuns.finalizeWaveAction, { runId: first.runId });

    const held = await startReal(t, { version: "lapsed", locale: "en", recipient: "account" });
    await driveToHold(t, held.runId);

    // 120 delivered and 6 bounced on the sent broadcast: 5% against a 4% limit.
    await t.run(async (ctx) => {
      for (let i = 0; i < 120; i++) {
        await ctx.db.insert("broadcastEvents", { webhookEventId: `d${i}`, broadcastId: broadcastId!, eventType: "email.delivered", occurredAt: NOW });
      }
      for (let i = 0; i < 6; i++) {
        await ctx.db.insert("broadcastEvents", { webhookEventId: `b${i}`, broadcastId: broadcastId!, eventType: "email.bounced", occurredAt: NOW });
      }
    });
    const health = await t.action(internal.broadcast.blackFriday.blackFridayHealth, {});
    expect(health.accounts).toMatchObject({ broadcasts: 1, delivered: 120, bounced: 6, trusted: true, overThreshold: true });
    expect(health.tripReason).toMatch(/accounts broadcasts: bounce 5\.00% \(limit 4\.00%\)/);
    // Reading health trips nothing.
    expect((await t.query(internal.broadcast.blackFriday.getBlackFridayStatus, {})).killGateTripped).toBe(false);

    const sendsBefore = count(calls, "/send");
    await expect(
      t.action(internal.broadcast.blackFriday.releaseBlackFridayBroadcast, { runId: held.runId, dryRun: false }),
    ).rejects.toThrow(/kill gate/);
    expect(count(calls, "/send")).toBe(sendsBefore);
    const tripped = await t.query(internal.broadcast.blackFriday.getBlackFridayStatus, {});
    expect(tripped.killGateTripped).toBe(true);
    expect(tripped.killGateReason).toMatch(/bounce 5\.00%/);

    // Clearing is an explicit operator act; the held run can then be discarded.
    await t.mutation(internal.broadcast.blackFriday.clearBlackFridayKillGate, { reason: "investigated" });
    expect((await t.query(internal.broadcast.blackFriday.getBlackFridayStatus, {})).killGateTripped).toBe(false);
    await t.mutation(internal.broadcast.blackFriday.stopBlackFriday, { reason: "pause for review" });
    const stopped = await t.action(internal.broadcast.blackFriday.releaseBlackFridayBroadcast, { runId: held.runId });
    expect(stopped.wouldRefuse).toMatch(/stopped by operator: pause for review/);
  });

  test("a retry after a failed send obeys the stop and the cutoff", async () => {
    const t = newTest();
    await seedAudience(t);
    await t.mutation(internal.broadcast.blackFriday.initBlackFriday, {});
    vi.stubEnv("RESEND_API_KEY", "synthetic-key");
    let sendAttempts = 0;
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/segments")) return Response.json({ id: "seg_1" });
      if (url.endsWith("/broadcasts")) return Response.json({ id: "bro_1" });
      if (url.endsWith("/send")) {
        sendAttempts += 1;
        return sendAttempts === 1 ? new Response("upstream", { status: 500 }) : Response.json({ id: "bro_1" });
      }
      return Response.json({ id: "c" });
    });
    const started = await startReal(t, { version: "lapsed", locale: "en", recipient: "account" });
    await driveToHold(t, started.runId);
    await t.action(internal.broadcast.blackFriday.releaseBlackFridayBroadcast, { runId: started.runId, dryRun: false });
    await expect(t.action(internal.broadcast.waveRuns.finalizeWaveAction, { runId: started.runId })).rejects.toThrow();
    expect(sendAttempts).toBe(1);

    // Stopped: the documented retry sends nothing.
    await t.mutation(internal.broadcast.blackFriday.stopBlackFriday, { reason: "bad copy" });
    await t.mutation(internal.broadcast.waveRuns.resumeFinalizeWaveRun, { runId: started.runId, confirmedNotSent: true });
    expect(await t.action(internal.broadcast.waveRuns.finalizeWaveAction, { runId: started.runId })).toEqual({ ok: false, reason: "campaign-kill-gate-tripped" });
    expect(sendAttempts).toBe(1);

    // Cleared, but now past the cutoff: still nothing.
    await t.mutation(internal.broadcast.blackFriday.clearBlackFridayKillGate, { reason: "fixed" });
    vi.setSystemTime(BLACK_FRIDAY_OFFER.endsAtMs - 60 * 60 * 1000);
    expect(await t.action(internal.broadcast.waveRuns.finalizeWaveAction, { runId: started.runId })).toEqual({ ok: false, reason: "campaign-past-send-cutoff" });
    expect(sendAttempts).toBe(1);

    // Inside the window with the gate clear, the retry goes out.
    vi.setSystemTime(NOW + 60 * 60 * 1000);
    expect(await t.action(internal.broadcast.waveRuns.finalizeWaveAction, { runId: started.runId })).toEqual({ ok: true });
    expect(sendAttempts).toBe(2);
  });

  test("a few delivered emails are too few to trip the gate", async () => {
    const t = newTest();
    await seedAudience(t);
    await t.mutation(internal.broadcast.blackFriday.initBlackFriday, {});
    stubResend();
    const first = await startReal(t, { version: "new-buyer", locale: "en", recipient: "account" });
    await driveToHold(t, first.runId);
    const { broadcastId } = await t.action(internal.broadcast.blackFriday.releaseBlackFridayBroadcast, { runId: first.runId, dryRun: false });
    await t.action(internal.broadcast.waveRuns.finalizeWaveAction, { runId: first.runId });
    await t.run(async (ctx) => {
      await ctx.db.insert("broadcastEvents", { webhookEventId: "d", broadcastId: broadcastId!, eventType: "email.delivered", occurredAt: NOW });
      await ctx.db.insert("broadcastEvents", { webhookEventId: "b", broadcastId: broadcastId!, eventType: "email.bounced", occurredAt: NOW });
    });
    const health = await t.action(internal.broadcast.blackFriday.blackFridayHealth, {});
    expect(health.all).toMatchObject({ delivered: 1, bounced: 1, bounceRate: 1, trusted: false, overThreshold: false });
    expect(health.tripReason).toBeNull();
  });

  test("the waitlist follows the accounts, stamps registrations, and a new account carries the stamp", async () => {
    const t = newTest();
    await seedAudience(t);
    await t.mutation(internal.broadcast.blackFriday.initBlackFriday, {});
    const calls = stubResend();

    await expect(startReal(t, { version: "new-buyer", locale: "en", recipient: "waitlist", count: 100 })).rejects.toThrow(/account holders go first/);
    const accounts = await startReal(t, { version: "new-buyer", locale: "en", recipient: "account" });
    await driveToHold(t, accounts.runId);
    await t.action(internal.broadcast.blackFriday.releaseBlackFridayBroadcast, { runId: accounts.runId, dryRun: false });
    await t.action(internal.broadcast.waveRuns.finalizeWaveAction, { runId: accounts.runId });

    await expect(startReal(t, { version: "new-buyer", locale: "en", recipient: "waitlist" })).rejects.toThrow(/pass a count/);
    await expect(startReal(t, { version: "new-buyer", locale: "en", recipient: "waitlist", count: 501 })).rejects.toThrow(/canary/);
    // A canary of one: the count caps the pick.
    const canary = await startReal(t, { version: "new-buyer", locale: "en", recipient: "waitlist", count: 1 });
    expect(canary).toMatchObject({ picked: 1, toSend: 2 });
    await driveToHold(t, canary.runId);
    const broadcast = calls.filter((c) => c.url.endsWith("/broadcasts")).at(-1)!.body!;
    expect(broadcast.html).toContain("because you joined the WorldMonitor waitlist");
    expect(broadcast.html).toContain("Checkout asks you to create a WorldMonitor account first.");

    const after = await stamps(t);
    const stampedRegs = Object.entries(after.registrations).filter(([, s]) => s.launch !== undefined);
    expect(stampedRegs).toHaveLength(1);
    expect(stampedRegs[0]![1]).toEqual({ launch: "bf-new-buyer-en-waitlist-1", lastDay: undefined, proLaunch: undefined });
    // Account stamps from the first wave are untouched, and no account gained one.
    expect(Object.values(after.users).filter((s) => s.launch !== undefined)).toHaveLength(3);

    await t.action(internal.broadcast.blackFriday.releaseBlackFridayBroadcast, { runId: canary.runId, dryRun: false });
    await t.action(internal.broadcast.waveRuns.finalizeWaveAction, { runId: canary.runId });
    // The next waitlist wave waits for trusted canary stats.
    await expect(startReal(t, { version: "new-buyer", locale: "en", recipient: "waitlist", count: 5000, wave: 2 })).rejects.toThrow(/since the last waitlist wave/);
    vi.setSystemTime(NOW + 19 * 60 * 60 * 1000);
    await expect(startReal(t, { version: "new-buyer", locale: "en", recipient: "waitlist", count: 5000, wave: 2 })).rejects.toThrow(/100 are needed/);

    // The emailed waitlist contact signs up: the account pick sees the registration's stamp.
    const emailed = stampedRegs[0]![0];
    await seedUser(t, "signed-up", { email: emailed });
    const report = await t.action(internal.broadcast.blackFriday.blackFridayAudience, { send: "launch" });
    expect(report.segments["new-buyer/en/account"]).toEqual({ eligible: 4, alreadySent: 4, toSend: 0 });
    expect(report.segments["new-buyer/en/waitlist"]).toEqual({ eligible: 1, alreadySent: 0, toSend: 1 });
  });

  test("the last-day send has its own stamp, skips converters, and only reminds waitlist contacts the ramp reached", async () => {
    const t = newTest();
    await seedAudience(t);
    await t.mutation(internal.broadcast.blackFriday.initBlackFriday, {});
    stubResend();
    // Launch: the monthly segment and one waitlist contact.
    const launch = await startReal(t, { version: "monthly-switch", locale: "en", recipient: "account" });
    await driveToHold(t, launch.runId);
    await t.action(internal.broadcast.blackFriday.releaseBlackFridayBroadcast, { runId: launch.runId, dryRun: false });
    await t.action(internal.broadcast.waveRuns.finalizeWaveAction, { runId: launch.runId });
    await t.run(async (ctx) => {
      const reg = await ctx.db.query("registrations").withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", "wait-1@example.com")).first();
      await ctx.db.patch(reg!._id, { blackFridayLaunchWave: "bf-new-buyer-en-waitlist-1", blackFridayLaunchWaveAssignedAt: NOW });
      // monthly-de switched to Pro Yearly during the offer.
      const subscription = await ctx.db.query("subscriptions").withIndex("by_userId", (q) => q.eq("userId", "monthly-de")).first();
      await ctx.db.patch(subscription!._id, { planKey: "pro_annual", currentPeriodStart: NOW + DAY });
    });

    // Not yet the last day.
    await expect(startReal(t, { version: "last-day-switch", locale: "en", recipient: "account" })).rejects.toThrow(/final 24 hours/);

    vi.setSystemTime(LAST_DAY);
    const report = await t.action(internal.broadcast.blackFriday.blackFridayAudience, { send: "last-day" });
    // The launch stamp does not block the reminder.
    expect(report.segments["last-day-switch/en/account"]).toEqual({ eligible: 1, alreadySent: 0, toSend: 1 });
    expect(report.segments["last-day-switch/de/account"]).toBeUndefined();
    expect(report.excluded.accounts["converted-during-offer"]).toBe(2);
    expect(report.segments["last-day/en/account"]).toEqual({ eligible: 4, alreadySent: 0, toSend: 4 });
    expect(report.segments["last-day/en/waitlist"]).toEqual({ eligible: 1, alreadySent: 0, toSend: 1 });
    expect(report.waitlistNotYetEmailed).toBe(2);

    // Launch versions stop on the last day.
    await expect(startReal(t, { version: "lapsed", locale: "en", recipient: "account" })).rejects.toThrow(/last-day versions/);
    const reminder = await startReal(t, { version: "last-day-switch", locale: "en", recipient: "account" });
    await driveToHold(t, reminder.runId);
    expect((await stamps(t)).users["monthly-en"]).toEqual({ launch: "bf-monthly-switch-en-account-1", lastDay: "bf-last-day-switch-en-account-1" });

    // Past the cutoff nothing is released.
    vi.setSystemTime(BLACK_FRIDAY_OFFER.endsAtMs - 30 * 60 * 1000);
    await expect(
      t.action(internal.broadcast.blackFriday.releaseBlackFridayBroadcast, { runId: reminder.runId, dryRun: false }),
    ).rejects.toThrow(/end of the offer/);
  });

  test("eligibility is re-checked as contacts are exported: a buyer or unsubscriber since the pick is left out", async () => {
    const t = newTest();
    await seedAudience(t);
    await t.mutation(internal.broadcast.blackFriday.initBlackFriday, {});
    const calls = stubResend();
    const started = await startReal(t, { version: "new-buyer", locale: "en", recipient: "account" });
    expect(started.picked).toBe(3);
    // Between the pick and the push: one buys Pro Yearly, one unsubscribes.
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: "free-en-1", dodoSubscriptionId: "sub_new", dodoProductId: "pdt_pro_annual", planKey: "pro_annual",
        status: "active", currentPeriodStart: NOW, currentPeriodEnd: NOW + 365 * DAY, rawPayload: {}, updatedAt: NOW,
      });
      await ctx.db.insert("emailSuppressions", { normalizedEmail: "free-en-2@example.com", reason: "unsubscribe", suppressedAt: NOW });
    });
    await driveToHold(t, started.runId);
    expect(count(calls, "/contacts")).toBe(1);
    const status = await t.query(internal.broadcast.blackFriday.getBlackFridayStatus, {});
    expect(status.runs[0]).toMatchObject({ pushedCount: 1, suppressedCount: 2, failedCount: 0, held: true });
    const after = await stamps(t);
    expect(after.users["free-en-1"]!.launch).toBeUndefined();
    expect(after.users["free-en-2"]!.launch).toBeUndefined();
    expect(after.users["free-zh-tw"]!.launch).toBe("bf-new-buyer-en-account-1");
  });

  test("a wave whose every contact became ineligible is not released", async () => {
    const t = newTest();
    await seedAudience(t);
    await t.mutation(internal.broadcast.blackFriday.initBlackFriday, {});
    const calls = stubResend();
    const started = await startReal(t, { version: "lapsed", locale: "en", recipient: "account" });
    await t.run(async (ctx) => {
      await ctx.db.insert("emailSuppressions", { normalizedEmail: "lapsed-en@example.com", reason: "complaint", suppressedAt: NOW });
    });
    await driveToHold(t, started.runId);
    expect(count(calls, "/contacts")).toBe(0);
    await expect(
      t.action(internal.broadcast.blackFriday.releaseBlackFridayBroadcast, { runId: started.runId, dryRun: false }),
    ).rejects.toThrow(/segment is empty/);
    expect(calls.some((c) => c.url.endsWith("/send"))).toBe(false);
  });

  test("one failed push does not fail a small campaign wave", async () => {
    const t = newTest();
    await seedAudience(t);
    await t.mutation(internal.broadcast.blackFriday.initBlackFriday, {});
    vi.stubEnv("RESEND_API_KEY", "synthetic-key");
    let contactCalls = 0;
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/segments")) return Response.json({ id: "seg_1" });
      if (url.endsWith("/broadcasts")) return Response.json({ id: "bro_1" });
      contactCalls += 1;
      // 400 is permanent: no retry.
      return contactCalls === 1 ? new Response("bad", { status: 400 }) : Response.json({ id: "c" });
    });
    const started = await startReal(t, { version: "new-buyer", locale: "en", recipient: "account" });
    await driveToHold(t, started.runId);
    const status = await t.query(internal.broadcast.blackFriday.getBlackFridayStatus, {});
    expect(status.runs[0]).toMatchObject({ status: "broadcast-created", pushedCount: 2, failedCount: 1, held: true });
    // The contact whose push failed is not stamped, so a later wave can pick it up.
    expect(Object.values((await stamps(t)).users).filter((s) => s.launch !== undefined)).toHaveLength(2);
  });
});
