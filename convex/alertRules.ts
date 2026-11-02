import { assertAccountWritable } from "./accountDeletion/guard";
import { ConvexError, getDocumentSize, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { channelTypeValidator, digestModeValidator, quietHoursOverrideValidator, sensitivityValidator } from "./constants";
import { CHOKEPOINT_ALERT_IDS } from "../shared/chokepoint-alert-ids";
import {
  ALERT_RULES_PER_USER_MAX,
  dedupeStrings,
  getAlertRuleShapeViolation,
  isAlertRuleVariant,
  listAlertRuleShapeViolations,
  type AlertRuleShapeCode,
} from "../shared/alert-rule-shape";
import { mergeEntitlementFeatures } from "./lib/entitlements";

type DigestMode = "realtime" | "daily" | "twice_daily" | "weekly";
type Sensitivity = "all" | "high" | "critical";

// The public `setAlertRules` / `setDigestSettings` / `setQuietHours`
// mutations and the `getAlertRules` query were removed (Strix 2026-10-27):
// no client called them — the dashboard writes through
// /api/notification-channels → /relay/notification-channels → the *ForUser
// internal mutations below — and they had no rate limit.

/**
 * Row-shape bounds shared with the edge handler (shared/alert-rule-shape.ts).
 * The relay reads every enabled row in one transaction, so a single account
 * writing oversized rows used to push that shared read past the Convex read
 * limit and stop delivery for every tenant. Every writer below calls this
 * before touching the table.
 */
function assertRuleShape(args: { variant: string; eventTypes?: string[]; channels?: string[] }): void {
  const violation = getAlertRuleShapeViolation(args);
  if (violation) {
    throw new ConvexError({ code: violation.code, message: violation.message });
  }
}

/**
 * Per-account row cap, enforced on insert only: `variant` is the row key and
 * must come from the fixed registry, so an in-shape account can never exceed
 * one row per variant. Legacy rows with out-of-registry variants still count,
 * so an account that holds the maximum has to be cleaned up (see
 * `listShapeViolations`) before it can create a new variant row.
 */
async function assertRuleSlotAvailable(ctx: MutationCtx, userId: string): Promise<void> {
  const existing = await ctx.db
    .query("alertRules")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(ALERT_RULES_PER_USER_MAX + 1);
  if (existing.length >= ALERT_RULES_PER_USER_MAX) {
    throw new ConvexError({
      code: "RULE_LIMIT_EXCEEDED",
      message: `an account holds at most ${ALERT_RULES_PER_USER_MAX} alert rules (one per variant)`,
    });
  }
}

// Page bound for the cross-tenant reads: a page stops growing once it has
// read this many bytes (plus the row that crossed it), so no page can reach
// the Convex per-transaction read limit no matter how large legacy rows are.
const RULES_PAGE_MAX_BYTES = 4 * 1024 * 1024;
const RULES_PAGE_MAX_ITEMS = 256;

const pageArgs = {
  cursor: v.union(v.string(), v.null()),
  numItems: v.optional(v.number()),
} as const;

function clampPageItems(numItems: number | undefined): number {
  return Math.max(1, Math.min(RULES_PAGE_MAX_ITEMS, Math.floor(numItems ?? RULES_PAGE_MAX_ITEMS)));
}

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

// Defensive ceiling against patched-client abuse — there are ~250 ISO-3166
// countries; 50 is more than any real user opts into and well below any
// validator/storage limit.
const COUNTRIES_MAX = 50;

/**
 * Shape-validate + normalize an inbound `countries` array.
 *  - trim each entry
 *  - uppercase
 *  - keep only ASCII A-Z 2-letter shapes (`^[A-Z]{2}$`); silently drop the rest
 *  - dedupe (preserves first-seen order)
 *  - cap at COUNTRIES_MAX
 *
 * NOT a strict ISO-3166 registry check — invalid alpha-2 codes (e.g. "XX")
 * pass shape validation but the relay's includes() check just won't match
 * any real event country. We deliberately don't soft-couple this file to a
 * canonical registry list (that lives elsewhere as part of the
 * followed-countries primitive) — keep alertRules independently shippable.
 */
function normalizeCountries(input: string[]): string[] {
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const upper = raw.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(upper)) continue;
    if (seen.has(upper)) continue;
    seen.add(upper);
    cleaned.push(upper);
  }
  if (cleaned.length > COUNTRIES_MAX) {
    throw new ConvexError({
      code: "COUNTRIES_LIMIT_EXCEEDED",
      message: `countries list capped at ${COUNTRIES_MAX} entries`,
    });
  }
  return cleaned;
}

// Same defensive ceiling as COUNTRIES_MAX — mirrors the client-side market
// watchlist cap (src/services/market-watchlist.ts stops at 50 entries).
const TICKERS_MAX = 50;

/**
 * Shape-validate + normalize an inbound `tickers` array (#4922 U3).
 * Modeled EXACTLY on normalizeCountries above:
 *  - trim each entry
 *  - uppercase
 *  - keep only `^[A-Z][A-Z0-9&-]{0,11}(\.[A-Z]{1,3})?$` shapes — plain
 *    symbols (AAPL), share-class/conglomerate forms (BRK-B, M&M.NS) and
 *    dot-suffixed exchange listings (RELIANCE.NS, BHARTIARTL.NS — NSE
 *    bases run to 10 chars); silently drop the rest (^GSPC indices, GC=F
 *    futures, cashtags, prose). Every non-index shared/stocks.json symbol
 *    must pass — the extractor emits exactly those for company-name hits,
 *    and a dropped shape here means that ticker can never alert.
 *  - dedupe (preserves first-seen order)
 *  - cap at TICKERS_MAX
 *
 * NOT a registry check against shared/stocks.json — a shape-valid symbol
 * the extractor never emits simply never intersects at the relay. Keeps
 * alertRules independently shippable, same rationale as countries.
 */
function normalizeTickers(input: string[]): string[] {
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const upper = raw.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9&-]{0,11}(\.[A-Z]{1,3})?$/.test(upper)) continue;
    if (seen.has(upper)) continue;
    seen.add(upper);
    cleaned.push(upper);
  }
  if (cleaned.length > TICKERS_MAX) {
    throw new ConvexError({
      code: "TICKERS_LIMIT_EXCEEDED",
      message: `tickers list capped at ${TICKERS_MAX} entries`,
    });
  }
  return cleaned;
}

/**
 * Normalize an inbound `chokepoints` array (#9217): trim, lowercase, keep
 * only ids in shared/chokepoint-alert-ids.ts, dedupe in first-seen order.
 * Unknown ids are dropped, as the other scopes do, but a non-empty list with
 * no known id is rejected: [] means every chokepoint, so a caller sending
 * ["hormuz"] would otherwise widen the rule to all of them.
 */
function normalizeChokepoints(input: string[]): string[] {
  const known = new Set(CHOKEPOINT_ALERT_IDS);
  const cleaned: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const id = raw.trim().toLowerCase();
    if (!known.has(id) || cleaned.includes(id)) continue;
    cleaned.push(id);
  }
  if (input.length > 0 && cleaned.length === 0) {
    throw new ConvexError({
      code: "CHOKEPOINTS_INVALID",
      message: `chokepoints must use registry ids: ${CHOKEPOINT_ALERT_IDS.join(", ")}`,
    });
  }
  return cleaned;
}

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
    countries: v.optional(v.array(v.string())),
    tickers: v.optional(v.array(v.string())),
    chokepoints: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await assertAccountWritable(ctx, args.userId);
    assertRuleShape(args);
    const { userId, ...rest } = args;
    const eventTypes = dedupeStrings(rest.eventTypes);
    const channels = dedupeStrings(rest.channels);
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

    const normalizedCountries = rest.countries !== undefined
      ? normalizeCountries(rest.countries)
      : undefined;
    const normalizedTickers = rest.tickers !== undefined
      ? normalizeTickers(rest.tickers)
      : undefined;
    const normalizedChokepoints = rest.chokepoints !== undefined
      ? normalizeChokepoints(rest.chokepoints)
      : undefined;

    const now = Date.now();
    if (existing) {
      const patch: Record<string, unknown> = {
        enabled: rest.enabled,
        eventTypes,
        channels,
        updatedAt: now,
      };
      // Only patch sensitivity when caller explicitly supplied it — preserves
      // existing.sensitivity for digest users on omitted-field calls.
      if (rest.sensitivity !== undefined) patch.sensitivity = rest.sensitivity;
      if (rest.aiDigestEnabled !== undefined) patch.aiDigestEnabled = rest.aiDigestEnabled;
      if (normalizedCountries !== undefined) patch.countries = normalizedCountries;
      if (normalizedTickers !== undefined) patch.tickers = normalizedTickers;
      if (normalizedChokepoints !== undefined) patch.chokepoints = normalizedChokepoints;
      await ctx.db.patch(existing._id, patch);
    } else {
      await assertRuleSlotAvailable(ctx, userId);
      await ctx.db.insert("alertRules", {
        userId,
        variant: rest.variant,
        enabled: rest.enabled,
        eventTypes,
        sensitivity: pair.sensitivity,
        channels,
        aiDigestEnabled: rest.aiDigestEnabled,
        countries: normalizedCountries,
        tickers: normalizedTickers,
        chokepoints: normalizedChokepoints,
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

export const setDigestSettingsForUser = internalMutation({
  args: {
    userId: v.string(),
    variant: v.string(),
    digestMode: digestModeValidator,
    digestHour: v.optional(v.number()),
    digestTimezone: v.optional(v.string()),
    countries: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await assertAccountWritable(ctx, args.userId);
    assertRuleShape(args);
    const { userId, variant, countries, ...digest } = args;
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
    const normalizedCountries = countries !== undefined
      ? normalizeCountries(countries)
      : undefined;
    if (existing) {
      const patch: Record<string, unknown> = { ...digest, updatedAt: now };
      if (normalizedCountries !== undefined) patch.countries = normalizedCountries;
      await ctx.db.patch(existing._id, patch);
    } else {
      await assertRuleSlotAvailable(ctx, userId);
      await ctx.db.insert("alertRules", {
        userId, variant, enabled: true, eventTypes: [], sensitivity: pair.sensitivity, channels: [],
        ...digest, countries: normalizedCountries, updatedAt: now,
      });
    }
  },
});

export const setQuietHoursForUser = internalMutation({
  args: { userId: v.string(), ...QUIET_HOURS_ARGS, countries: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    await assertAccountWritable(ctx, args.userId);
    assertRuleShape(args);
    const { userId, countries, ...rest } = args;
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
    const normalizedCountries = countries !== undefined
      ? normalizeCountries(countries)
      : undefined;
    const patch = {
      quietHoursEnabled: rest.quietHoursEnabled,
      quietHoursStart: rest.quietHoursStart,
      quietHoursEnd: rest.quietHoursEnd,
      quietHoursTimezone: rest.quietHoursTimezone,
      quietHoursOverride: rest.quietHoursOverride,
      updatedAt: now,
      ...(normalizedCountries !== undefined ? { countries: normalizedCountries } : {}),
    };

    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await assertRuleSlotAvailable(ctx, userId);
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
 * See docs/archive/plans/forbid-realtime-all-events.md §1d.
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
    countries: v.optional(v.array(v.string())),
    tickers: v.optional(v.array(v.string())),
    chokepoints: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await assertAccountWritable(ctx, args.userId);
    assertRuleShape(args);
    const { userId, variant } = args;
    const eventTypes = args.eventTypes !== undefined ? dedupeStrings(args.eventTypes) : undefined;
    const channels = args.channels !== undefined ? dedupeStrings(args.channels) : undefined;
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

    const normalizedCountries = args.countries !== undefined
      ? normalizeCountries(args.countries)
      : undefined;
    const normalizedTickers = args.tickers !== undefined
      ? normalizeTickers(args.tickers)
      : undefined;
    const normalizedChokepoints = args.chokepoints !== undefined
      ? normalizeChokepoints(args.chokepoints)
      : undefined;

    const now = Date.now();

    if (existing) {
      const patch: Record<string, unknown> = { updatedAt: now };
      if (args.enabled !== undefined) patch.enabled = args.enabled;
      if (eventTypes !== undefined) patch.eventTypes = eventTypes;
      // Only patch sensitivity when caller explicitly supplied it.
      if (args.sensitivity !== undefined) patch.sensitivity = args.sensitivity;
      if (channels !== undefined) patch.channels = channels;
      if (args.aiDigestEnabled !== undefined) patch.aiDigestEnabled = args.aiDigestEnabled;
      if (args.digestMode !== undefined) patch.digestMode = args.digestMode;
      if (args.digestHour !== undefined) patch.digestHour = args.digestHour;
      if (args.digestTimezone !== undefined) patch.digestTimezone = args.digestTimezone;
      if (normalizedCountries !== undefined) patch.countries = normalizedCountries;
      if (normalizedTickers !== undefined) patch.tickers = normalizedTickers;
      if (normalizedChokepoints !== undefined) patch.chokepoints = normalizedChokepoints;
      await ctx.db.patch(existing._id, patch);
    } else {
      await assertRuleSlotAvailable(ctx, userId);
      await ctx.db.insert("alertRules", {
        userId,
        variant,
        enabled: args.enabled ?? true,
        eventTypes: eventTypes ?? [],
        sensitivity: pair.sensitivity,
        channels: channels ?? [],
        aiDigestEnabled: args.aiDigestEnabled,
        digestMode: args.digestMode,
        digestHour: args.digestHour,
        digestTimezone: args.digestTimezone,
        countries: normalizedCountries,
        tickers: normalizedTickers,
        chokepoints: normalizedChokepoints,
        updatedAt: now,
      });
    }
  },
});

// ── Cross-tenant reads ────────────────────────────────────────────────────────
//
// Every query below scans rows across EVERY user, so each one is INTERNAL
// (GHSA-r649-4cqj-w93h) and reachable only through the shared-secret /relay/*
// HTTP actions in convex/http.ts or a deploy-key `npx convex run`. Each one is
// paginated and byte-bounded per page (RULES_PAGE_MAX_BYTES): they used to
// `.collect()` the whole index in one transaction, so one account holding
// oversized rows pushed the read past the Convex limit and the relay, the
// digest cron and the default-brief composer failed for every tenant. The
// HTTP actions walk the pages; an oversized row now costs one short page.

async function paginateEnabledRules(ctx: QueryCtx, enabled: boolean, cursor: string | null, numItems: number | undefined) {
  return await ctx.db
    .query("alertRules")
    .withIndex("by_enabled", (q) => q.eq("enabled", enabled))
    .paginate({ cursor, numItems: clampPageItems(numItems), maximumBytesRead: RULES_PAGE_MAX_BYTES });
}

/** One page of the enabled rules; `?enabled=false` selects the disabled set. */
export const getByEnabled = internalQuery({
  args: { enabled: v.boolean(), ...pageArgs },
  handler: async (ctx, args) => {
    const result = await paginateEnabledRules(ctx, args.enabled, args.cursor, args.numItems);
    return { page: result.page, continueCursor: result.continueCursor, isDone: result.isDone };
  },
});

/** One page of enabled rules filtered to a non-realtime digestMode (a page may be empty before isDone). */
export const getDigestRules = internalQuery({
  args: pageArgs,
  handler: async (ctx, args) => {
    const result = await paginateEnabledRules(ctx, true, args.cursor, args.numItems);
    return {
      page: result.page.filter((r) => r.digestMode !== undefined && r.digestMode !== "realtime"),
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

// Paid users who get no brief from their own rules: no enabled digest-mode
// rule, and no rule that opted out of the AI digest. The digest cron composes
// a default in-app brief for each (it never sends one to a channel), so the
// dashboard's Latest Brief panel is not stuck on "composing" for a paying user
// who never set a schedule. "Paid" mirrors /relay/entitlement: validUntil >=
// now and the catalog-merged features.tier >= 1.
//
// Two byte-bounded scans compose the answer in /relay/brief-only-users
// (`briefOnlyUserIds` below): every alertRules row once, folded into per-user
// flags, and every active entitlement once. Reading each paid user's rules
// inside the entitlement page would put the bound on rows, not bytes — three
// legacy accounts with seven ~900 KB rows each would exceed the transaction
// limit in one page — and a `take(n)` per user would miss an AI-digest opt-out
// on the (n+1)th row of an over-cap legacy account.
//
// `now` comes from the caller and must be identical on every page: a Convex
// cursor is bound to its query, and a range bound read from the clock inside
// each page made page 2 a different query (InvalidCursor, Sentry
// WORLDMONITOR-19Z).
export const listPaidUserIds = internalQuery({
  args: { ...pageArgs, now: v.number() },
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("entitlements")
      .withIndex("by_validUntil", (q) => q.gte("validUntil", args.now))
      .paginate({ cursor: args.cursor, numItems: clampPageItems(args.numItems), maximumBytesRead: RULES_PAGE_MAX_BYTES });
    return {
      page: result.page
        .filter((e) => (mergeEntitlementFeatures(e.planKey, e.features).tier ?? 0) >= 1)
        .map((e) => e.userId),
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

export type BriefRuleFlags = { userId: string; optedOut: boolean; hasDigest: boolean };

/** One page of alertRules rows folded into per-user brief flags; a user may appear on several pages (OR the flags). */
export const listBriefRuleFlags = internalQuery({
  args: pageArgs,
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("alertRules")
      .paginate({ cursor: args.cursor, numItems: clampPageItems(args.numItems), maximumBytesRead: RULES_PAGE_MAX_BYTES });
    const byUser = new Map<string, BriefRuleFlags>();
    for (const r of result.page as Doc<"alertRules">[]) {
      const flags = byUser.get(r.userId) ?? { userId: r.userId, optedOut: false, hasDigest: false };
      if (r.aiDigestEnabled === false) flags.optedOut = true;
      if (r.enabled && r.digestMode !== undefined && r.digestMode !== "realtime") flags.hasDigest = true;
      byUser.set(r.userId, flags);
    }
    return { page: [...byUser.values()], continueCursor: result.continueCursor, isDone: result.isDone };
  },
});

/** Pure composition of the two scans above: paid users with neither flag. */
export function briefOnlyUserIds(paidUserIds: Iterable<string>, flags: Iterable<BriefRuleFlags>): string[] {
  const excluded = new Set<string>();
  for (const f of flags) {
    if (f.optedOut || f.hasDigest) excluded.add(f.userId);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const userId of paidUserIds) {
    if (excluded.has(userId) || seen.has(userId)) continue;
    seen.add(userId);
    out.push(userId);
  }
  return out;
}

/**
 * Pre-deploy / post-deploy audit (read-only): one page of rows that break the
 * shape every writer now enforces, with the approximate document size, plus
 * the per-user row count of every row scanned so the caller can tally
 * accounts above ALERT_RULES_PER_USER_MAX across pages. Driven by
 * scripts/check-alert-rule-shapes.mjs through `npx convex run`.
 */
export const listShapeViolations = internalQuery({
  args: pageArgs,
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("alertRules")
      .paginate({ cursor: args.cursor, numItems: clampPageItems(args.numItems), maximumBytesRead: RULES_PAGE_MAX_BYTES });
    const rowCounts: Record<string, number> = {};
    const page: Array<{ id: string; userId: string; variant: string; enabled: boolean; codes: AlertRuleShapeCode[]; approxBytes: number }> = [];
    for (const row of result.page as Doc<"alertRules">[]) {
      rowCounts[row.userId] = (rowCounts[row.userId] ?? 0) + 1;
      const codes = listAlertRuleShapeViolations(row).map((violation) => violation.code);
      if (codes.length === 0) continue;
      page.push({
        id: row._id,
        userId: row.userId,
        variant: row.variant.length > 64 ? `${row.variant.slice(0, 61)}...` : row.variant,
        enabled: row.enabled,
        codes,
        approxBytes: getDocumentSize(row),
      });
    }
    return {
      page,
      rowCounts,
      rulesPerUserMax: ALERT_RULES_PER_USER_MAX,
      scanned: result.page.length,
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

const DELETE_INVALID_VARIANT_IDS_MAX = 100;
// A row can be up to 1 MiB, so stopping once 8 MiB is read keeps one call well
// under Convex's 16 MiB transaction read limit.
const DELETE_INVALID_VARIANT_BYTES_MAX = 8 * 1024 * 1024;

/**
 * Operator cleanup for the VARIANT_INVALID rows `listShapeViolations`
 * reports. Takes ids from that audit rather than scanning, and re-checks each
 * row here: only a row whose variant is still outside the registry is
 * deleted. Rows with a registry variant are kept even when they break another
 * shape rule, because those are settings the dashboard can still reach.
 */
export const deleteInvalidVariantRules = internalMutation({
  args: { ids: v.array(v.id("alertRules")), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    if (args.ids.length > DELETE_INVALID_VARIANT_IDS_MAX) {
      throw new ConvexError(`pass at most ${DELETE_INVALID_VARIANT_IDS_MAX} ids per call`);
    }
    const deleted: Id<"alertRules">[] = [];
    const skipped: Array<{ id: Id<"alertRules">; reason: "NOT_FOUND" | "VARIANT_VALID" }> = [];
    const ids = [...new Set(args.ids)];
    let bytesRead = 0;
    let next = 0;
    for (; next < ids.length && bytesRead < DELETE_INVALID_VARIANT_BYTES_MAX; next++) {
      const id = ids[next]!;
      const row = await ctx.db.get(id);
      if (row) bytesRead += getDocumentSize(row);
      if (!row) {
        skipped.push({ id, reason: "NOT_FOUND" });
        continue;
      }
      if (isAlertRuleVariant(row.variant)) {
        skipped.push({ id, reason: "VARIANT_VALID" });
        continue;
      }
      if (!args.dryRun) await ctx.db.delete(id);
      deleted.push(id);
    }
    // Ids left unread because of the byte budget; pass them to the next call.
    return { deleted, skipped, remaining: ids.slice(next) };
  },
});
