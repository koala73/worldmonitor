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
import { hasTabFocus } from "../shared/tab-focus-access";
import { getFeaturesForPlan, mergeEntitlementFeatures } from "./lib/entitlements";

export const MAX_TEAM_DASHBOARDS_PER_VARIANT = 25;
export const TEAM_DASHBOARD_NAME_MAX_LENGTH = 40;

type ReadCtx = QueryCtx | MutationCtx;

/**
 * Whether a layout uses the focus feature (#10453): a scope, or panel choices
 * that only a focus-aware client applies. It is gated on publish by `tabFocus`
 * and left out of the list for a client that does not render it.
 */
function usesFocusFeatures(layout: { scope?: unknown; panelFilters?: readonly unknown[] }): boolean {
  return layout.scope !== undefined || (layout.panelFilters?.length ?? 0) > 0;
}
export type TeamKind = "business" | "enterprise";
/**
 * `planKey` is the plan that makes this a team: "enterprise", or the API
 * Business subscription's plan. `seat` is true when the caller is on the team
 * through a seat grant rather than as the subscriber or an Enterprise member.
 */
type Team = { key: string; kind: TeamKind; planKey: string; seat: boolean };

/**
 * The caller's team, or null. The order matches the entitlement recompute:
 * an Enterprise account with a live contract first, then the caller's own
 * covering API Business subscription, then a seat they hold on someone
 * else's.
 */
export async function resolveTeam(ctx: ReadCtx, userId: string, now: number): Promise<Team | null> {
  const account = await liveMemberAccount(ctx, userId, now);
  if (account) return { key: `enterprise:${account._id}`, kind: "enterprise", planKey: "enterprise", seat: false };

  const ownSubs = await ctx.db
    .query("subscriptions")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();
  const own = ownSubs.find((s) => isBusinessPlan(s.planKey) && isCoveringAt(s, now));
  if (own) return { key: `business:${own.dodoSubscriptionId}`, kind: "business", planKey: own.planKey, seat: false };

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
      return { key: `business:${grant.businessSubscriptionId}`, kind: "business", planKey: sub.planKey, seat: true };
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

/**
 * Whether the caller may publish a focused dashboard (#10453).
 *
 * The caller's own merged entitlement decides, read the way
 * convex/embedKeys.ts reads it: merged with the catalog first, because rows
 * written before `tabFocus` existed omit it and the predicate is fail-closed.
 *
 * A seat holder is the exception. The seat grant writes a Pro entitlement
 * (pickBestAcceptedBusinessGrant in payments/subscriptionHelpers.ts), and Pro
 * has no focus, yet sharing a focused dashboard is sold with the API Business
 * team the seat belongs to. So for a seat the team's plan decides, read from
 * the catalog; resolveTeam has already proved that plan covering.
 */
async function callerHasTabFocus(ctx: ReadCtx, userId: string, team: Team, now: number): Promise<boolean> {
  // validUntil = now: resolveTeam only returns a seat whose parent plan covers now.
  if (team.seat && hasTabFocus({ features: getFeaturesForPlan(team.planKey), validUntil: now }, now)) return true;
  const entitlement = await ctx.db
    .query("entitlements")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .first();
  if (!entitlement) return false;
  return hasTabFocus(
    { features: mergeEntitlementFeatures(entitlement.planKey, entitlement.features), validUntil: entitlement.validUntil },
    now,
  );
}

async function requireTeam(ctx: MutationCtx, now: number): Promise<{ userId: string; team: Team }> {
  const userId = await requireUserId(ctx);
  await assertAccountWritable(ctx, userId);
  const team = await resolveTeam(ctx, userId, now);
  if (!team) throw new ConvexError({ kind: "NOT_ON_A_TEAM" });
  return { userId, team };
}

/**
 * The caller's team and its dashboards for one dashboard variant. A signed-out
 * caller or one without a team gets `team: null` and no dashboards, never an
 * error, so the client can ask on every load.
 *
 * `capabilities` names what the calling client can render. Without "focus"
 * (every client older than #10453 omits the argument), focused dashboards are
 * left out: an older client would open one as an unfiltered world view with
 * no sign that a focus was set. `team.focus` says whether this caller may
 * publish a focused dashboard.
 */
export const listForVariant = query({
  args: { variant: v.string(), capabilities: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx);
    if (!userId || !isPreferenceVariant(args.variant)) return { team: null, dashboards: [] };
    const now = Date.now();
    const team = await resolveTeam(ctx, userId, now);
    if (!team) return { team: null, dashboards: [] };
    const rendersFocus = args.capabilities?.includes("focus") === true;
    // Filtered after take(): the cap bounds the stored rows per team and
    // variant, so an older client simply sees fewer than the cap.
    const rows = (await ctx.db
      .query("teamDashboards")
      .withIndex("by_team_variant", (q) => q.eq("teamKey", team.key).eq("variant", args.variant))
      .take(MAX_TEAM_DASHBOARDS_PER_VARIANT))
      .filter((row) => rendersFocus || !usesFocusFeatures(row.layout));
    return {
      team: { kind: team.kind, focus: await callerHasTabFocus(ctx, userId, team, now) },
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
    const { userId, team } = await requireTeam(ctx, now);
    // Any publish that carries a focus needs the entitlement, including an
    // update that resends a focus a teammate set.
    if (usesFocusFeatures(args.layout) && !await callerHasTabFocus(ctx, userId, team, now)) {
      throw new ConvexError({ kind: "FOCUS_NOT_ENTITLED" });
    }

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
    const { team } = await requireTeam(ctx, Date.now());
    const row = await ctx.db.get(args.dashboardId);
    if (!row || row.teamKey !== team.key) throw new ConvexError({ kind: "DASHBOARD_NOT_FOUND" });
    await ctx.db.delete(row._id);
    return { ok: true as const };
  },
});
