/**
 * U6 — Pure partition helper for CIIPanel pin-to-top.
 *
 * Extracted from `CIIPanel.ts::partitionByFollowed` so the row-ordering
 * contract can be unit-tested without pulling in `Panel.ts`'s
 * `import.meta.glob` + DOM transitive deps. The panel imports this helper
 * directly; tests stub the `getFollowed()` source via the function param.
 *
 * Stable: uses `filter` (NOT a `sort` with comparator — memory
 * `sort-before-positional-index`). Followed countries appear first in
 * their original relative order; unfollowed countries follow in their
 * original relative order. Followed-but-absent codes are silently
 * dropped (the filter only matches against the input scores list).
 */

export interface PartitionableScore {
  code: string;
}

export interface PartitionResult<T extends PartitionableScore> {
  followed: T[];
  unfollowed: T[];
}

/**
 * Partition scores into a top group of followed-then-unfollowed.
 *
 * `followedCodes` is typically the result of
 * `getFollowed()` from `src/services/followed-countries.ts` — the
 * service guarantees `[]` when the feature flag is off, which falls
 * through to `followed=[], unfollowed=scores` here (i.e. behaviour
 * identical to today).
 *
 * Codes in `followedCodes` that are not present in `scores` are silently
 * ignored — there's no row to pin and no error to surface.
 */
export function partitionByFollowed<T extends PartitionableScore>(
  scores: T[],
  followedCodes: ReadonlyArray<string>,
): PartitionResult<T> {
  if (followedCodes.length === 0) {
    return { followed: [], unfollowed: scores };
  }
  const followedSet = new Set(followedCodes);
  if (followedSet.size === 0) {
    return { followed: [], unfollowed: scores };
  }
  const followed = scores.filter((s) => followedSet.has(s.code));
  const unfollowed = scores.filter((s) => !followedSet.has(s.code));
  return { followed, unfollowed };
}

/**
 * Decision predicate the panel uses to decide whether to render section
 * labels ("Following" / "All") between the two groups. We render the
 * labels ONLY when BOTH groups are non-empty — otherwise the user sees
 * a single-section list and the labels would be visual noise.
 */
export function shouldRenderSectionLabels<T extends PartitionableScore>(
  partition: PartitionResult<T>,
): boolean {
  return partition.followed.length > 0 && partition.unfollowed.length > 0;
}
