/**
 * Canonical per-Clerk-user record + locale capture.
 *
 * Populated by the client on first authenticated session via
 * `api.users.ensureRecord`. Source of truth for: locale (filtering),
 * timezone (display), country (analytics — client-reported, not
 * authoritative), first/last seen.
 *
 * Distinct from `customers` (paid-only, populated by Dodo webhook):
 * `users` covers EVERY Clerk-authenticated user, free or paid.
 *
 * This mutation is PUBLIC (called from the browser via ConvexClient)
 * but trusts ONLY `ctx.auth.getUserIdentity()` for identity, never the
 * request body. Email is server-derived — clients cannot supply it.
 *
 * Failure mode: returns `{ ok: false, reason }` instead of throwing,
 * so a transient validation or auth blip on session init never crashes
 * the auth path. Client retries on next session.
 */
import { mutation } from "./_generated/server";
import { v } from "convex/values";

// Validation invariants. Length-bounded BEFORE regex (defense in depth
// against memory-exhaustion via huge strings).
const MAX_LOCALE_TAG_LEN = 64;
const MAX_LOCALE_PRIMARY_LEN = 8;
const MAX_TIMEZONE_LEN = 64;

// BCP 47 tag: 2-3 letter language + optional regional/script subtags.
// Permissive on the suffix to accept extended tags like "zh-Hant-CN".
const LOCALE_TAG_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;
// Lowercased primary subtag only.
const LOCALE_PRIMARY_RE = /^[a-z]{2,3}$/;
// ISO 3166-1 alpha-2.
const COUNTRY_RE = /^[A-Z]{2}$/;

function isValidTimezone(tz: string): boolean {
  // Use try/catch around `new Intl.DateTimeFormat(undefined, { timeZone })`
  // rather than `Intl.supportedValuesOf('timeZone').includes(...)`. The
  // latter may not be available in the Convex runtime AND can reject
  // valid IANA aliases. Constructor-based check is the canonical
  // validation pattern.
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const ensureRecord = mutation({
  args: {
    localeTag: v.string(),
    localePrimary: v.string(),
    timezone: v.optional(v.string()),
    country: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // ──── Validation ────
    // On any validation failure: warn-log + return {ok: false, reason,
    // field}. Never throw — the client's auth path must not break on
    // a transient bad input.
    if (
      args.localeTag.length > MAX_LOCALE_TAG_LEN ||
      !LOCALE_TAG_RE.test(args.localeTag)
    ) {
      console.warn(
        `[users:ensureRecord] invalid localeTag rejected: ${args.localeTag.slice(0, 64)}`,
      );
      return { ok: false as const, reason: "invalid-input" as const, field: "localeTag" };
    }
    if (
      args.localePrimary.length > MAX_LOCALE_PRIMARY_LEN ||
      !LOCALE_PRIMARY_RE.test(args.localePrimary)
    ) {
      console.warn(
        `[users:ensureRecord] invalid localePrimary rejected: ${args.localePrimary.slice(0, 64)}`,
      );
      return { ok: false as const, reason: "invalid-input" as const, field: "localePrimary" };
    }
    if (args.timezone !== undefined) {
      if (args.timezone.length > MAX_TIMEZONE_LEN || !isValidTimezone(args.timezone)) {
        console.warn(
          `[users:ensureRecord] invalid timezone rejected: ${args.timezone.slice(0, 64)}`,
        );
        return { ok: false as const, reason: "invalid-input" as const, field: "timezone" };
      }
    }
    if (args.country !== undefined && !COUNTRY_RE.test(args.country)) {
      console.warn(
        `[users:ensureRecord] invalid country rejected: ${args.country.slice(0, 64)}`,
      );
      return { ok: false as const, reason: "invalid-input" as const, field: "country" };
    }

    // ──── Auth ────
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return { ok: false as const, reason: "unauthenticated" as const };
    }
    const userId = identity.subject;
    // Email may be empty for phone-only signups; treated as "no email
    // observed yet" — we'll fill it on a later call when one is added.
    const incomingEmail = (identity.email ?? "").trim();
    const incomingNormalizedEmail = incomingEmail.toLowerCase();

    // ──── Upsert ────
    const now = Date.now();
    const existing = await ctx.db
      .query("users")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();

    if (existing) {
      // Patch policy:
      // - locale fields: always refresh (last-write-wins; users do switch
      //   browser locale legitimately).
      // - timezone / country: refresh only if explicitly provided in this
      //   call. An omitted optional arg means "no new data this session",
      //   not "clear it".
      // - email / normalizedEmail: refresh on every call when identity
      //   supplies a non-empty value (Clerk identity is source of truth;
      //   users do change their primary email). Empty incoming → leave
      //   existing alone (defends transient gaps during email-change flows).
      const patch: Record<string, unknown> = {
        localeTag: args.localeTag,
        localePrimary: args.localePrimary,
        lastSeenAt: now,
      };
      if (args.timezone !== undefined) patch.timezone = args.timezone;
      if (args.country !== undefined) patch.country = args.country;
      if (incomingEmail.length > 0) {
        patch.email = incomingEmail;
        patch.normalizedEmail = incomingNormalizedEmail;
      }
      await ctx.db.patch(existing._id, patch);
      return { ok: true as const, action: "patched" as const };
    }

    await ctx.db.insert("users", {
      userId,
      email: incomingEmail.length > 0 ? incomingEmail : undefined,
      normalizedEmail:
        incomingNormalizedEmail.length > 0 ? incomingNormalizedEmail : undefined,
      localeTag: args.localeTag,
      localePrimary: args.localePrimary,
      timezone: args.timezone,
      country: args.country,
      firstSeenAt: now,
      lastSeenAt: now,
    });
    return { ok: true as const, action: "inserted" as const };
  },
});
