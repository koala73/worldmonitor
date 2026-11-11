/**
 * Team dashboards (convex/teamDashboards.ts): who is on a team, and what a
 * member can list, publish and remove.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import { MAX_TEAM_DASHBOARDS_PER_VARIANT } from "../teamDashboards";
import type { TeamDashboardLayout } from "../lib/teamDashboardLayout";

const modules = import.meta.glob("../**/*.ts");

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
const OWNER = "user_panoptic_owner";
const SEAT = "user_panoptic_seat";
const STRANGER = "user_other_company";
const ENT_ADMIN = "user_ent_admin";
const ENT_MEMBER = "user_ent_member";

const who = (userId: string) => ({ subject: userId, tokenIdentifier: `clerk|${userId}` });

const LAYOUT: TeamDashboardLayout = {
  panels: [
    { key: "live-news", on: true, rows: 2 },
    { key: "markets", on: false },
    { key: "cii", on: true, bottom: true, cols: 2 },
  ],
  map: { view: "mena", zoom: 4, lat: 26.5, lon: 52.1, timeRange: "24h", layers: ["conflicts", "ais"] },
};

type T = ReturnType<typeof convexTest>;

async function seedBusiness(t: T, opts: { status?: "active" | "cancelled" | "expired"; periodEnd?: number; planKey?: string } = {}) {
  const planKey = opts.planKey ?? "api_business";
  await t.run(async (ctx) => {
    await ctx.db.insert("subscriptions", {
      userId: OWNER,
      dodoSubscriptionId: "sub_panoptic",
      dodoProductId: PRODUCT_CATALOG[planKey]!.dodoProductId!,
      planKey,
      status: opts.status ?? "active",
      currentPeriodStart: NOW - DAY_MS,
      currentPeriodEnd: opts.periodEnd ?? NOW + 300 * DAY_MS,
      rawPayload: {},
      updatedAt: NOW,
    });
    await ctx.db.insert("businessProGrants", {
      businessSubscriptionId: "sub_panoptic",
      ownerUserId: OWNER,
      inviteeEmail: "seat@panoptic.example",
      domain: "panoptic.example",
      status: "accepted",
      inviteeUserId: SEAT,
      createdAt: NOW - DAY_MS,
      acceptedAt: NOW - DAY_MS,
      expiresAt: NOW + 13 * DAY_MS,
    });
  });
}

async function seedEnterprise(t: T) {
  const { accountId } = await t.mutation(internal.enterpriseAccounts.createAccount, {
    name: "Hexion",
    contractStart: NOW - DAY_MS,
    contractEnd: NOW + 365 * DAY_MS,
    dailyRequestAllowance: 10_000,
    perMinuteBurst: 300,
    monthlyInputTokens: 15_000_000,
    monthlyOutputTokens: 3_000_000,
    overagePerThousandRequestsUsd: 3,
    overagePerMillionInputTokensUsd: 4,
    overagePerMillionOutputTokensUsd: 20,
    seatCap: 3,
    allowedProviders: ["anthropic"],
  });
  await t.mutation(internal.enterpriseAccounts.addMemberByUserId, { accountId, userId: ENT_ADMIN, role: "admin" });
  await t.mutation(internal.enterpriseAccounts.addMemberByUserId, { accountId, userId: ENT_MEMBER });
  return accountId as Id<"enterpriseAccounts">;
}

const publish = (t: T, userId: string, args: Partial<{ name: string; variant: string; layout: TeamDashboardLayout; dashboardId: Id<"teamDashboards">; baseVersion: number }> = {}) =>
  t.withIdentity(who(userId)).mutation(api.teamDashboards.publish, {
    variant: "full",
    name: "Gulf watch",
    layout: LAYOUT,
    ...args,
  });

const list = (t: T, userId: string, variant = "full") =>
  t.withIdentity(who(userId)).query(api.teamDashboards.listForVariant, { variant });

/** The ConvexError `kind` the call failed with. */
async function errorKind(promise: Promise<unknown>): Promise<string | undefined> {
  const err = await promise.then(() => null, (e: unknown) => e);
  if (!err) throw new Error("expected the call to fail");
  return /"kind":"([A-Z_]+)"/.exec(String((err as Error).message))?.[1];
}

// Enterprise membership changes schedule cache invalidations; fake timers keep
// them from running after the test's transaction closes.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("team membership", () => {
  test("a business subscriber and the teammate on their seat share one team", async () => {
    const t = convexTest(schema, modules);
    await seedBusiness(t);

    const { id } = await publish(t, OWNER);
    const seen = await list(t, SEAT);

    expect(seen.team).toEqual({ kind: "business" });
    expect(seen.dashboards).toEqual([
      { id, name: "Gulf watch", version: 1, updatedAt: expect.any(Number), layout: LAYOUT },
    ]);
  });

  test("a teammate can publish and the subscriber sees it", async () => {
    const t = convexTest(schema, modules);
    await seedBusiness(t);

    await publish(t, SEAT, { name: "Seat layout" });

    expect((await list(t, OWNER)).dashboards.map((d) => d.name)).toEqual(["Seat layout"]);
  });

  test("someone outside the team sees no team and cannot publish", async () => {
    const t = convexTest(schema, modules);
    await seedBusiness(t);
    await publish(t, OWNER);

    expect(await list(t, STRANGER)).toEqual({ team: null, dashboards: [] });
    expect(await errorKind(publish(t, STRANGER))).toBe("NOT_ON_A_TEAM");
  });

  test("a signed-out caller gets no team rather than an error", async () => {
    const t = convexTest(schema, modules);
    await seedBusiness(t);

    expect(await t.query(api.teamDashboards.listForVariant, { variant: "full" })).toEqual({ team: null, dashboards: [] });
  });

  test("the team ends with the business subscription's coverage, for the seat too", async () => {
    const t = convexTest(schema, modules);
    await seedBusiness(t, { status: "cancelled", periodEnd: NOW - DAY_MS });

    expect((await list(t, OWNER)).team).toBeNull();
    expect((await list(t, SEAT)).team).toBeNull();
  });

  test("a revoked seat leaves the team", async () => {
    const t = convexTest(schema, modules);
    await seedBusiness(t);
    await t.run(async (ctx) => {
      const grant = await ctx.db.query("businessProGrants").first();
      await ctx.db.patch(grant!._id, { status: "revoked" });
    });

    expect((await list(t, SEAT)).team).toBeNull();
    expect((await list(t, OWNER)).team).toEqual({ kind: "business" });
  });

  test("a non-business plan is not a team", async () => {
    const t = convexTest(schema, modules);
    await seedBusiness(t, { planKey: "pro_monthly" });

    expect((await list(t, OWNER)).team).toBeNull();
    expect((await list(t, SEAT)).team).toBeNull();
  });

  test("active Enterprise members share one team, separate from a business team", async () => {
    const t = convexTest(schema, modules);
    await seedEnterprise(t);
    await seedBusiness(t);
    await publish(t, OWNER, { name: "Business only" });

    await publish(t, ENT_MEMBER, { name: "Enterprise layout" });

    const seen = await list(t, ENT_ADMIN);
    expect(seen.team).toEqual({ kind: "enterprise" });
    expect(seen.dashboards.map((d) => d.name)).toEqual(["Enterprise layout"]);
  });

  test("Enterprise members leave the team when the contract ends, like their entitlement", async () => {
    const t = convexTest(schema, modules);
    await seedEnterprise(t);
    await publish(t, ENT_MEMBER, { name: "Enterprise layout" });

    vi.setSystemTime(NOW + 366 * DAY_MS);

    expect((await list(t, ENT_MEMBER)).team).toBeNull();
    expect(await errorKind(publish(t, ENT_ADMIN))).toBe("NOT_ON_A_TEAM");
  });

  test("a user on both an Enterprise account and a business seat gets the Enterprise team, as the entitlement does", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedEnterprise(t);
    await seedBusiness(t);
    await t.mutation(internal.enterpriseAccounts.addMemberByUserId, { accountId, userId: SEAT });
    await publish(t, ENT_MEMBER, { name: "Enterprise layout" });

    const seen = await list(t, SEAT);
    expect(seen.team).toEqual({ kind: "enterprise" });
    expect(seen.dashboards.map((d) => d.name)).toEqual(["Enterprise layout"]);
  });

  test("a removed Enterprise member leaves the team", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedEnterprise(t);
    await t.mutation(internal.enterpriseAccounts.removeMember, { accountId, userId: ENT_MEMBER });

    expect((await list(t, ENT_MEMBER)).team).toBeNull();
  });
});

describe("publishing", () => {
  test("dashboards are per dashboard variant and listed by name", async () => {
    const t = convexTest(schema, modules);
    await seedBusiness(t);
    await publish(t, OWNER, { name: "Zulu" });
    await publish(t, OWNER, { name: "Alpha" });
    await publish(t, OWNER, { name: "Finance desk", variant: "finance" });

    expect((await list(t, SEAT)).dashboards.map((d) => d.name)).toEqual(["Alpha", "Zulu"]);
    expect((await list(t, SEAT, "finance")).dashboards.map((d) => d.name)).toEqual(["Finance desk"]);
  });

  test("republishing replaces the layout and name and bumps the version", async () => {
    const t = convexTest(schema, modules);
    await seedBusiness(t);
    const { id } = await publish(t, OWNER);
    const changed: TeamDashboardLayout = { panels: [{ key: "markets", on: true }] };

    const result = await publish(t, SEAT, { dashboardId: id, baseVersion: 1, name: "Gulf watch v2", layout: changed });

    expect(result).toEqual({ id, version: 2 });
    const [row] = (await list(t, OWNER)).dashboards;
    expect(row).toMatchObject({ id, name: "Gulf watch v2", version: 2, layout: changed });
  });

  test("an update without a base version cannot overwrite a teammate's newer layout", async () => {
    const t = convexTest(schema, modules);
    await seedBusiness(t);
    const { id } = await publish(t, OWNER);
    const changed: TeamDashboardLayout = { panels: [{ key: "markets", on: true }] };
    await publish(t, SEAT, { dashboardId: id, baseVersion: 1, name: "Seat's version", layout: changed });

    expect(await errorKind(publish(t, OWNER, { dashboardId: id, name: "Owner's version" })))
      .toBe("VERSION_CONFLICT");
    expect((await list(t, OWNER)).dashboards[0]).toMatchObject({ name: "Seat's version", version: 2, layout: changed });
  });

  test("an update based on an older version is refused, so a teammate's newer layout is not overwritten unseen", async () => {
    const t = convexTest(schema, modules);
    await seedBusiness(t);
    const { id } = await publish(t, OWNER);
    await publish(t, SEAT, { dashboardId: id, baseVersion: 1, name: "Seat's version" });

    expect(await errorKind(publish(t, OWNER, { dashboardId: id, baseVersion: 1, name: "Owner's version" })))
      .toBe("VERSION_CONFLICT");
    expect((await list(t, OWNER)).dashboards[0]).toMatchObject({ name: "Seat's version", version: 2 });

    // Having seen version 2, the owner can still replace it.
    await expect(publish(t, OWNER, { dashboardId: id, baseVersion: 2, name: "Owner's version" }))
      .resolves.toEqual({ id, version: 3 });
  });

  test("a dashboard of another team cannot be overwritten or removed", async () => {
    const t = convexTest(schema, modules);
    await seedBusiness(t);
    await seedEnterprise(t);
    const { id } = await publish(t, OWNER);

    expect(await errorKind(publish(t, ENT_MEMBER, { dashboardId: id }))).toBe("DASHBOARD_NOT_FOUND");
    expect(await errorKind(
      t.withIdentity(who(ENT_MEMBER)).mutation(api.teamDashboards.remove, { dashboardId: id }),
    )).toBe("DASHBOARD_NOT_FOUND");
    expect((await list(t, OWNER)).dashboards).toHaveLength(1);
  });

  test("republishing under another variant is refused", async () => {
    const t = convexTest(schema, modules);
    await seedBusiness(t);
    const { id } = await publish(t, OWNER);

    expect(await errorKind(publish(t, OWNER, { dashboardId: id, variant: "tech" }))).toBe("DASHBOARD_NOT_FOUND");
  });

  test("any member can stop sharing a dashboard", async () => {
    const t = convexTest(schema, modules);
    await seedBusiness(t);
    const { id } = await publish(t, OWNER);

    await t.withIdentity(who(SEAT)).mutation(api.teamDashboards.remove, { dashboardId: id });

    expect((await list(t, OWNER)).dashboards).toEqual([]);
  });

  test(`a team holds at most ${MAX_TEAM_DASHBOARDS_PER_VARIANT} dashboards per variant`, async () => {
    const t = convexTest(schema, modules);
    await seedBusiness(t);
    for (let i = 0; i < MAX_TEAM_DASHBOARDS_PER_VARIANT; i++) await publish(t, OWNER, { name: `Layout ${i}` });

    expect(await errorKind(publish(t, OWNER, { name: "One more" }))).toBe("TEAM_DASHBOARD_LIMIT");
    // Updating an existing one is still allowed at the limit.
    const [first] = (await list(t, OWNER)).dashboards;
    await expect(publish(t, OWNER, { dashboardId: first!.id, baseVersion: first!.version, name: "Renamed" })).resolves.toMatchObject({ version: 2 });
  });

  test.each([
    ["an empty name", { name: "   " }, "INVALID_NAME"],
    ["a name over 40 characters", { name: "x".repeat(41) }, "INVALID_NAME"],
    ["an unknown variant", { variant: "sports" }, "INVALID_VARIANT"],
    ["no panels", { layout: { panels: [] } }, "INVALID_LAYOUT"],
    ["a duplicate panel", { layout: { panels: [{ key: "a", on: true }, { key: "a", on: false }] } }, "INVALID_LAYOUT"],
    ["a panel key with a leading underscore", { layout: { panels: [{ key: "__proto__", on: true }] } }, "INVALID_LAYOUT"],
    ["a fractional span", { layout: { panels: [{ key: "a", on: true, rows: 1.5 }] } }, "INVALID_LAYOUT"],
    ["a row span over 4", { layout: { panels: [{ key: "a", on: true, rows: 5 }] } }, "INVALID_LAYOUT"],
    ["a column span wider than the grid allows", { layout: { panels: [{ key: "a", on: true, cols: 4 }] } }, "INVALID_LAYOUT"],
    ["a latitude past the pole", { layout: { panels: [{ key: "a", on: true }], map: { ...LAYOUT.map!, lat: 91 } } }, "INVALID_LAYOUT"],
    ["a non-finite zoom", { layout: { panels: [{ key: "a", on: true }], map: { ...LAYOUT.map!, zoom: Number.NaN } } }, "INVALID_LAYOUT"],
    ["a malformed layer name", { layout: { panels: [{ key: "a", on: true }], map: { ...LAYOUT.map!, layers: ["bad layer"] } } }, "INVALID_LAYOUT"],
  ] as const)("rejects %s", async (_label, args, kind) => {
    const t = convexTest(schema, modules);
    await seedBusiness(t);

    expect(await errorKind(publish(t, OWNER, args as never))).toBe(kind);
  });

  test("publishing is refused while the account is being deleted", async () => {
    const t = convexTest(schema, modules);
    await seedBusiness(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("accountDeletions", {
        userId: OWNER,
        userIdHash: "a".repeat(64),
        source: "self",
        status: "pending",
        step: "personal",
        startedAt: NOW,
        updatedAt: NOW,
      });
    });

    expect(await errorKind(publish(t, OWNER))).toBe("ACCOUNT_DELETION_IN_PROGRESS");
  });
});
