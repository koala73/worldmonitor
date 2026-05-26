import { v } from "convex/values";

export const channelTypeValidator = v.union(
  v.literal("telegram"),
  v.literal("slack"),
  v.literal("email"),
  v.literal("discord"),
  v.literal("webhook"),
  v.literal("web_push"),
);

export const sensitivityValidator = v.union(
  v.literal("all"),
  v.literal("high"),
  v.literal("critical"),
);

export const quietHoursOverrideValidator = v.union(
  v.literal("critical_only"),
  v.literal("silence_all"),
  v.literal("batch_on_wake"),
);

export const digestModeValidator = v.union(
  v.literal("realtime"),
  v.literal("daily"),
  v.literal("twice_daily"),
  v.literal("weekly"),
);

export const CURRENT_PREFS_SCHEMA_VERSION = 1;

export const MAX_PREFS_BLOB_SIZE = 65536;

// Followed-countries (watchlist primitive) constants. See
// docs/plans/2026-05-02-001-feat-followed-countries-watchlist-primitive-plan.md
// (U12) for context. These three constants are consumed by the
// `convex/followedCountries.ts` mutations/queries (U13/U14).

// Free-tier ceiling on the number of countries a single user can follow.
// Enforced authoritatively in `followCountry` and `mergeAnonymousLocal`.
// PRO users (entitlement tier >= 1) are unlimited. The cap is also the
// "grandfather floor" — existing rows above the cap on downgrade are
// never auto-deleted; only NEW follows are blocked while free.
export const FREE_TIER_FOLLOW_LIMIT = 3;

// Defensive ceiling on `mergeAnonymousLocal({ countries })` input length.
// Prevents quadratic-cost abuse via patched localStorage shipping a
// pathological array. Inputs larger than this are rejected with
// `ConvexError({ kind: 'INPUT_TOO_LARGE' })`.
export const MAX_MERGE_INPUT = 100;

// Privacy floor for the public `countFollowers` query: counts strictly
// below this threshold are returned as `0` to public callers so a single
// follower can't be deanonymized via the count endpoint.
export const COUNTRY_COUNT_PRIVACY_FLOOR = 5;

// Number of pre-seeded lock shards in `followedCountriesShards`. Every
// `followCountry` / `unfollowCountry` / `mergeAnonymousLocal` mutation
// reads + patches the shard row at `userIdToShard(userId)` so Convex's
// per-document OCC serializes concurrent same-user mutations against an
// always-existing row. Without a pre-seeded shard table, the lazy-create
// path on `followedCountriesUserMeta` had a nested TOCTOU: two parallel
// first-ever mutations from the same brand-new user could both read
// `meta=undefined` and both INSERT, producing duplicate meta rows that
// break the `.unique()` read and re-open the cap-bypass window
// (Codex round-4 P0 v2).
//
// SHARD_COUNT is fixed at deploy time — changing it would require
// re-seeding ALL shard rows AND draining all in-flight mutations. Set
// once and treat as immutable. 64 is enough headroom that two random
// users colliding on the same shard is rare; collisions are correctness-
// preserving (just an extra serialization point), not a bug.
export const SHARD_COUNT = 64;
