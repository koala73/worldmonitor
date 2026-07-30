import { effectivePubDateMs } from '@/services/feed-date';
import type { NewsItem } from '@/types';

// ─────────────────────────────────────────────────────────────────────────────
// Rotation + accumulation for CUSTOM news categories.
//
// A custom category is one a user added from another variant's panel set. The
// per-variant server digest never carries it, so direct per-feed fetch is its
// ONLY path — and every per-feed fallback is capped at
// `perFeedFallbackCategoryFeedLimit` feeds so a session with several customized
// panels can't fan out into 19 direct proxy round-trips per load (#5376).
//
// For a PRESET category that cap is a degraded-mode ceiling: it only bites while
// the digest is unavailable. For a custom one it is the steady state, and the
// original `feeds.slice(0, cap)` made it a FIXED PREFIX — feeds 4..N of a
// customized panel were unreachable on every load and every refresh, not sampled
// and not rotated, while the Sources manager still listed all N as enabled
// (#5873).
//
// The fix keeps the per-load request budget exactly where #5376 put it and
// changes only WHICH feeds each load spends it on:
//
//   • `selectRotatingFeedWindow` advances the window by the cap each cycle, so
//     the same `cap` requests reach every source within ceil(N / cap) cycles.
//   • `mergeRotatedNewsItems` accumulates across cycles instead of replacing, so
//     rotation doesn't swap the panel's contents wholesale on every refresh.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `cap`-wide slice of `feeds` this rotation cycle should fetch.
 *
 * The window starts at `(cycle * maxFeeds) % feeds.length` and WRAPS, so every
 * cycle spends exactly the cap (a truncating slice would make the final cycle
 * of each lap cheaper and leave the wrapped-past feeds under-sampled). Because
 * each window is `maxFeeds` CONSECUTIVE feeds rather than a single strided
 * pick, coverage completes in ceil(N / maxFeeds) cycles for every N — including
 * the N that share a factor with the cap, where a strided pick would orbit a
 * subset forever.
 *
 * Cycle 0 returns the leading prefix, so a first load (and the request-budget
 * e2e spec that pins it) sees exactly the pre-rotation feed set.
 */
export function selectRotatingFeedWindow<T>(feeds: readonly T[], maxFeeds: number, cycle: number): T[] {
  const total = feeds.length;
  const size = Number.isFinite(maxFeeds) ? Math.floor(maxFeeds) : 0;
  if (total === 0 || size <= 0) return [];
  if (total <= size) return [...feeds];

  // A persisted cycle can come back corrupt (hand-edited localStorage, a value
  // written by an older schema). Normalize rather than propagate: a NaN start
  // would index `undefined` into the fetch list.
  const safeCycle = Number.isFinite(cycle) ? Math.trunc(cycle) : 0;
  const start = (((safeCycle * size) % total) + total) % total;

  const window: T[] = [];
  for (let offset = 0; offset < size; offset += 1) {
    window.push(feeds[(start + offset) % total]!);
  }
  return window;
}

/**
 * The cycle to persist after `selectRotatingFeedWindow` has been called.
 *
 * Wraps at `feedCount` because `start` is `(cycle * cap) % feedCount` — the
 * feed count is exactly the period of the window, so wrapping there keeps the
 * persisted counter a single digit or two without ever shifting which feeds a
 * cycle selects. Non-finite and negative inputs reset to 0 rather than
 * propagating a corrupt value into the window calculation.
 */
export function nextRotationCycle(cycle: number, feedCount: number): number {
  const period = Number.isFinite(feedCount) ? Math.max(1, Math.floor(feedCount)) : 1;
  if (!Number.isFinite(cycle) || cycle < 0) return 0;
  return (Math.trunc(cycle) + 1) % period;
}

export interface MergeRotatedOptions {
  /** Hard ceiling on the merged set — bounds memory and clustering input. */
  maxItems: number;
  /**
   * Source names the user currently has ENABLED (`ctx.disabledSources`
   * inverted). Applied to carry-over AND fresh items: a merge that skipped it
   * would keep a switched-off source on screen indefinitely, which is the same
   * "settings say one thing, the panel does another" defect #5873 is about.
   */
  enabledSources: ReadonlySet<string>;
}

function dedupeKey(item: NewsItem): string {
  // `link` is the stable identity for a feed item. Items synthesized without
  // one fall back to source+title so repeated cycles don't stack duplicates.
  return item.link ? `u\u0000${item.link}` : `t\u0000${item.source}\u0000${item.title}`;
}

/**
 * Merge this cycle's freshly fetched items with what the panel already shows.
 *
 * Rotation only helps if the panel ACCUMULATES: replacing wholesale would swap
 * the visible headlines for a different three sources every refresh, which is a
 * churn regression, and would leave coverage pinned at the per-cycle cap
 * forever.
 *
 * The cap is SOURCE-FAIR (round-robin across sources, newest-first within each)
 * rather than pure newest-first, and that is load-bearing rather than a nicety.
 * Each cycle's freshly fetched sources carry current timestamps while
 * previously-fetched sources are frozen at the time they were fetched, so a
 * plain newest-first cap evicts precisely the carry-over this function exists to
 * preserve — the panel would fall back to showing only the current cycle's
 * sources and coverage would plateau at the cap instead of climbing to the full
 * source list.
 *
 * When more sources are represented than `maxItems` allows, the sources with the
 * oldest newest-item are the ones dropped. That is honest rather than hidden:
 * `countRepresentedSources` reads the returned set, so the panel's coverage
 * badge reports what actually survived.
 *
 * No age bound is applied here. Freshness is a DISPLAY decision owned by
 * `filterItemsByTimeRange` (7d by default, wide enough to span a full rotation
 * lap); this function owns identity, enablement and size.
 */
export function mergeRotatedNewsItems(
  carryOver: readonly NewsItem[],
  fresh: readonly NewsItem[],
  options: MergeRotatedOptions,
): NewsItem[] {
  const maxItems = Number.isFinite(options.maxItems) ? Math.floor(options.maxItems) : 0;
  if (maxItems <= 0) return [];

  // Fresh copies overwrite carry-over ones: the rotation window wraps, so a
  // source IS periodically re-fetched, and the second fetch carries newer
  // enrichment (threat classification, importance score) the older copy predates.
  const byKey = new Map<string, NewsItem>();
  for (const item of carryOver) {
    if (options.enabledSources.has(item.source)) byKey.set(dedupeKey(item), item);
  }
  for (const item of fresh) {
    if (options.enabledSources.has(item.source)) byKey.set(dedupeKey(item), item);
  }

  const bySource = new Map<string, NewsItem[]>();
  for (const item of byKey.values()) {
    const bucket = bySource.get(item.source);
    if (bucket) bucket.push(item);
    else bySource.set(item.source, [item]);
  }
  if (bySource.size === 0) return [];

  const newestFirst = (a: NewsItem, b: NewsItem) => effectivePubDateMs(b) - effectivePubDateMs(a);
  const buckets = [...bySource.entries()]
    .map(([source, items]) => {
      items.sort(newestFirst);
      return { source, items };
    })
    // Deterministic order: freshest source first, name as the tiebreak so an
    // identical input can never produce two different panels.
    .sort((a, b) => {
      const delta = effectivePubDateMs(b.items[0]!) - effectivePubDateMs(a.items[0]!);
      return delta !== 0 ? delta : a.source.localeCompare(b.source);
    });

  const selected: NewsItem[] = [];
  const deepest = Math.max(...buckets.map(bucket => bucket.items.length));
  for (let depth = 0; depth < deepest && selected.length < maxItems; depth += 1) {
    for (const bucket of buckets) {
      if (selected.length >= maxItems) break;
      const item = bucket.items[depth];
      if (item) selected.push(item);
    }
  }

  return selected.sort(newestFirst);
}

/**
 * How many distinct sources the given (already merged) item set actually shows.
 *
 * Derived from the rendered items rather than tracked separately so it cannot
 * drift: a source that was fetched but returned nothing, or whose items lost
 * their slot to the merge cap, is genuinely not on screen and must not be
 * counted as covered.
 */
export function countRepresentedSources(items: readonly NewsItem[]): number {
  const sources = new Set<string>();
  for (const item of items) sources.add(item.source);
  return sources.size;
}
