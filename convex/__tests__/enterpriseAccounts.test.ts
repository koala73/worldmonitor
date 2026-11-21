import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import { getFeaturesForPlan } from "../lib/entitlements";

const modules = import.meta.glob("../**/*.ts");

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CONTRACT_END = NOW + 365 * DAY_MS;
const ALICE = "user_hexion_alice";
const BOB = "user_hexion_bob";
const CAROL = "user_hexion_carol";

const fns = internal.enterpriseAccounts;

const BASE_ACCOUNT = {
  name: "Hexion",
  contractStart: NOW - DAY_MS,
  contractEnd: CONTRACT_END,
  dailyRequestAllowance: 50_000,
  perMinuteBurst: 300,
  monthlyInputTokens: 50_000_000,
  monthlyOutputTokens: 5_000_000,
  overagePerThousandRequestsUsd: 2,
  overagePerMillionInputTokensUsd: 4,
  overagePerMillionOutputTokensUsd: 20,
  seatCap: 3,
  allowedProviders: ["anthropic"],
};

type T = ReturnType<typeof convexTest>;

async function createAccount(t: T, overrides: Partial<typeof BASE_ACCOUNT> & { breakerMultiple?: number } = {}) {
  const { accountId } = await t.mutation(fns.createAccount, { ...BASE_ACCOUNT, ...overrides });
  return accountId as Id<"enterpriseAccounts">;
}

async function entitlementRow(t: T, userId: string) {
  return t.run((ctx) => ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", userId)).first());
}

async function scheduledFor(t: T, name: string) {
  return (await scheduledJobsFor(t, name)).map((job) => job.userId);
}

/** Each scheduled call of `name` with its delay from when it was scheduled. */
async function scheduledJobsFor(t: T, name: string) {
  const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return jobs
    .filter((job) => job.name === name)
    .map((job) => ({
      userId: (job.args[0] as { userId?: string }).userId,
      delayMs: Math.round(job.scheduledTime - job._creationTime),
    }));
}

// The delayed routing-cache delete must land after any edge lookup that read
// Convex before the change committed (the entitlement resync's delay).
const ROUTING_RESYNC_DELAY_MS = 15_000;

beforeEach(() => {
  // Cache actions no-op without Upstash credentials.
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("enterprise account validation", () => {
  test("createAccount stores the contract and defaults the breaker multiple to 5", async () => {
    const t = convexTest(schema, modules);
    const accountId = await createAccount(t);
    const { account, members } = (await t.query(fns.getAccountWithMembers, { accountId }))!;
    expect(account).toMatchObject({ ...BASE_ACCOUNT, breakerMultiple: 5 });
    expect(members).toEqual([]);
  });

  test("createAccount rejects bad inputs", async () => {
    const t = convexTest(schema, modules);
    const cases: Array<[Partial<typeof BASE_ACCOUNT> & { breakerMultiple?: number }, RegExp]> = [
      [{ contractEnd: BASE_ACCOUNT.contractStart }, /contractEnd must be after contractStart/],
      [{ seatCap: 0 }, /seatCap must be a positive integer/],
      [{ dailyRequestAllowance: 1.5 }, /dailyRequestAllowance must be a positive integer/],
      [{ monthlyInputTokens: -1 }, /monthlyInputTokens must be a positive integer/],
      [{ breakerMultiple: 0 }, /breakerMultiple must be a positive integer/],
      [{ overagePerMillionOutputTokensUsd: -0.01 }, /overagePerMillionOutputTokensUsd must be a non-negative number/],
      [{ allowedProviders: [] }, /at least one provider/],
      [{ allowedProviders: ["anthropc"] }, /Unknown AI provider/],
      [{ name: "  " }, /name is required/],
    ];
    for (const [override, message] of cases) {
      await expect(t.mutation(fns.createAccount, { ...BASE_ACCOUNT, ...override })).rejects.toThrow(message);
    }
    expect(await t.run((ctx) => ctx.db.query("enterpriseAccounts").collect())).toHaveLength(0);
  });

  test("updateAccount validates the merged contract and rejects a seat cap below current seats", async () => {
    const t = convexTest(schema, modules);
    const accountId = await createAccount(t, { seatCap: 2 });
    await t.mutation(fns.addMemberByUserId, { accountId, userId: ALICE });
    await t.mutation(fns.addMemberByUserId, { accountId, userId: BOB });
    await expect(t.mutation(fns.updateAccount, { accountId, contractEnd: BASE_ACCOUNT.contractStart - 1 }))
      .rejects.toThrow(/contractEnd must be after contractStart/);
    await expect(t.mutation(fns.updateAccount, { accountId, seatCap: 1 })).rejects.toThrow(/SEAT_CAP_BELOW_MEMBERS/);
    await t.mutation(fns.updateAccount, { accountId, seatCap: 4, perMinuteBurst: 600 });
    const { account } = (await t.query(fns.getAccountWithMembers, { accountId }))!;
    expect(account).toMatchObject({ seatCap: 4, perMinuteBurst: 600 });
  });
});

describe("membership as an entitlement source", () => {
  test("a member with no other entitlement resolves to Enterprise until the contract end", async () => {
    const t = convexTest(schema, modules);
    const accountId = await createAccount(t);
    await t.mutation(fns.addMemberByUserId, { accountId, userId: ALICE });
    const row = await entitlementRow(t, ALICE);
    expect(row?.planKey).toBe("enterprise");
    expect(row?.validUntil).toBe(CONTRACT_END);
    const ent = await t.query(internal.entitlements.getEntitlementsByUserId, { userId: ALICE });
    expect(ent.planKey).toBe("enterprise");
    expect(ent.validUntil).toBe(CONTRACT_END);
  });

  test("a member with an api_starter subscription resolves to Enterprise and falls back on removal", async () => {
    const t = convexTest(schema, modules);
    const subEnd = NOW + 20 * DAY_MS;
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: ALICE,
        dodoSubscriptionId: "sub_alice_starter",
        dodoProductId: PRODUCT_CATALOG.api_starter.dodoProductId!,
        planKey: "api_starter",
        status: "active",
        currentPeriodStart: NOW - 10 * DAY_MS,
        currentPeriodEnd: subEnd,
        rawPayload: {},
        updatedAt: NOW - 10 * DAY_MS,
      });
    });
    await t.mutation(internal.payments.subscriptionHelpers.recomputeEntitlementForUser, { userId: ALICE });
    expect((await entitlementRow(t, ALICE))?.planKey).toBe("api_starter");

    const accountId = await createAccount(t);
    await t.mutation(fns.addMemberByUserId, { accountId, userId: ALICE });
    expect((await entitlementRow(t, ALICE))?.planKey).toBe("enterprise");

    await t.mutation(fns.removeMember, { accountId, userId: ALICE });
    const after = await entitlementRow(t, ALICE);
    expect(after?.planKey).toBe("api_starter");
    expect(after?.validUntil).toBe(subEnd);
  });

  test("a contract that has not started or has ended is not an entitlement source", async () => {
    const t = convexTest(schema, modules);
    const future = await createAccount(t, { name: "Future", contractStart: NOW + 10 * DAY_MS, contractEnd: NOW + 400 * DAY_MS });
    const ended = await createAccount(t, { name: "Ended", contractStart: NOW - 400 * DAY_MS, contractEnd: NOW - DAY_MS });
    await t.mutation(fns.addMemberByUserId, { accountId: future, userId: ALICE });
    await t.mutation(fns.addMemberByUserId, { accountId: ended, userId: BOB });
    for (const userId of [ALICE, BOB]) {
      const ent = await t.query(internal.entitlements.getEntitlementsByUserId, { userId });
      expect(ent.planKey).toBe("free");
      expect("account" in ent).toBe(false);
    }
  });

  test("a member of a future contract becomes Enterprise when the contract starts", async () => {
    const t = convexTest(schema, modules);
    const start = NOW + 10 * DAY_MS;
    const accountId = await createAccount(t, { contractStart: start, contractEnd: start + 365 * DAY_MS });
    await t.mutation(fns.addMemberByUserId, { accountId, userId: ALICE });
    expect((await t.query(internal.entitlements.getEntitlementsByUserId, { userId: ALICE })).planKey).toBe("free");
    vi.setSystemTime(start + 1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const row = await entitlementRow(t, ALICE);
    expect(row?.planKey).toBe("enterprise");
    expect(row?.validUntil).toBe(start + 365 * DAY_MS);
  });

  test("at contract end a member with a longer api_starter subscription falls back to it", async () => {
    const t = convexTest(schema, modules);
    const subEnd = CONTRACT_END + 30 * DAY_MS;
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: ALICE,
        dodoSubscriptionId: "sub_alice_starter_long",
        dodoProductId: PRODUCT_CATALOG.api_starter.dodoProductId!,
        planKey: "api_starter",
        status: "active",
        currentPeriodStart: NOW - 10 * DAY_MS,
        currentPeriodEnd: subEnd,
        rawPayload: {},
        updatedAt: NOW - 10 * DAY_MS,
      });
    });
    const accountId = await createAccount(t);
    await t.mutation(fns.addMemberByUserId, { accountId, userId: ALICE });
    expect((await entitlementRow(t, ALICE))?.planKey).toBe("enterprise");
    expect(await t.query(fns.getLiveAccountBlockByUserId, { userId: ALICE })).not.toBeNull();

    // No mutation runs here: the scheduled jobs due at the contract end (the
    // account's end job and the member's coverage recheck) recompute it.
    vi.setSystemTime(CONTRACT_END + 1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const row = await entitlementRow(t, ALICE);
    expect(row?.planKey).toBe("api_starter");
    expect(row?.validUntil).toBe(subEnd);
    expect(await t.query(fns.getLiveAccountBlockByUserId, { userId: ALICE })).toBeNull();
    const ent = await t.query(internal.entitlements.getEntitlementsByUserId, { userId: ALICE });
    expect(ent.planKey).toBe("api_starter");
    expect("account" in ent).toBe(false);
  });

  test("moving contractEnd earlier cancels the old end job and schedules one at the new end", async () => {
    const t = convexTest(schema, modules);
    const accountId = await createAccount(t);
    const before = await t.run((ctx) => ctx.db.get(accountId));
    const oldJobId = before!.contractEndJobId!;
    const oldJob = await t.run((ctx) => ctx.db.system.get(oldJobId));
    expect(oldJob).toMatchObject({ scheduledTime: CONTRACT_END, state: { kind: "pending" } });

    const newEnd = NOW + 30 * DAY_MS;
    await t.mutation(fns.updateAccount, { accountId, contractEnd: newEnd });

    const after = await t.run((ctx) => ctx.db.get(accountId));
    expect(after!.contractEndJobId).toBeDefined();
    expect(after!.contractEndJobId).not.toBe(oldJobId);
    expect((await t.run((ctx) => ctx.db.system.get(oldJobId)))?.state.kind).toBe("canceled");
    const newJob = await t.run((ctx) => ctx.db.system.get(after!.contractEndJobId!));
    expect(newJob).toMatchObject({
      name: "enterpriseAccounts:recomputeAccountMembers",
      scheduledTime: newEnd,
      state: { kind: "pending" },
      args: [{ accountId }],
    });
    const pendingEndJobs = (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect()))
      .filter((job) => job.name === "enterpriseAccounts:recomputeAccountMembers" && job.state.kind === "pending");
    expect(pendingEndJobs.map((job) => job.scheduledTime)).toEqual([newEnd]);
  });

  test("a user cannot be an active member of two accounts", async () => {
    const t = convexTest(schema, modules);
    const first = await createAccount(t);
    const second = await createAccount(t, { name: "Other" });
    await t.mutation(fns.addMemberByUserId, { accountId: first, userId: ALICE });
    await expect(t.mutation(fns.addMemberByUserId, { accountId: second, userId: ALICE }))
      .rejects.toThrow(/ALREADY_MEMBER_OF_ANOTHER_ACCOUNT/);
    // Re-adding to the same account is idempotent.
    const again = await t.mutation(fns.addMemberByUserId, { accountId: first, userId: ALICE });
    expect(again.status).toBe("already_active");
  });
});

describe("seat cap", () => {
  test("active plus pending seats count against the cap", async () => {
    const t = convexTest(schema, modules);
    const accountId = await createAccount(t, { seatCap: 2 });
    await t.mutation(fns.addMemberByUserId, { accountId, userId: ALICE });
    await t.run(async (ctx) => {
      await ctx.db.insert("enterpriseMembers", {
        accountId,
        email: "pending@hexion.test",
        status: "pending",
        role: "member",
        invitedAt: NOW,
        updatedAt: NOW,
      });
    });
    await expect(t.mutation(fns.addMemberByUserId, { accountId, userId: BOB })).rejects.toThrow(/SEAT_CAP_REACHED/);
    expect((await entitlementRow(t, BOB))).toBeNull();
    // A removed seat frees the slot.
    await t.mutation(fns.removeMember, { accountId, userId: ALICE });
    await t.mutation(fns.addMemberByUserId, { accountId, userId: BOB });
  });

  test("two concurrent adds cannot exceed the cap", async () => {
    const t = convexTest(schema, modules);
    const accountId = await createAccount(t, { seatCap: 1 });
    const results = await Promise.allSettled([
      t.mutation(fns.addMemberByUserId, { accountId, userId: ALICE }),
      t.mutation(fns.addMemberByUserId, { accountId, userId: BOB }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/SEAT_CAP_REACHED/);
    const active = await t.run((ctx) => ctx.db.query("enterpriseMembers").collect());
    expect(active.filter((m) => m.status === "active")).toHaveLength(1);
    // Every seat change wrote the account's lock row (the OCC serialization point).
    const locks = await t.run((ctx) => ctx.db.query("enterpriseAccountLocks").collect());
    expect(locks).toHaveLength(1);
    expect(locks[0]!.accountId).toBe(accountId);
  });
});

describe("admin role", () => {
  test("setAdmin requires an active member and replaces the previous admin", async () => {
    const t = convexTest(schema, modules);
    const accountId = await createAccount(t);
    await expect(t.mutation(fns.setAdmin, { accountId, userId: ALICE })).rejects.toThrow(/ADMIN_MUST_BE_ACTIVE_MEMBER/);
    await t.mutation(fns.addMemberByUserId, { accountId, userId: ALICE });
    await t.mutation(fns.addMemberByUserId, { accountId, userId: BOB });
    await t.mutation(fns.setAdmin, { accountId, userId: ALICE });
    await t.mutation(fns.setAdmin, { accountId, userId: BOB });
    const { members } = (await t.query(fns.getAccountWithMembers, { accountId }))!;
    const roles = Object.fromEntries(members.map((m) => [m.userId, m.role]));
    expect(roles).toEqual({ [ALICE]: "member", [BOB]: "admin" });
    await t.mutation(fns.removeMember, { accountId, userId: BOB });
    await expect(t.mutation(fns.setAdmin, { accountId, userId: BOB })).rejects.toThrow(/ADMIN_MUST_BE_ACTIVE_MEMBER/);
  });

  test("removing a non-member is rejected", async () => {
    const t = convexTest(schema, modules);
    const accountId = await createAccount(t);
    await expect(t.mutation(fns.removeMember, { accountId, userId: CAROL })).rejects.toThrow(/NOT_A_MEMBER/);
  });
});

describe("AI routing inherited from the account", () => {
  test("a member without a per-user row gets the account's providers, account id and token limits", async () => {
    const t = convexTest(schema, modules);
    const accountId = await createAccount(t);
    await t.mutation(fns.addMemberByUserId, { accountId, userId: ALICE });
    expect(await t.query(internal.entitlements.getAiRoutingPolicyByUserId, { userId: ALICE })).toEqual({
      allowedProviders: ["anthropic"],
      accountId,
      monthlyInputTokens: BASE_ACCOUNT.monthlyInputTokens,
      monthlyOutputTokens: BASE_ACCOUNT.monthlyOutputTokens,
      breakerMultiple: 5,
    });
  });

  test("a per-user row's providers win; the account id stays attached", async () => {
    const t = convexTest(schema, modules);
    const accountId = await createAccount(t, { allowedProviders: ["anthropic", "openrouter"] });
    await t.mutation(fns.addMemberByUserId, { accountId, userId: ALICE });
    await t.mutation(internal.entitlements.setAiRoutingPolicy, {
      userId: ALICE, allowedProviders: ["anthropic"], reason: "per-user clause",
    });
    const policy = await t.query(internal.entitlements.getAiRoutingPolicyByUserId, { userId: ALICE });
    expect(policy?.allowedProviders).toEqual(["anthropic"]);
    expect(policy).toMatchObject({ accountId });
  });

  test("a broader per-user row cannot widen an account's providers", async () => {
    const t = convexTest(schema, modules);
    const accountId = await createAccount(t, { allowedProviders: ["anthropic"] });
    await t.mutation(fns.addMemberByUserId, { accountId, userId: ALICE });
    await t.mutation(internal.entitlements.setAiRoutingPolicy, {
      userId: ALICE, allowedProviders: ["anthropic", "openrouter"], reason: "stale broader row",
    });
    const policy = await t.query(internal.entitlements.getAiRoutingPolicyByUserId, { userId: ALICE });
    expect(policy?.allowedProviders).toEqual(["anthropic"]);
    expect(policy).toMatchObject({ accountId });
  });

  test("a per-user row disjoint from the account allows no provider", async () => {
    const t = convexTest(schema, modules);
    const accountId = await createAccount(t, { allowedProviders: ["anthropic"] });
    await t.mutation(fns.addMemberByUserId, { accountId, userId: ALICE });
    await t.mutation(internal.entitlements.setAiRoutingPolicy, {
      userId: ALICE, allowedProviders: ["openrouter"], reason: "disjoint row",
    });
    const policy = await t.query(internal.entitlements.getAiRoutingPolicyByUserId, { userId: ALICE });
    expect(policy?.allowedProviders).toEqual([]);
  });

  test("a removed member has no policy; a member of an ended contract keeps it", async () => {
    const t = convexTest(schema, modules);
    const live = await createAccount(t);
    const ended = await createAccount(t, { name: "Ended", contractStart: NOW - 400 * DAY_MS, contractEnd: NOW - DAY_MS });
    await t.mutation(fns.addMemberByUserId, { accountId: live, userId: ALICE });
    await t.mutation(fns.removeMember, { accountId: live, userId: ALICE });
    expect(await t.query(internal.entitlements.getAiRoutingPolicyByUserId, { userId: ALICE })).toBeNull();

    await t.mutation(fns.addMemberByUserId, { accountId: ended, userId: BOB });
    expect(await t.query(internal.entitlements.getAiRoutingPolicyByUserId, { userId: BOB }))
      .toMatchObject({ allowedProviders: ["anthropic"], accountId: ended });
    // A contract that later ends keeps routing its members.
    await t.mutation(fns.addMemberByUserId, { accountId: live, userId: CAROL });
    vi.setSystemTime(CONTRACT_END + DAY_MS);
    expect(await t.query(internal.entitlements.getAiRoutingPolicyByUserId, { userId: CAROL }))
      .toMatchObject({ allowedProviders: ["anthropic"], accountId: live });
  });

  test("the HTTP routing endpoint serves the account policy to the edge", async () => {
    vi.stubEnv("CONVEX_SERVER_SHARED_SECRET", "test-secret-enterprise-routing-55aa");
    const t = convexTest(schema, modules);
    const accountId = await createAccount(t);
    await t.mutation(fns.addMemberByUserId, { accountId, userId: ALICE });
    const res = await t.fetch("/api/internal-ai-routing-policy", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-convex-shared-secret": "test-secret-enterprise-routing-55aa" },
      body: JSON.stringify({ userId: ALICE }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { policy: { allowedProviders: string[]; accountId: string } };
    expect(body.policy.allowedProviders).toEqual(["anthropic"]);
    expect(body.policy.accountId).toBe(accountId);
  });

  test("editing an account schedules routing and entitlement cache deletes for every member", async () => {
    const t = convexTest(schema, modules);
    const accountId = await createAccount(t);
    await t.mutation(fns.addMemberByUserId, { accountId, userId: ALICE });
    await t.mutation(fns.addMemberByUserId, { accountId, userId: BOB });
    await t.mutation(fns.addMemberByUserId, { accountId, userId: CAROL });
    await t.mutation(fns.removeMember, { accountId, userId: CAROL });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const routingBefore = (await scheduledFor(t, "payments/cacheActions:deleteAiRoutingPolicyCache")).length;
    const entBefore = (await scheduledFor(t, "payments/cacheActions:deleteEntitlementCache")).length;

    await t.mutation(fns.updateAccount, { accountId, allowedProviders: ["anthropic", "openrouter"] });

    const routing = (await scheduledJobsFor(t, "payments/cacheActions:deleteAiRoutingPolicyCache")).slice(routingBefore);
    const ents = (await scheduledFor(t, "payments/cacheActions:deleteEntitlementCache")).slice(entBefore);
    // Immediately, and again after the resync delay for a stale re-cache.
    expect(routing.filter((job) => job.delayMs < 1_000).map((job) => job.userId).sort()).toEqual([ALICE, BOB]);
    expect(routing.filter((job) => job.delayMs === ROUTING_RESYNC_DELAY_MS).map((job) => job.userId).sort()).toEqual([ALICE, BOB]);
    expect(routing).toHaveLength(4);
    expect(ents.sort()).toEqual([ALICE, BOB]);
    expect(await t.query(internal.entitlements.getAiRoutingPolicyByUserId, { userId: BOB }))
      .toMatchObject({ allowedProviders: ["anthropic", "openrouter"] });
  });

  test("adding and removing a member schedules both cache deletes for that member", async () => {
    const t = convexTest(schema, modules);
    const accountId = await createAccount(t);
    await t.mutation(fns.addMemberByUserId, { accountId, userId: ALICE });
    await t.mutation(fns.removeMember, { accountId, userId: ALICE });
    // Per change: one immediate delete, and one after the resync delay so an
    // edge lookup that read Convex before the commit cannot re-cache the old
    // decision for the 60 s routing TTL.
    const routing = await scheduledJobsFor(t, "payments/cacheActions:deleteAiRoutingPolicyCache");
    expect(routing.map((job) => job.userId)).toEqual([ALICE, ALICE, ALICE, ALICE]);
    expect(routing.map((job) => job.delayMs).sort((a, b) => a - b))
      .toEqual([expect.any(Number), expect.any(Number), ROUTING_RESYNC_DELAY_MS, ROUTING_RESYNC_DELAY_MS]);
    expect(routing.filter((job) => job.delayMs < 1_000)).toHaveLength(2);
    expect(await scheduledFor(t, "payments/cacheActions:deleteEntitlementCache")).toEqual([ALICE, ALICE]);
  });
});

describe("contract customers get no self-serve plan-limit notices", () => {
  test("a member with high usage is skipped by the plan-limit scan and gets no upgrade notice", async () => {
    const t = convexTest(schema, modules);
    const accountId = await createAccount(t);
    await t.mutation(fns.addMemberByUserId, { accountId, userId: ALICE });
    const summary = await t.action(internal.apiPlanLimitUsage.scanApiPlanLimitUsageInternal, {
      now: NOW,
      rows: [
        { userId: ALICE, planKey: "api_starter", dimension: "api_daily_requests", usage: 5_000, source: "test" },
        { userId: ALICE, planKey: "api_starter", dimension: "mcp_daily_calls", usage: 5_000, source: "test" },
      ],
    });
    expect(summary.notified).toBe(0);
    expect(summary.wouldNotify).toBe(0);
    expect(summary.skipped).toEqual([
      { userId: ALICE, dimension: "api_daily_requests", reason: "enterprise_account_member" },
      { userId: ALICE, dimension: "mcp_daily_calls", reason: "enterprise_account_member" },
    ]);
    expect(await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).toHaveLength(0);
  });

  test("the same usage on a non-member still produces a notice (control)", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: BOB,
        dodoSubscriptionId: "sub_bob_starter",
        dodoProductId: PRODUCT_CATALOG.api_starter.dodoProductId!,
        planKey: "api_starter",
        status: "active",
        currentPeriodStart: NOW - DAY_MS,
        currentPeriodEnd: NOW + 20 * DAY_MS,
        rawPayload: {},
        updatedAt: NOW - DAY_MS,
      });
    });
    await t.mutation(internal.payments.subscriptionHelpers.recomputeEntitlementForUser, { userId: BOB });
    const summary = await t.action(internal.apiPlanLimitUsage.scanApiPlanLimitUsageInternal, {
      now: NOW,
      rows: [{ userId: BOB, planKey: "api_starter", dimension: "api_daily_requests", usage: 5_000, source: "test" }],
    });
    expect(summary.wouldNotify).toBe(1);
  });
});

describe("account block on the edge entitlement (U2)", () => {
  const EXPECTED_BLOCK = (accountId: string) => ({
    id: accountId,
    dailyAllowance: BASE_ACCOUNT.dailyRequestAllowance,
    perMinuteBurst: BASE_ACCOUNT.perMinuteBurst,
    breakerMultiple: 5,
    monthlyInputTokens: BASE_ACCOUNT.monthlyInputTokens,
    monthlyOutputTokens: BASE_ACCOUNT.monthlyOutputTokens,
  });

  test("a member's entitlement carries the account id and limits; a non-member's does not", async () => {
    const t = convexTest(schema, modules);
    const accountId = await createAccount(t);
    await t.mutation(fns.addMemberByUserId, { accountId, userId: ALICE });
    const member = await t.query(internal.entitlements.getEntitlementsByUserId, { userId: ALICE });
    expect(member.account).toEqual(EXPECTED_BLOCK(accountId));
    const outsider = await t.query(internal.entitlements.getEntitlementsByUserId, { userId: BOB });
    expect("account" in outsider).toBe(false);
  });

  test("a member who also holds an Enterprise comp still gets the block", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.payments.billing.grantComplimentaryEntitlement, {
      userId: ALICE, planKey: "enterprise", days: 900,
    });
    const accountId = await createAccount(t);
    await t.mutation(fns.addMemberByUserId, { accountId, userId: ALICE });
    const ent = await t.query(internal.entitlements.getEntitlementsByUserId, { userId: ALICE });
    // The longer comp wins recompute; the block is attached anyway.
    expect(ent.validUntil).toBe(NOW + 900 * DAY_MS);
    expect(ent.account).toEqual(EXPECTED_BLOCK(accountId));
  });

  test("an ended contract carries no block", async () => {
    const t = convexTest(schema, modules);
    const accountId = await createAccount(t);
    await t.mutation(fns.addMemberByUserId, { accountId, userId: ALICE });
    vi.setSystemTime(CONTRACT_END + 1);
    const ent = await t.query(internal.entitlements.getEntitlementsByUserId, { userId: ALICE });
    expect("account" in ent).toBe(false);
  });

  test("the internal-entitlements HTTP action passes the block through", async () => {
    vi.stubEnv("CONVEX_SERVER_SHARED_SECRET", "test-secret-enterprise-ent-77bb");
    const t = convexTest(schema, modules);
    const accountId = await createAccount(t);
    await t.mutation(fns.addMemberByUserId, { accountId, userId: ALICE });
    const res = await t.fetch("/api/internal-entitlements", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-convex-shared-secret": "test-secret-enterprise-ent-77bb" },
      body: JSON.stringify({ userId: ALICE }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { planKey: string; account?: unknown };
    expect(body.planKey).toBe("enterprise");
    expect(body.account).toEqual(EXPECTED_BLOCK(accountId));
  });

  test("the internal-entitlements fallback swap keeps the block", async () => {
    // A member whose stored row still points at a stronger subscription whose
    // period elapsed (tier 0 once read) while a current Pro subscription
    // exists: the HTTP action swaps in the Pro fallback, and the account
    // block, which follows membership rather than the winning plan, must
    // ride along.
    vi.stubEnv("CONVEX_SERVER_SHARED_SECRET", "test-secret-enterprise-ent-88cc");
    const t = convexTest(schema, modules);
    const accountId = await createAccount(t);
    await t.run(async (ctx) => {
      // Inserted directly so no recompute rewrites the stale row.
      await ctx.db.insert("enterpriseMembers", {
        accountId, userId: ALICE, status: "active", role: "member", joinedAt: NOW, updatedAt: NOW,
      });
      await ctx.db.insert("subscriptions", {
        userId: ALICE,
        dodoSubscriptionId: "sub_alice_business_stale",
        dodoProductId: PRODUCT_CATALOG.api_business.dodoProductId!,
        planKey: "api_business",
        status: "active",
        currentPeriodStart: NOW - 31 * DAY_MS,
        currentPeriodEnd: NOW - DAY_MS,
        renewalVerificationState: "pending",
        renewalVerificationAttemptAt: NOW,
        rawPayload: {},
        updatedAt: NOW - DAY_MS,
      });
      await ctx.db.insert("subscriptions", {
        userId: ALICE,
        dodoSubscriptionId: "sub_alice_pro_current",
        dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: NOW - DAY_MS,
        currentPeriodEnd: NOW + 30 * DAY_MS,
        rawPayload: {},
        updatedAt: NOW,
      });
      await ctx.db.insert("entitlements", {
        userId: ALICE,
        planKey: "api_business",
        features: getFeaturesForPlan("api_business"),
        validUntil: NOW - DAY_MS,
        updatedAt: NOW - DAY_MS,
      });
    });
    const res = await t.fetch("/api/internal-entitlements", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-convex-shared-secret": "test-secret-enterprise-ent-88cc" },
      body: JSON.stringify({ userId: ALICE }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { planKey: string; validUntil: number; billingStatus?: string; account?: unknown };
    expect(body.planKey).toBe("pro_monthly");
    expect(body.validUntil).toBe(NOW + 30 * DAY_MS);
    expect(body.billingStatus).toBe("renewal_verification_pending");
    expect(body.account).toEqual(EXPECTED_BLOCK(accountId));
  });

  test("the Redis entitlement cache writers serialize the block", async () => {
    const t = convexTest(schema, modules);
    const accountId = await createAccount(t);
    await t.mutation(fns.addMemberByUserId, { accountId, userId: ALICE });
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://upstash.test");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      urls.push(decodeURIComponent(String(input)));
      return Response.json({ result: "OK" });
    });
    const row = await entitlementRow(t, ALICE);
    await t.action(internal.payments.cacheActions.syncEntitlementCache, {
      userId: ALICE, planKey: row!.planKey, features: row!.features, validUntil: row!.validUntil,
    });
    await t.action(internal.payments.cacheActions.resyncEntitlementCacheFromDb, { userId: ALICE });
    expect(urls).toHaveLength(2);
    for (const url of urls) {
      const value = url.split(`/set/entitlements:test:${ALICE}/`)[1]!.split("/EX/")[0]!;
      expect(JSON.parse(value).account).toEqual(EXPECTED_BLOCK(accountId));
    }
  });
});
