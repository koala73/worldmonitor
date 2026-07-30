/**
 * Sharded-lock helper for the followed-countries watchlist primitive.
 *
 * The pre-seeded `followedCountriesShards` table holds one row per shard
 * id `0..SHARD_COUNT-1`. Every mutation that touches `followedCountries`
 * for a user maps the user's id to a shard via `userIdToShard()` below,
 * reads + patches that shard row, and lets Convex's per-document OCC
 * serialize concurrent same-user mutations. Because the shards are
 * pre-seeded (never lazily created), there is no nested TOCTOU window —
 * unlike the original `followedCountriesUserMeta` lazy-create approach
 * (Codex round-3 P0), which left two parallel first-ever mutations from
 * the same user free to both INSERT a fresh meta row.
 *
 * The hash is intentionally non-cryptographic (djb2). All it needs to do
 * is map distinct userIds to a roughly uniform shard distribution; a
 * collision between two different users is correctness-preserving (it
 * just adds an extra serialization point) and not a security concern.
 *
 * SHARD_COUNT is fixed at deploy time and CANNOT change without
 * re-seeding all rows AND draining in-flight mutations. See
 * `convex/constants.ts::SHARD_COUNT`.
 */

import { SHARD_COUNT } from "../constants";

/**
 * Deterministic non-cryptographic hash of a userId → shard id in
 * `[0, SHARD_COUNT)`. Uses djb2 with bitwise XOR to keep the hash inside
 * 32-bit signed range (matches the existing `hashUserIdForLog` shape in
 * `convex/followedCountries.ts`).
 *
 * MUST stay deterministic: changing the hash function would silently
 * remap every existing user to a new shard mid-deploy, briefly breaking
 * the OCC serialization for any user whose new shard differs from their
 * old shard. Treat as a frozen contract once shipped.
 */
export function userIdToShard(userId: string): number {
  let h = 5381;
  for (let i = 0; i < userId.length; i++) {
    h = ((h << 5) + h) ^ userId.charCodeAt(i);
  }
  return Math.abs(h) % SHARD_COUNT;
}
