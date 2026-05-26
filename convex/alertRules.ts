import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  query,
} from "./_generated/server";
import { channelTypeValidator, digestModeValidator, quietHoursOverrideValidator, sensitivityValidator } from "./constants";

type DigestMode = "realtime" | "daily" | "twice_daily" | "weekly";
type Sensitivity = "all" | "high" | "critical";

/**
 * Layer-2 entitlement gate: notifications are a PRO feature, but until now
 * the only enforcement was at layer 1 (UI paywall) and layer 3 (relay
 * isUserPro filter). Layer 1 has had at least one hole — a 2026-04-28
 * audit found 7 of 28 enabled `alertRules` rows belonged to free-tier
 * users (`tier=0`, never been PRO). The relay's PRO filter has been
 * masking the bug at delivery time, but it fail-opens on entitlement-
 * service errors and shouldn't be the only line of defense.
 *
 * This helper is the WRITE-PATH gate. Throws ConvexError with structured
 * `{code: "PRO_REQUIRED"}` data so the client can detect it and route to
 * the upgrade flow rather than surface a generic 500.
 *
 * Mirrors the FREE_TIER_DEFAULTS semantics in `convex/entitlements.ts`:
 *   - no entitlement row → tier 0 (free)
 *   - validUntil < Date.now() → expired, treat as tier 0
 *   - tier >= 1 → PRO, allowed
 *
 * Kept inline (not imported from entitlements.ts) for security-review
 * readability: every alertRules mutation that calls this should be
 * trivially auditable in one file.
 */
async function assertProEntitlement(
  ctx: MutationCtx,
  userId: string,
): Promise<void> {
  const entitlement = await ctx.db
    .query("entitlements")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .first();
  const tier =
    entitlement && entitlement.validUntil >= Date.now()
      ? entitlement.features.tier
      : 0;
  if (tier < 1) {
    throw new ConvexError({
      code: "PRO_REQUIRED",
      message:
        "Notifications are a PRO feature. Upgrade to enable real-time and digest alerts.",
    });
  }
}

// Cross-field invariant enforcement for (digestMode, sensitivity).
//
// Tightened rule (2026-04-27): real-time delivery is now reserved for
// `critical`-tier events only. `(realtime, all)` and `(realtime, high)` are
// both forbidden. Anything below `critical` lives in a digest cadence
// (daily / twice_daily / weekly).
//
// Why tighter: even on `(realtime, high)`, `high`-severity events fire
// frequently enough on busy days to overload an inbox (severe weather,
// market moves, geopolitics). Real-time is for "interrupt me NOW" content
// only — i.e. genuinely critical. High events still reach the user, just
// batched in a digest.
//
// New-row defaults pick `'critical'` on realtime insert; patches preserve
// existing.sensitivity when caller omits the field (no silent narrowing of
// digest users).
function resolveEffectivePair(args: {
  incomingDigestMode?: DigestMode;
  incomingSensitivity?: Sensitivity;
  existing?: { digestMode?: DigestMode | string; sensitivity?: Sensitivity | string };
}): { digestMode: DigestMode; sensitivity: Sensitivity } {
  const digestMode = (args.incomingDigestMode
    ?? (args.existing?.digestMode as DigestMode | undefined)
    ?? "realtime");
  const sensitivity = (args.incomingSensitivity
    ?? (args.existing?.sensitivity as Sensitivity | undefined)
    ?? "critical"); // insert-only default — patch path never includes sensitivity unless caller passed it
  return { digestMode, sensitivity };
}

function assertCompatibleDeliveryMode(pair: { digestMode: DigestMode; sensitivity: Sensitivity }) {
  if (pair.digestMode === "realtime" && (pair.sensitivity === "all" || pair.sensitivity === "high")) {
    throw new ConvexError({
      code: "INCOMPATIBLE_DELIVERY",
      message:
        "Real-time delivery is for Critical events only. " +
        "To receive High or All events, choose a digest cadence (Daily, Twice daily, or Weekly).",
    });
  }
}

export const getAlertRules = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    return await ctx.db
      .query("alertRules")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .collect();
  },
});

export const setAlertRules = mutation({
  args: {
    variant: v.string(),
    enabled: v.boolean(),
    eventTypes: v.array(v.string()),
    sensitivity: v.optional(sensitivityValidator),
    channels: v.array(channelTypeValidator),
    aiDigestEnabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("UNAUTHENTICATED");
    const userId = identity.subject;
    await assertProEntitlement(ctx, userId);

    const existing = await ctx.db
      .query("alertRules")
      .withIndex("by_user_variant", (q) =>
        q.eq("userId", userId).eq("variant", args.variant),
      )
      .unique();

    const pair = resolveEffectivePair({
      incomingSensitivity: args.sensitivity,
      existing: existing ?? undefined,
    });
    assertCompatibleDeliveryMode(pair);

    const now = Date.now();

    if (existing) {
      const patch: Record<string, unknown> = {
        enabled: args.enabled,
        eventTypes: args.eventTypes,
        channels: args.channels,
        updatedAt: now,
      };
      // Only patch sensitivity when caller explicitly supplied it — never silently
      // narrow an existing digest user with sensitivity:'all' just because this
      // mutation got called without the field.
      if (args.sensitivity !== undefined) patch.sensitivity = args.sensitivity;
      if (args.aiDigestEnabled !== undefined) patch.aiDigestEnabled = args.aiDigestEnabled;
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("alertRules", {
        userId,
        variant: args.variant,
        enabled: args.enabled,
        eventTypes: args.eventTypes,
        sensitivity: pair.sensitivity,
        channels: args.channels,
        aiDigestEnabled: args.aiDigestEnabled ?? true,
        updatedAt: now,
      });
    }
  },
});

export const setDigestSettings = mutation({
  args: {
    variant: v.string(),
    digestMode: digestModeValidator,
    digestHour: v.optional(v.number()),
    digestTimezone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("UNAUTHENTICATED");
    const userId = identity.subject;
    await assertProEntitlement(ctx, userId);

    if (args.digestHour !== undefined && (args.digestHour < 0 || args.digestHour > 23 || !Number.isInteger(args.digestHour))) {
      throw new ConvexError("digestHour must be an integer 0–23");
    }
    if (args.digestTimezone !== undefined) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: args.digestTimezone });
      } catch {
        throw new ConvexError("digestTimezone must be a valid IANA timezone (e.g. America/New_York)");
      }
    }

    const existing = await ctx.db
      .query("alertRules")
      .withIndex("by_user_variant", (q) =>
        q.eq("userId", userId).eq("variant", args.variant),
      )
      .unique();

    const pair = resolveEffectivePair({
      incomingDigestMode: args.digestMode,
      existing: existing ?? undefined,
    });
    assertCompatibleDeliveryMode(pair);

    const now = Date.now();
    const patch = {
      digestMode: args.digestMode,
      digestHour: args.digestHour,
      digestTimezone: args.digestTimezone,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("alertRules", {
        userId,
        variant: args.variant,
        enabled: true,
        eventTypes: [],
        sensitivity: pair.sensitivity,
        channels: [],
        ...patch,
      });
    }
  },
});

export const getAlertRulesByUserId = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("alertRules")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
  },
});

export const setAlertRulesForUser = internalMutation({
  args: {
    userId: v.string(),
    variant: v.string(),
    enabled: v.boolean(),
    eventTypes: v.array(v.string()),
    sensitivity: v.optional(sensitivityValidator),
    channels: v.array(channelTypeValidator),
    aiDigestEnabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { userId, ...rest } = args;
    const existing = await ctx.db
      .query("alertRules")
      .withIndex("by_user_variant", (q) =>
        q.eq("userId", userId).eq("variant", rest.variant),
      )
      .unique();

    const pair = resolveEffectivePair({
      incomingSensitivity: rest.sensitivity,
      existing: existing ?? undefined,
    });
    assertCompatibleDeliveryMode(pair);

    const now = Date.now();
    if (existing) {
      const patch: Record<string, unknown> = {
        enabled: rest.enabled,
        eventTypes: rest.eventTypes,
        channels: rest.channels,
        updatedAt: now,
      };
      // Only patch sensitivity when caller explicitly supplied it — preserves
      // existing.sensitivity for digest users on omitted-field calls.
      if (rest.sensitivity !== undefined) patch.sensitivity = rest.sensitivity;
      if (rest.aiDigestEnabled !== undefined) patch.aiDigestEnabled = rest.aiDigestEnabled;
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("alertRules", {
        userId,
        variant: rest.variant,
        enabled: rest.enabled,
        eventTypes: rest.eventTypes,
        sensitivity: pair.sensitivity,
        channels: rest.channels,
        aiDigestEnabled: rest.aiDigestEnabled,
        updatedAt: now,
      });
    }
  },
});

const QUIET_HOURS_ARGS = {
  variant: v.string(),
  quietHoursEnabled: v.boolean(),
  quietHoursStart: v.optional(v.number()),
  quietHoursEnd: v.optional(v.number()),
  quietHoursTimezone: v.optional(v.string()),
  quietHoursOverride: v.optional(quietHoursOverrideValidator),
} as const;

function validateQuietHoursArgs(args: {
  quietHoursStart?: number;
  quietHoursEnd?: number;
  quietHoursTimezone?: string;
}) {
  if (args.quietHoursStart !== undefined && (args.quietHoursStart < 0 || args.quietHoursStart > 23 || !Number.isInteger(args.quietHoursStart))) {
    throw new ConvexError("quietHoursStart must be an integer 0–23");
  }
  if (args.quietHoursEnd !== undefined && (args.quietHoursEnd < 0 || args.quietHoursEnd > 23 || !Number.isInteger(args.quietHoursEnd))) {
    throw new ConvexError("quietHoursEnd must be an integer 0–23");
  }
  if (args.quietHoursTimezone !== undefined) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: args.quietHoursTimezone });
    } catch {
      throw new ConvexError("quietHoursTimezone must be a valid IANA timezone (e.g. America/New_York)");
    }
  }
}

export const setQuietHours = mutation({
  args: QUIET_HOURS_ARGS,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("UNAUTHENTICATED");
    const userId = identity.subject;
    await assertProEntitlement(ctx, userId);
    validateQuietHoursArgs(args);

    const existing = await ctx.db
      .query("alertRules")
      .withIndex("by_user_variant", (q) =>
        q.eq("userId", userId).eq("variant", args.variant),
      )
      .unique();

    // Only enforce start !== end when quiet hours are effectively enabled
    const effectiveEnabled = args.quietHoursEnabled ?? existing?.quietHoursEnabled ?? false;
    if (effectiveEnabled) {
      const effectiveStart = args.quietHoursStart ?? existing?.quietHoursStart;
      const effectiveEnd = args.quietHoursEnd ?? existing?.quietHoursEnd;
      if (effectiveStart !== undefined && effectiveEnd !== undefined && effectiveStart === effectiveEnd) {
        throw new ConvexError("quietHoursStart and quietHoursEnd must differ (same value = no quiet window)");
      }
    }

    // resolveEffectivePair supplies sensitivity:'critical' on fresh insert (compatible
    // by construction under the tightened rule). We DO NOT call assertCompatibleDeliveryMode here — quiet-hours
    // mutations don't touch the (digestMode, sensitivity) pair, so blocking unrelated
    // quiet-hours updates on pre-migration forbidden rows would surface as confusing
    // generic 500s ('set-quiet-hours' HTTP action has no INCOMPATIBLE_DELIVERY
    // passthrough). The relay coerce-at-read protects delivery for in-flight forbidden
    // rows; the migration drains them.
    // See plans/forbid-realtime-all-events.md + PR #3461 Greptile P1.
    const pair = resolveEffectivePair({ existing: existing ?? undefined });

    const now = Date.now();
    const patch = {
      quietHoursEnabled: args.quietHoursEnabled,
      quietHoursStart: args.quietHoursStart,
      quietHoursEnd: args.quietHoursEnd,
      quietHoursTimezone: args.quietHoursTimezone,
      quietHoursOverride: args.quietHoursOverride,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("alertRules", {
        userId,
        variant: args.variant,
        enabled: true,
        eventTypes: [],
        sensitivity: pair.sensitivity,
        channels: [],
        ...patch,
      });
    }
  },
});

export const setDigestSettingsForUser = internalMutation({
  args: {
    userId: v.string(),
    variant: v.string(),
    digestMode: digestModeValidator,
    digestHour: v.optional(v.number()),
    digestTimezone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, variant, ...digest } = args;
    if (digest.digestHour !== undefined && (digest.digestHour < 0 || digest.digestHour > 23 || !Number.isInteger(digest.digestHour))) {
      throw new ConvexError("digestHour must be an integer 0–23");
    }
    if (digest.digestTimezone !== undefined) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: digest.digestTimezone });
      } catch {
        throw new ConvexError("digestTimezone must be a valid IANA timezone (e.g. America/New_York)");
      }
    }
    const existing = await ctx.db
      .query("alertRules")
      .withIndex("by_user_variant", (q) =>
        q.eq("userId", userId).eq("variant", variant),
      )
      .unique();

    const pair = resolveEffectivePair({
      incomingDigestMode: digest.digestMode,
      existing: existing ?? undefined,
    });
    assertCompatibleDeliveryMode(pair);

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { ...digest, updatedAt: now });
    } else {
      await ctx.db.insert("alertRules", {
        userId, variant, enabled: true, eventTypes: [], sensitivity: pair.sensitivity, channels: [],
        ...digest, updatedAt: now,
      });
    }
  },
});

export const setQuietHoursForUser = internalMutation({
  args: { userId: v.string(), ...QUIET_HOURS_ARGS },
  handler: async (ctx, args) => {
    const { userId, ...rest } = args;
    validateQuietHoursArgs(rest);

    const existing = await ctx.db
      .query("alertRules")
      .withIndex("by_user_variant", (q) =>
        q.eq("userId", userId).eq("variant", rest.variant),
      )
      .unique();

    // Only enforce start !== end when quiet hours are effectively enabled
    const effectiveEnabled = rest.quietHoursEnabled ?? existing?.quietHoursEnabled ?? false;
    if (effectiveEnabled) {
      const effectiveStart = rest.quietHoursStart ?? existing?.quietHoursStart;
      const effectiveEnd = rest.quietHoursEnd ?? existing?.quietHoursEnd;
      if (effectiveStart !== undefined && effectiveEnd !== undefined && effectiveStart === effectiveEnd) {
        throw new ConvexError("quietHoursStart and quietHoursEnd must differ (same value = no quiet window)");
      }
    }

    // No assertCompatibleDeliveryMode here — quiet-hours mutations don't touch
    // the (digestMode, sensitivity) pair. See setQuietHours above for the full
    // rationale. resolveEffectivePair still supplies sensitivity:'critical' on fresh
    // insert (compatible by construction under the tightened rule).
    const pair = resolveEffectivePair({ existing: existing ?? undefined });

    const now = Date.now();
    const patch = {
      quietHoursEnabled: rest.quietHoursEnabled,
      quietHoursStart: rest.quietHoursStart,
      quietHoursEnd: rest.quietHoursEnd,
      quietHoursTimezone: rest.quietHoursTimezone,
      quietHoursOverride: rest.quietHoursOverride,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("alertRules", {
        userId, variant: rest.variant, enabled: true,
        eventTypes: [], sensitivity: pair.sensitivity, channels: [],
        ...patch,
      });
    }
  },
});

/**
 * Atomic internal mutation that updates BOTH digestMode and sensitivity together
 * (plus optional alert-rule + digest-schedule fields). Used by the settings UI's
 * delivery-mode change flow to avoid the two-call race in setDigestSettings →
 * setAlertRules where switching from `daily+all` to `realtime` would otherwise
 * trip the cross-field validator on the first call.
 *
 * All fields optional — caller passes only what changed. Patch logic preserves
 * existing.sensitivity when caller omits it (no silent narrowing of digest users).
 *
 * See plans/forbid-realtime-all-events.md §1d.
 */
export const setNotificationConfigForUser = internalMutation({
  args: {
    userId: v.string(),
    variant: v.string(),
    enabled: v.optional(v.boolean()),
    eventTypes: v.optional(v.array(v.string())),
    sensitivity: v.optional(sensitivityValidator),
    channels: v.optional(v.array(channelTypeValidator)),
    aiDigestEnabled: v.optional(v.boolean()),
    digestMode: v.optional(digestModeValidator),
    digestHour: v.optional(v.number()),
    digestTimezone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, variant } = args;
    // Layer-2 gate: this internal mutation is reachable from the public
    // `set-notification-config` HTTP action in convex/http.ts. Even though
    // the HTTP action verifies the Clerk JWT, the entitlement check belongs
    // on the same transaction as the write — defense-in-depth against any
    // future caller (a different HTTP action, a webhook handler, etc.).
    // Sister *ForUser internal mutations (setAlertRulesForUser, etc.) are
    // INTENTIONALLY left ungated: they are invoked by trusted operator paths
    // (admin migration scripts, cleanup jobs) where the operator's intent
    // is "manage another user's settings," and entitlement-gating those
    // would block the very cleanup we need to do for free-tier rows that
    // got created before this gate existed.
    await assertProEntitlement(ctx, userId);

    if (args.digestHour !== undefined && (args.digestHour < 0 || args.digestHour > 23 || !Number.isInteger(args.digestHour))) {
      throw new ConvexError("digestHour must be an integer 0–23");
    }
    if (args.digestTimezone !== undefined) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: args.digestTimezone });
      } catch {
        throw new ConvexError("digestTimezone must be a valid IANA timezone (e.g. America/New_York)");
      }
    }

    const existing = await ctx.db
      .query("alertRules")
      .withIndex("by_user_variant", (q) => q.eq("userId", userId).eq("variant", variant))
      .unique();

    const pair = resolveEffectivePair({
      incomingDigestMode: args.digestMode,
      incomingSensitivity: args.sensitivity,
      existing: existing ?? undefined,
    });
    assertCompatibleDeliveryMode(pair);

    const now = Date.now();

    if (existing) {
      const patch: Record<string, unknown> = { updatedAt: now };
      if (args.enabled !== undefined) patch.enabled = args.enabled;
      if (args.eventTypes !== undefined) patch.eventTypes = args.eventTypes;
      // Only patch sensitivity when caller explicitly supplied it.
      if (args.sensitivity !== undefined) patch.sensitivity = args.sensitivity;
      if (args.channels !== undefined) patch.channels = args.channels;
      if (args.aiDigestEnabled !== undefined) patch.aiDigestEnabled = args.aiDigestEnabled;
      if (args.digestMode !== undefined) patch.digestMode = args.digestMode;
      if (args.digestHour !== undefined) patch.digestHour = args.digestHour;
      if (args.digestTimezone !== undefined) patch.digestTimezone = args.digestTimezone;
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("alertRules", {
        userId,
        variant,
        enabled: args.enabled ?? true,
        eventTypes: args.eventTypes ?? [],
        sensitivity: pair.sensitivity,
        channels: args.channels ?? [],
        aiDigestEnabled: args.aiDigestEnabled,
        digestMode: args.digestMode,
        digestHour: args.digestHour,
        digestTimezone: args.digestTimezone,
        updatedAt: now,
      });
    }
  },
});

/** Returns all enabled rules that have a non-realtime digestMode set. */
export const getDigestRules = internalQuery({
  args: {},
  handler: async (ctx) => {
    const enabled = await ctx.db
      .query("alertRules")
      .withIndex("by_enabled", (q) => q.eq("enabled", true))
      .collect();
    return enabled.filter(
      (r) => r.digestMode !== undefined && r.digestMode !== "realtime",
    );
  },
});

export const getByEnabled = query({
  args: { enabled: v.boolean() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("alertRules")
      .withIndex("by_enabled", (q) => q.eq("enabled", args.enabled))
      .collect();
  },
});
