/**
 * Team dashboards: dashboard layouts a team shares with its own members.
 *
 * A team is an API Business subscription (the subscriber plus the teammates
 * holding an accepted seat grant on it) or an Enterprise account (its active
 * members). The team is always derived from the caller on the server; a client
 * never names one. Every member can publish, update and remove the team's
 * dashboards, so the people who design a layout and the people who monitor
 * with it can be different people on the same team.
 *
 * Rows carry no user identifier: a dashboard belongs to the team, not to the
 * member who last published it.
 */

import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertAccountWritable } from "./accountDeletion/guard";
import { requireUserId, resolveUserId } from "./lib/auth";
import { checkTeamDashboardLayout, teamDashboardLayoutValidator } from "./lib/teamDashboardLayout";
import { isBusinessPlan, isCoveringAt } from "./payments/subscriptionHelpers";
import { liveMemberAccount } from "./lib/enterpriseAccounts";
import { isPreferenceVariant } from "../shared/cloud-preferences-contract";

export const MAX_TEAM_DASHBOARDS_PER_VARIANT = 25;
export const TEAM_DASHBOARD_NAME_MAX_LENGTH = 40;

type ReadCtx = QueryCtx | MutationCtx;
export type TeamKind = "business" | "enterprise";
type Team = { key: string; kind: TeamKind };

/**
 * The caller's team, or null. The order matches the entitlement recompute:
 * an Enterprise account with a live contract first, then the caller's own
 * covering API Business subscription, then a seat they hold on someone
 * else's.
 */
export async function resolveTeam(ctx: ReadCtx, userId: string, now: number): Promise<Team | null> {
  const account = await liveMemberAccount(ctx, userId, now);
  if (account) return { key: `enterprise:${account._id}`, kind: "enterprise" };

  const ownSubs = await ctx.db
    .query("subscriptions")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();
  const own = ownSubs.find((s) => isBusinessPlan(s.planKey) && isCoveringAt(s, now));
  if (own) return { key: `business:${own.dodoSubscriptionId}`, kind: "business" };

  const grants = await ctx.db
    .query("businessProGrants")
    .withIndex("by_inviteeUserId", (q) => q.eq("inviteeUserId", userId))
    .collect();
  for (const grant of grants) {
    if (grant.status !== "accepted") continue;
    const sub = await ctx.db
      .query("subscriptions")
      .withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", grant.businessSubscriptionId))
      .unique();
    // Same rule the entitlement uses: the seat counts only while its parent
    // subscription is both covering and still on the API Business tier.
    if (sub && isBusinessPlan(sub.planKey) && isCoveringAt(sub, now)) {
      return { key: `business:${grant.businessSubscriptionId}`, kind: "business" };
    }
  }
  return null;
}

function checkName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0 || name.length > TEAM_DASHBOARD_NAME_MAX_LENGTH) {
    throw new ConvexError({ kind: "INVALID_NAME" });
  }
  return name;
}

function checkVariant(variant: string): void {
  if (!isPreferenceVariant(variant)) throw new ConvexError({ kind: "INVALID_VARIANT" });
}

async function requireTeam(ctx: MutationCtx, now: number): Promise<Team> {
  const userId = await requireUserId(ctx);
  await assertAccountWritable(ctx, userId);
  const team = await resolveTeam(ctx, userId, now);
  if (!team) throw new ConvexError({ kind: "NOT_ON_A_TEAM" });
  return team;
}

/**
 * The caller's team and its dashboards for one dashboard variant. A signed-out
 * caller or one without a team gets `team: null` and no dashboards, never an
 * error, so the client can ask on every load.
 */
export const listForVariant = query({
  args: { variant: v.string() },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx);
    if (!userId || !isPreferenceVariant(args.variant)) return { team: null, dashboards: [] };
    const team = await resolveTeam(ctx, userId, Date.now());
    if (!team) return { team: null, dashboards: [] };
    const rows = await ctx.db
      .query("teamDashboards")
      .withIndex("by_team_variant", (q) => q.eq("teamKey", team.key).eq("variant", args.variant))
      .take(MAX_TEAM_DASHBOARDS_PER_VARIANT);
    return {
      team: { kind: team.kind },
      dashboards: rows
        .map((row) => ({
          id: row._id,
          name: row.name,
          version: row.version,
          updatedAt: row.updatedAt,
          layout: row.layout,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  },
});

/**
 * Share a layout with the team. Without `dashboardId` it adds a dashboard;
 * with one it replaces that dashboard's layout (and name) and bumps its
 * version, so members who opened it can pull the change.
 */
export const publish = mutation({
  args: {
    variant: v.string(),
    name: v.string(),
    layout: teamDashboardLayoutValidator,
    dashboardId: v.optional(v.id("teamDashboards")),
    // Required on updates: the version the caller last saw. An older one is refused,
    // so nobody replaces a teammate's newer layout without seeing it first.
    baseVersion: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    checkVariant(args.variant);
    const name = checkName(args.name);
    checkTeamDashboardLayout(args.layout);
    const team = await requireTeam(ctx, now);

    if (args.dashboardId) {
      const row = await ctx.db.get(args.dashboardId);
      if (!row || row.teamKey !== team.key || row.variant !== args.variant) {
        throw new ConvexError({ kind: "DASHBOARD_NOT_FOUND" });
      }
      if (args.baseVersion !== row.version) {
        throw new ConvexError({ kind: "VERSION_CONFLICT", version: row.version });
      }
      const version = row.version + 1;
      await ctx.db.patch(row._id, { name, layout: args.layout, version, updatedAt: now });
      return { id: row._id, version };
    }

    const existing = await ctx.db
      .query("teamDashboards")
      .withIndex("by_team_variant", (q) => q.eq("teamKey", team.key).eq("variant", args.variant))
      .take(MAX_TEAM_DASHBOARDS_PER_VARIANT);
    if (existing.length >= MAX_TEAM_DASHBOARDS_PER_VARIANT) {
      throw new ConvexError({ kind: "TEAM_DASHBOARD_LIMIT", limit: MAX_TEAM_DASHBOARDS_PER_VARIANT });
    }
    const id = await ctx.db.insert("teamDashboards", {
      teamKey: team.key,
      variant: args.variant,
      name,
      layout: args.layout,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    return { id, version: 1 };
  },
});

/** Stop sharing a dashboard. Tabs members already opened from it stay. */
export const remove = mutation({
  args: { dashboardId: v.id("teamDashboards") },
  handler: async (ctx, args) => {
    const team = await requireTeam(ctx, Date.now());
    const row = await ctx.db.get(args.dashboardId);
    if (!row || row.teamKey !== team.key) throw new ConvexError({ kind: "DASHBOARD_NOT_FOUND" });
    await ctx.db.delete(row._id);
    return { ok: true as const };
  },
});
