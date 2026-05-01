// Free-tier source-cap distribution.
//
// Replaces the prior alphabetical-slice enforcement that silently auto-disabled
// every source past position N in a sorted list — which catastrophically broke
// late-alphabet categories. With FREE_MAX_SOURCES=80 and ~30 categories, the
// alphabetical strategy left entire categories ('Layoffs', 'Semiconductors &
// Hardware', 'IPO & SPAC', 'Funding & VC', 'Product Hunt', etc.) with ALL
// their sources auto-disabled, producing the "All sources disabled" red panel
// state on the homepage with no user explanation.
//
// New strategy: round-robin across category buckets so the cap is spent
// fairly. Every category with at least one enabled-eligible source keeps at
// least one slot until the cap is exhausted. Within a category, sources are
// taken in `feeds.ts` declaration order — editorial team controls "primary"
// by listing the most important source first.

export interface FeedItem {
  name: string;
}

export interface FeedsByCategory {
  [category: string]: ReadonlyArray<FeedItem> | undefined;
}

export interface SourceCapResult {
  /** Sources that should remain enabled. */
  keep: Set<string>;
  /** Sources that the cap auto-disabled (excludes user's explicit disables). */
  autoDisabled: Set<string>;
}

/**
 * Detect categories where 100% of sources are in the disabled set — the
 * fingerprint of the pre-2026-05-01 free-tier alphabetical-slice cap bug.
 * Returns the source names that should be re-enabled.
 *
 * Used to recover Pro users (and free users on a fresh deploy) whose
 * localStorage `disabledFeeds` state was poisoned by the v1 enforcement.
 * The 100%-disabled-category heuristic is targeted enough that explicit
 * user disabling of single sources is preserved — only fully-starved
 * categories (which a real user would just hide as a panel, not toggle
 * source-by-source) get recovered.
 *
 * @param feedsByCategory  category-keyed map of feed lists
 * @param disabled         current disabled-source set (mixed user + auto)
 * @returns                source names from any fully-disabled category
 */
export function findFullyDisabledCategories(
  feedsByCategory: FeedsByCategory,
  disabled: ReadonlySet<string>,
): string[] {
  const recoverable: string[] = [];
  for (const feeds of Object.values(feedsByCategory)) {
    if (!feeds || feeds.length === 0) continue;
    if (feeds.every((f) => disabled.has(f.name))) {
      for (const f of feeds) recoverable.push(f.name);
    }
  }
  return recoverable;
}

/**
 * Distribute the source cap fairly across feed categories.
 *
 * @param feedsByCategory  category-keyed map of feed lists (typically `FEEDS`)
 * @param intelSources     flat list of intel sources (treated as one bucket)
 * @param userDisabled     sources the user has explicitly disabled — these
 *                         are excluded from consideration entirely. Caller
 *                         is responsible for distinguishing user-disabled
 *                         from auto-disabled if needed.
 * @param cap              maximum number of sources to keep enabled
 *
 * Deterministic given the same inputs. Reload-stable (Object.entries
 * preserves insertion order in modern JS engines, and feeds.ts declaration
 * order is fixed at compile time).
 */
export function selectSourcesUnderCap(
  feedsByCategory: FeedsByCategory,
  intelSources: ReadonlyArray<FeedItem>,
  userDisabled: ReadonlySet<string>,
  cap: number,
): SourceCapResult {
  if (cap < 0) {
    return { keep: new Set(), autoDisabled: new Set() };
  }

  // Build per-category queues of eligible sources (excluding user-disabled).
  // Each queue is a mutable array so we can shift() in round-robin order.
  const buckets: Array<{ category: string; remaining: string[] }> = [];
  for (const [category, feeds] of Object.entries(feedsByCategory)) {
    if (!feeds) continue;
    const names = feeds.map((f) => f.name).filter((n) => !userDisabled.has(n));
    if (names.length > 0) buckets.push({ category, remaining: names });
  }
  const intelNames = intelSources.map((f) => f.name).filter((n) => !userDisabled.has(n));
  if (intelNames.length > 0) buckets.push({ category: '__intel__', remaining: intelNames });

  const keep = new Set<string>();

  // Round-robin: take one source from each non-empty bucket per pass until
  // the cap is reached or all buckets are exhausted.
  let madeProgress = true;
  while (keep.size < cap && madeProgress) {
    madeProgress = false;
    for (const bucket of buckets) {
      if (keep.size >= cap) break;
      if (bucket.remaining.length === 0) continue;
      keep.add(bucket.remaining.shift()!);
      madeProgress = true;
    }
  }

  // Anything still in a bucket's `remaining` queue didn't make the cut.
  // These are auto-disabled by the cap (NOT user-disabled).
  const autoDisabled = new Set<string>();
  for (const bucket of buckets) {
    for (const name of bucket.remaining) autoDisabled.add(name);
  }

  return { keep, autoDisabled };
}
