import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  query,
} from "./_generated/server";
import {
  COUNTRY_COUNT_PRIVACY_FLOOR,
  FREE_TIER_FOLLOW_LIMIT,
  MAX_MERGE_INPUT,
  SHARD_COUNT,
} from "./constants";
import { isValidIso2 } from "./lib/iso2";
import { userIdToShard } from "./lib/shards";

/**
 * Layer-2 entitlement gate for the followed-countries watchlist primitive
 * (plan U13). Returns the user's effective tier (0 = free, ≥1 = PRO).
 *
 * Mirrors `convex/alertRules.ts::assertProEntitlement` — kept inline (not
 * imported from a shared helper) for security-review readability.
 *
 *   - no entitlement row → tier 0 (free)
 *   - validUntil < Date.now() → expired, treat as tier 0
 *   - tier ≥ 1 → PRO
 *
 * Unlike alertRules (which throws PRO_REQUIRED), the watchlist gate is
 * NOT all-or-nothing: free users may follow up to FREE_TIER_FOLLOW_LIMIT
 * countries; only over-cap inserts throw FREE_CAP. So we return the tier
 * for the caller to decide.
 */
async function readEntitlementTier(
  ctx: MutationCtx,
  userId: string,
): Promise<number> {
  const entitlement = await ctx.db
    .query("entitlements")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .first();
  if (!entitlement) return 0;
  if (entitlement.validUntil < Date.now()) return 0;
  return entitlement.features.tier ?? 0;
}

/**
 * Read the pre-seeded shard row for `userId` and throw a loud
 * SHARDS_NOT_SEEDED error if it doesn't exist (operator error — the
 * `_seedShards` mutation must have run as part of deploy + the daily
 * cron keeps it seeded). Returns the shard `_id` so the caller can patch
 * it at the end of the mutation. The read+write pair on the shard row is
 * what triggers Convex's per-document OCC to serialize concurrent
 * same-user mutations against an ALREADY-EXISTING document — closing the
 * nested TOCTOU on the lazy-created `followedCountriesUserMeta` row.
 *
 * Uses `.first()` (not `.unique()`) so duplicate shard rows for the same
 * `shardId` — possible from a concurrent-seed race in `_seedShards`
 * before the daily `_dedupeShards` cron self-heals — never throw.
 * `.first()` returns rows in `_creationTime` order, so concurrent
 * mutations all pick the OLDEST duplicate row deterministically. That
 * means OCC contention is preserved for the duration of the
 * duplicate-window: every parallel same-user mutation touches the same
 * single row, so the per-document OCC retry still serializes them. The
 * `_dedupeShards` cron deletes extras keeping the oldest by
 * `_creationTime`, restoring exactly one row per `shardId` on the next
 * daily tick.
 *
 * See `convex/lib/shards.ts::userIdToShard` for the hash and
 * `convex/constants.ts::SHARD_COUNT` for the fixed shard count.
 */
async function readShardOrThrow(
  ctx: MutationCtx,
  userId: string,
): Promise<Doc<"followedCountriesShards">> {
  const shardId = userIdToShard(userId);
  const shard = await ctx.db
    .query("followedCountriesShards")
    .withIndex("by_shard", (q) => q.eq("shardId", shardId))
    .first();
  if (!shard) {
    // Operator error — should never happen in production after deploy +
    // the daily `_seedShards` cron. Logged loudly so on-call sees it.
    console.error(
      JSON.stringify({
        breadcrumb: "followed_countries_shards_not_seeded",
        shardId,
        shardCount: SHARD_COUNT,
      }),
    );
    throw new ConvexError({ kind: "SHARDS_NOT_SEEDED", shardId });
  }
  return shard;
}

/**
 * Patch the shard row's `lastTouchedAt` — the OCC-serializing write that
 * pairs with `readShardOrThrow`. MUST run on the success path AFTER all
 * other writes; on any throw, Convex aborts the entire transaction and
 * the patch is rolled back along with everything else.
 */
async function touchShard(
  ctx: MutationCtx,
  shard: Doc<"followedCountriesShards">,
): Promise<void> {
  await ctx.db.patch(shard._id, { lastTouchedAt: Date.now() });
}

/**
 * Read the per-user serialization row for `userId`. Returns the row (if
 * exists) and the denormalized count (0 if no row). Every mutation that
 * mutates `followedCountries` for the user MUST call this AND patch/insert
 * the row at the end — that read+write pair is what triggers Convex
 * per-document OCC retry under same-user concurrency.
 *
 * NOTE: this row is created LAZILY on first use, so its OCC ALONE does
 * NOT serialize the brand-new-user race (two parallel first-ever
 * mutations both read empty and both INSERT, producing duplicate rows
 * that break the `.unique()` read). The pre-seeded shard row above
 * closes that window — it always exists, so its OCC is bulletproof.
 */
async function readUserMeta(
  ctx: MutationCtx,
  userId: string,
): Promise<{
  meta: Doc<"followedCountriesUserMeta"> | null;
  count: number;
}> {
  const meta = await ctx.db
    .query("followedCountriesUserMeta")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  return { meta, count: meta?.count ?? 0 };
}

/**
 * Patch (or insert) the per-user serialization row to `newCount`. This is
 * the OCC-serializing write — concurrent same-user mutations that both
 * read the same `meta._id` will conflict here, and Convex retries the
 * loser. The retry re-reads everything (including the row that the winner
 * inserted), so the second attempt sees the post-winner state and either
 * passes correctly (still under cap), throws FREE_CAP, or returns
 * idempotent (winner already inserted the same `(userId, country)`).
 */
async function writeUserMeta(
  ctx: MutationCtx,
  userId: string,
  meta: Doc<"followedCountriesUserMeta"> | null,
  newCount: number,
): Promise<void> {
  const now = Date.now();
  if (meta) {
    await ctx.db.patch(meta._id, { count: newCount, updatedAt: now });
  } else {
    await ctx.db.insert("followedCountriesUserMeta", {
      userId,
      count: newCount,
      updatedAt: now,
    });
  }
}

/**
 * Atomic +1 on the `followedCountriesCounts` aggregate row for `country`.
 * Patch if the row exists, insert otherwise. Runs inside the parent
 * mutation transaction so the counter never drifts from the row table
 * (memory: `convex-mutation-from-mutation-not-one-transaction` —
 * intentionally a helper, NOT a child mutation).
 */
async function incrementCountryCounter(
  ctx: MutationCtx,
  country: string,
): Promise<void> {
  const existing = await ctx.db
    .query("followedCountriesCounts")
    .withIndex("by_country", (q) => q.eq("country", country))
    .first();
  const now = Date.now();
  if (existing) {
    await ctx.db.patch(existing._id, {
      count: existing.count + 1,
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("followedCountriesCounts", {
      country,
      count: 1,
      updatedAt: now,
    });
  }
}

/**
 * Atomic -1 on the `followedCountriesCounts` aggregate row for `country`,
 * defensively clamped at zero. No-op if the counter row doesn't exist
 * (the row delete that triggered this decrement was somehow ahead of an
 * insert — should never happen, but max-with-zero ensures we never write
 * a negative count).
 */
async function decrementCountryCounter(
  ctx: MutationCtx,
  country: string,
): Promise<void> {
  const existing = await ctx.db
    .query("followedCountriesCounts")
    .withIndex("by_country", (q) => q.eq("country", country))
    .first();
  if (!existing) return;
  await ctx.db.patch(existing._id, {
    count: Math.max(0, existing.count - 1),
    updatedAt: Date.now(),
  });
}

/**
 * Discriminated return shape for `followCountry` and `unfollowCountry`.
 * `idempotent: true` means the mutation observed the desired end state
 * already and made no changes (counter NOT touched).
 */
export type FollowMutationResult =
  | { ok: true; idempotent: false }
  | { ok: true; idempotent: true };

/**
 * Return shape for `mergeAnonymousLocal`. `accepted` is the list of
 * NEWLY-inserted countries (in canonicalized first-seen order); existing
 * rows are silently deduped against table state. `droppedInvalid` is
 * inputs that failed `isValidIso2`; `droppedDueToCap` is valid-but-
 * over-cap inputs for free users that the client should surface in an
 * upgrade modal. PRO users receive `droppedDueToCap: []`.
 */
export type MergeAnonymousLocalResult = {
  totalCount: number;
  accepted: string[];
  droppedInvalid: string[];
  droppedDueToCap: string[];
};

/**
 * `followCountry({ country })` — authoritative single-country follow.
 *
 * 1. Auth gate: throws ConvexError({kind:'UNAUTHENTICATED'}) if absent.
 * 2. Validates `country` against the canonical ISO-2 registry; throws
 *    ConvexError({kind:'INVALID_COUNTRY', country}) on miss.
 * 3. Idempotent on (userId, country) — second call returns
 *    {idempotent:true} and does NOT touch the counter or user-meta.
 * 4. Free-tier cap: tier=0 callers with currentCount >= FREE_TIER_FOLLOW_LIMIT
 *    throw ConvexError({kind:'FREE_CAP', currentCount, limit}). PRO callers
 *    are unlimited.
 * 5. Atomic counter +1 in the same transaction as the row insert.
 * 6. Atomic per-user-meta count patch — THIS is the OCC-serializing write.
 *
 * Two-tier per-user serialization (cap-bypass mitigation):
 *   Tier 1 — pre-seeded shard row (Codex round-4 P0 v2): EVERY mutation
 *   reads + patches `followedCountriesShards[userIdToShard(userId)]` at
 *   the boundaries of the handler. Because the row is pre-seeded, its
 *   OCC is bulletproof — the loser of two parallel first-ever mutations
 *   retries against the post-winner state and observes the winner's
 *   user-meta insert.
 *
 *   Tier 2 — denormalized user-meta count (Codex round-3 P0): under the
 *   shard lock, we safely lazy-create the per-user `followedCountriesUserMeta`
 *   row (kept additionally for the O(1) cap-check denominator and as the
 *   parity invariant `count === COUNT(followedCountries WHERE userId=X)`).
 *
 * Without Tier 1, two parallel first-ever mutations could both read
 * `meta=undefined`, both INSERT, and produce duplicate meta rows that
 * break the `.unique()` read AND re-open the cap-bypass window. With
 * Tier 1 in place, the brand-new-user race is closed deterministically.
 *
 * Errors are typed `ConvexError({kind, ...})` with object data so callers
 * can branch on `err.data.kind` (memory:
 * `convex-error-string-data-strips-errordata-on-wire`).
 */
export const followCountry = mutation({
  args: { country: v.string() },
  handler: async (ctx, args): Promise<FollowMutationResult> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError({ kind: "UNAUTHENTICATED" });
    const userId = identity.subject;

    if (!isValidIso2(args.country)) {
      throw new ConvexError({
        kind: "INVALID_COUNTRY",
        country: args.country,
      });
    }

    // Tier-1 lock: pre-seeded shard row. Read at top, patch at end.
    const shard = await readShardOrThrow(ctx, userId);

    // Tier-2 read: per-user denormalized count (lazy-created, but safe
    // under the shard lock above).
    const { meta, count: currentCount } = await readUserMeta(ctx, userId);

    const existingRow = await ctx.db
      .query("followedCountries")
      .withIndex("by_user_country", (q) =>
        q.eq("userId", userId).eq("country", args.country),
      )
      .first();
    if (existingRow) {
      return { ok: true, idempotent: true };
    }

    // P3 #21 — Tier-first cap check using the denormalized count. PRO
    // users have no cap (returned for free); for free users the
    // denormalized count is the cap input — no `.collect()` needed.
    const tier = await readEntitlementTier(ctx, userId);
    if (tier < 1 && currentCount >= FREE_TIER_FOLLOW_LIMIT) {
      throw new ConvexError({
        kind: "FREE_CAP",
        currentCount,
        limit: FREE_TIER_FOLLOW_LIMIT,
      });
    }

    await ctx.db.insert("followedCountries", {
      userId,
      country: args.country,
      addedAt: Date.now(),
    });
    await incrementCountryCounter(ctx, args.country);
    // Tier-2 OCC write — patch the user-meta row.
    await writeUserMeta(ctx, userId, meta, currentCount + 1);
    // Tier-1 OCC write — patch the pre-seeded shard row.
    await touchShard(ctx, shard);

    return { ok: true, idempotent: false };
  },
});

/**
 * `unfollowCountry({ country })` — authoritative single-country unfollow.
 *
 * 1. Auth gate.
 * 2. Validates ISO-2.
 * 3. Idempotent on absent: missing row returns {idempotent:true} and does
 *    NOT decrement the counter.
 * 4. Atomic counter -1 (clamped at 0) in the same transaction as the row
 *    delete.
 */
export const unfollowCountry = mutation({
  args: { country: v.string() },
  handler: async (ctx, args): Promise<FollowMutationResult> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError({ kind: "UNAUTHENTICATED" });
    const userId = identity.subject;

    if (!isValidIso2(args.country)) {
      throw new ConvexError({
        kind: "INVALID_COUNTRY",
        country: args.country,
      });
    }

    // Tier-1 lock: pre-seeded shard row. Read at top, patch at end on
    // the non-idempotent path. The idempotent (no-row) branch returns
    // before any write, so there's no race to lose.
    const shard = await readShardOrThrow(ctx, userId);

    // Tier-2 read — see followCountry for full rationale.
    const { meta, count: currentCount } = await readUserMeta(ctx, userId);

    const existingRow = await ctx.db
      .query("followedCountries")
      .withIndex("by_user_country", (q) =>
        q.eq("userId", userId).eq("country", args.country),
      )
      .first();
    if (!existingRow) {
      return { ok: true, idempotent: true };
    }

    await ctx.db.delete(existingRow._id);
    await decrementCountryCounter(ctx, args.country);
    // Tier-2 OCC write — clamp at zero defensively in case a hand-seeded
    // test or migration left meta out of parity. The mutations are the
    // only writers in production; this clamp protects tests.
    await writeUserMeta(ctx, userId, meta, Math.max(0, currentCount - 1));
    // Tier-1 OCC write.
    await touchShard(ctx, shard);

    return { ok: true, idempotent: false };
  },
});

/**
 * `mergeAnonymousLocal({ countries })` — sign-in merge of an anonymous
 * localStorage list into the authoritative table.
 *
 * Algorithm (verbatim, plan U13 step list):
 *   1. Auth gate.
 *   2. Reject empty input with ConvexError({kind:'EMPTY_INPUT'}).
 *   3. Reject inputs > MAX_MERGE_INPUT with INPUT_TOO_LARGE.
 *   4. Filter through isValidIso2; collect droppedInvalid.
 *   5. Canonicalize: dedupe in first-seen order.
 *   6. Read existing rows; build existingSet.
 *   7. newCandidates = canonicalized.filter(c => !existingSet.has(c)).
 *   8. tier=0 free user: accept up to (LIMIT - existingCount); rest →
 *      droppedDueToCap.
 *   9. tier>=1 PRO: accept all newCandidates.
 *  10. Insert accepted rows; +1 counter for each (atomic).
 *  11. Return {totalCount, accepted, droppedInvalid, droppedDueToCap}.
 *  12. If droppedDueToCap.length > 0, log structured warning.
 *
 * Resolves Codex-deepening round-1 P0 (server-side cap on merge) and
 * round-2 P1 (canonicalize duplicates before counting). Free users with
 * existingCount >= LIMIT accept zero new rows — never silently grow above
 * the cap during merge. (Grandfathering above-cap rows on PRO→free
 * downgrade is a separate concern handled by NOT auto-deleting on
 * downgrade; merge is the FIRST sign-in and has no PRO history to
 * grandfather.)
 */
export const mergeAnonymousLocal = mutation({
  args: { countries: v.array(v.string()) },
  handler: async (ctx, args): Promise<MergeAnonymousLocalResult> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError({ kind: "UNAUTHENTICATED" });
    const userId = identity.subject;

    // Step 2: empty-input guard.
    if (args.countries.length === 0) {
      throw new ConvexError({ kind: "EMPTY_INPUT" });
    }

    // Step 3: defensive upper-bound on input length.
    if (args.countries.length > MAX_MERGE_INPUT) {
      throw new ConvexError({
        kind: "INPUT_TOO_LARGE",
        max: MAX_MERGE_INPUT,
        received: args.countries.length,
      });
    }

    // Step 4: ISO-2 registry filter; collect droppedInvalid in input order.
    const droppedInvalid: string[] = [];
    const validInputs: string[] = [];
    for (const code of args.countries) {
      if (isValidIso2(code)) {
        validInputs.push(code);
      } else {
        droppedInvalid.push(code);
      }
    }

    // Step 5: canonicalize — dedupe in first-seen order. Without this, a
    // PRO merge of ['US','US','US'] would attempt 3 inserts and 3 counter
    // increments for one logical follow.
    const seen = new Set<string>();
    const canonicalized: string[] = [];
    for (const code of validInputs) {
      if (!seen.has(code)) {
        seen.add(code);
        canonicalized.push(code);
      }
    }

    // Tier-1 lock: pre-seeded shard row. Read at top, patch at end if
    // any row was actually accepted (no patch on the all-no-op branch
    // since there's no observable change to race on).
    const shard = await readShardOrThrow(ctx, userId);

    // Tier-2 read. Under the shard lock above, the brand-new-user lazy
    // create on `followedCountriesUserMeta` is now race-free.
    const { meta, count: existingCount } = await readUserMeta(ctx, userId);

    // Step 6: read existing rows; build existingSet. Still required for
    // the dedup against (userId, country) — the meta count is a scalar,
    // it can't tell us WHICH countries the user already follows.
    const existingRows = await ctx.db
      .query("followedCountries")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const existingSet = new Set<string>(existingRows.map((r) => r.country));

    // Step 7: filter against existing.
    const newCandidates = canonicalized.filter((c) => !existingSet.has(c));

    // Step 8/9: cap-bounded accept based on entitlement tier. Uses the
    // OCC-tracked meta count as the cap denominator — under concurrency,
    // the loser retries against the post-winner count.
    const tier = await readEntitlementTier(ctx, userId);
    let accepted: string[];
    let droppedDueToCap: string[];
    if (tier < 1) {
      const remaining = Math.max(0, FREE_TIER_FOLLOW_LIMIT - existingCount);
      accepted = newCandidates.slice(0, remaining);
      droppedDueToCap = newCandidates.slice(remaining);
    } else {
      accepted = newCandidates;
      droppedDueToCap = [];
    }

    // Step 10: insert accepted rows + atomic counter +1 each.
    const now = Date.now();
    for (const country of accepted) {
      await ctx.db.insert("followedCountries", {
        userId,
        country,
        addedAt: now,
      });
      await incrementCountryCounter(ctx, country);
    }

    // Tier-2 OCC write — same rule as followCountry. Skip when
    // accepted=[] (no change to count → no write to race on).
    if (accepted.length > 0) {
      await writeUserMeta(ctx, userId, meta, existingCount + accepted.length);
      // Tier-1 OCC write — only on the path that produced observable
      // changes. The all-no-op branch leaves both shard and user-meta
      // untouched.
      await touchShard(ctx, shard);
    }

    // Step 12: structured warning when free users overflow cap. No
    // server-side Sentry SDK in convex/ today; emit a structured
    // console.warn that the platform log aggregator can pick up.
    if (droppedDueToCap.length > 0) {
      const userIdHashed = hashUserIdForLog(userId);
      console.warn(
        JSON.stringify({
          breadcrumb: "followed_countries_merge_cap_drop",
          userIdHashed,
          existingCount,
          droppedCount: droppedDueToCap.length,
        }),
      );
    }

    // Step 11: return shape.
    return {
      totalCount: existingCount + accepted.length,
      accepted,
      droppedInvalid,
      droppedDueToCap,
    };
  },
});

/**
 * Stable, non-cryptographic hash of a userId for log breadcrumbs. We do
 * NOT want raw Clerk subjects in our log aggregator. djb2 is fine — this
 * is for grouping/correlation, not security.
 */
function hashUserIdForLog(userId: string): string {
  let h = 5381;
  for (let i = 0; i < userId.length; i++) {
    h = ((h << 5) + h + userId.charCodeAt(i)) | 0;
  }
  // Convert to unsigned 32-bit hex for compact log readability.
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Queries (plan U14)
// ---------------------------------------------------------------------------

/**
 * `listFollowed()` — auth'd reactive read of the current user's watchlist.
 *
 * Returns ONLY the country codes (string[]); `addedAt` and `userId` are
 * not exposed to clients. Sorted by `addedAt` ascending (earliest-added
 * first) so the client gets a stable, intuitive order — the country a
 * user followed first appears first.
 *
 * If no auth identity is present, returns `[]` (consistent with
 * `convex/alertRules.ts::getAlertRules`). Reactive: Convex will
 * auto-resubscribe whenever the underlying `followedCountries` rows for
 * this user change.
 */
export const listFollowed = query({
  args: {},
  handler: async (ctx): Promise<string[]> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const rows = await ctx.db
      .query("followedCountries")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .collect();
    // Sort by addedAt ascending — earliest-added first. Documented choice
    // (plan U14 test scenario: PRO user with `['US','GB']` added in that
    // order returns `['US','GB']`).
    return rows
      .sort((a, b) => a.addedAt - b.addedAt)
      .map((r) => r.country);
  },
});

/**
 * `countFollowers({ country })` — public, no auth.
 *
 * O(1) read of the aggregate `followedCountriesCounts` row. Validates
 * the input as canonical ISO-2 (rejects `INVALID`, `us`, `XX`, etc.)
 * and returns the count.
 *
 * Privacy floor (P2 #12 — doc/code alignment):
 *   `raw < COUNTRY_COUNT_PRIVACY_FLOOR` returns 0. With
 *   COUNTRY_COUNT_PRIVACY_FLOOR=5, counts of 1-4 followers return 0; a
 *   count of 5 or more is returned exactly. The unbucketed count is
 *   internally accessible to ops via direct DB reads on the
 *   `followedCountriesCounts` table — this floor only applies at the
 *   public-query layer.
 */
export const countFollowers = query({
  args: { country: v.string() },
  handler: async (ctx, args): Promise<number> => {
    if (!isValidIso2(args.country)) {
      throw new ConvexError({
        kind: "INVALID_COUNTRY",
        country: args.country,
      });
    }
    const row = await ctx.db
      .query("followedCountriesCounts")
      .withIndex("by_country", (q) => q.eq("country", args.country))
      .first();
    const raw = row?.count ?? 0;
    // `<` is the canonical comparator: returns 0 when count is below
    // COUNTRY_COUNT_PRIVACY_FLOOR (1-4 followers); count of 5 or more
    // is returned exactly.
    if (raw < COUNTRY_COUNT_PRIVACY_FLOOR) return 0;
    return raw;
  },
});

/**
 * `listFollowersPage({ country, cursor, limit })` — INTERNAL-ONLY
 * paginated cursor over the followers of a country.
 *
 * Declared via `internalQuery` (NOT `query`) so it never appears in
 * `api.followedCountries` — only in `internal.followedCountries`. This
 * is the privacy boundary: follower lists are never publicly readable.
 *
 * `limit` is clamped to `[1, 500]` defensively so a buggy/abusive
 * caller can't request a 10k-element response.
 *
 * Returns `{ userIds, nextCursor }` where `nextCursor` is `null` when
 * Convex's paginator reports `isDone`.
 */
export const listFollowersPage = internalQuery({
  args: {
    country: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ userIds: string[]; nextCursor: string | null }> => {
    if (!isValidIso2(args.country)) {
      throw new ConvexError({
        kind: "INVALID_COUNTRY",
        country: args.country,
      });
    }
    const clampedLimit = Math.max(1, Math.min(500, args.limit));
    const result = await ctx.db
      .query("followedCountries")
      .withIndex("by_country", (q) => q.eq("country", args.country))
      .paginate({ cursor: args.cursor ?? null, numItems: clampedLimit });
    return {
      userIds: result.page.map((r) => r.userId),
      nextCursor: result.isDone ? null : result.continueCursor,
    };
  },
});

/**
 * `internalListFollowedForUser({ userId })` — INTERNAL-ONLY helper
 * used by the `/relay/followed-countries` HTTP action.
 *
 * The relay has no Clerk identity (it authenticates via the shared
 * secret in the Authorization header), so it can't call the public
 * `listFollowed`. This helper takes an explicit `userId` and returns
 * the same `string[]` shape. Sorting matches `listFollowed`: by
 * `addedAt` ascending.
 */
export const internalListFollowedForUser = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<string[]> => {
    const rows = await ctx.db
      .query("followedCountries")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    return rows
      .sort((a, b) => a.addedAt - b.addedAt)
      .map((r) => r.country);
  },
});

// ---------------------------------------------------------------------------
// Sharded-lock seed (Codex round-4 P0 v2)
// ---------------------------------------------------------------------------

/**
 * `_seedShards()` — INTERNAL-ONLY, idempotent pre-seeder for the
 * `followedCountriesShards` table. Inserts rows for every shard id in
 * `[0, SHARD_COUNT)` that doesn't already exist; existing rows are left
 * alone (the `lastTouchedAt` value is opaque — it's only used as the
 * OCC-tracking field, never read for application logic).
 *
 * Wired into:
 *   - `convex/crons.ts` daily cron (idempotent, cheap — defends against
 *     a deploy-time seed step being skipped). Runs alongside
 *     `_dedupeShards` so any concurrent-seed duplicates self-heal within
 *     24h.
 *   - `.github/workflows/convex-deploy.yml` post-deploy step — operator
 *     surface is `npx convex run --prod followedCountries:_seedShards`.
 *     `npx convex run` targets internal functions by their file:export
 *     path, so a public-mutation wrapper is unnecessary (and was a
 *     security hazard — see Codex round-3 P1).
 *
 * Returns `{ seeded: N }` — the number of NEW rows inserted. After
 * steady-state, every call returns `{ seeded: 0 }` and the table has
 * exactly SHARD_COUNT rows.
 *
 * Concurrent-seed race: two simultaneous calls against an empty table
 * both read empty, both compute `have` as empty, and both insert the
 * full range — producing 128 rows (2 per `shardId`). This is a real
 * possibility on a re-deploy that races the daily cron. The race is
 * tolerated rather than prevented: `readShardOrThrow` uses `.first()`
 * (not `.unique()`), so duplicates never break a follow/unfollow/merge
 * mutation; `_dedupeShards` runs in the same daily cron and removes
 * extras, restoring exactly one row per shardId. The user-meta count
 * remains the authoritative cap denominator, so cap correctness is
 * unaffected by transient duplicates.
 */
export const _seedShards = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ seeded: number }> => {
    const existing = await ctx.db
      .query("followedCountriesShards")
      .collect();
    const have = new Set<number>(existing.map((r) => r.shardId));
    const now = Date.now();
    let seeded = 0;
    for (let i = 0; i < SHARD_COUNT; i++) {
      if (!have.has(i)) {
        await ctx.db.insert("followedCountriesShards", {
          shardId: i,
          lastTouchedAt: now,
        });
        seeded += 1;
      }
    }
    return { seeded };
  },
});

/**
 * `_dedupeShards()` — INTERNAL-ONLY daily cron companion to `_seedShards`.
 * Walks the `followedCountriesShards` table, groups by `shardId`, and
 * deletes all but the OLDEST row (by `_creationTime`) for any shardId
 * with `count > 1`. The "oldest" choice is intentional — under a
 * concurrent-seed race, the loser's row is what `readShardOrThrow`'s
 * `.first()` returned to in-flight mutations between the race and this
 * cleanup, so the oldest row already has the most "real" `lastTouchedAt`
 * traffic and is the safer survivor.
 *
 * After every daily run the table satisfies `count = SHARD_COUNT` AND
 * `every shardId in [0, SHARD_COUNT)` appears exactly once. Idempotent
 * in the steady-state (no duplicates → no deletes).
 *
 * Returns `{ deleted: N }` — the number of duplicate rows removed.
 */
export const _dedupeShards = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ deleted: number }> => {
    const all = await ctx.db.query("followedCountriesShards").collect();
    // Group by shardId; for each group with > 1 row, keep the oldest by
    // `_creationTime` and delete the rest.
    const byShard = new Map<number, Doc<"followedCountriesShards">[]>();
    for (const row of all) {
      const list = byShard.get(row.shardId);
      if (list) {
        list.push(row);
      } else {
        byShard.set(row.shardId, [row]);
      }
    }
    let deleted = 0;
    for (const rows of byShard.values()) {
      if (rows.length <= 1) continue;
      // Sort ascending by `_creationTime` — oldest first.
      rows.sort((a, b) => a._creationTime - b._creationTime);
      // Keep [0]; delete [1..]. `noUncheckedIndexedAccess` requires the
      // explicit `extra !== undefined` guard even though the loop bound
      // makes it unreachable.
      for (let i = 1; i < rows.length; i++) {
        const extra = rows[i];
        if (extra !== undefined) {
          await ctx.db.delete(extra._id);
          deleted += 1;
        }
      }
    }
    return { deleted };
  },
});
