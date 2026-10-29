import { effectivePubDateMs } from '@/services/feed-date';
import type { NewsItem } from '@/types';

export interface SourceFairMergeOptions {
  /** Hard ceiling on the merged set — bounds memory and clustering input. */
  maxItems: number;
  /**
   * Source names the user currently has ENABLED (`ctx.disabledSources`
   * inverted). A switched-off source must not stay on screen.
   */
  enabledSources: ReadonlySet<string>;
}

function dedupeKey(item: NewsItem): string {
  // `link` is the stable identity for a feed item. Items synthesized without
  // one fall back to source+title.
  return item.link ? `u\u0000${item.link}` : `t\u0000${item.source}\u0000${item.title}`;
}

/**
 * Merge the items several edition digests deliver for one category, deduped
 * and capped at `maxItems`.
 *
 * The cap is SOURCE-FAIR (round-robin across sources, newest-first within
 * each) rather than pure newest-first, so one fast-publishing source in one
 * edition cannot crowd every other source out of the merged panel. When more
 * sources are represented than `maxItems` allows, the sources with the oldest
 * newest-item are the ones dropped.
 *
 * No age bound is applied here. Freshness is a DISPLAY decision owned by
 * `filterItemsByTimeRange`; this function owns identity, enablement and size.
 */
export function mergeSourceFairNewsItems(items: readonly NewsItem[], options: SourceFairMergeOptions): NewsItem[] {
  const maxItems = Number.isFinite(options.maxItems) ? Math.floor(options.maxItems) : 0;
  if (maxItems <= 0) return [];

  const byKey = new Map<string, NewsItem>();
  for (const item of items) {
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
    .map(([source, sourceItems]) => {
      sourceItems.sort(newestFirst);
      return { source, items: sourceItems };
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
