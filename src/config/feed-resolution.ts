import type { Feed } from '@/types';

// ─────────────────────────────────────────────────────────────────────────────
// Panel-driven (not variant-driven) feed resolution.
//
// A "variant" (full / tech / finance / commodity / energy / happy) is only a
// PRESET — the default set of enabled panels. Users freely customize: a `full`
// user can add the Tech `startups` panel, a `tech` user can add `middleeast`,
// etc. The data layer must follow the user's ENABLED PANELS, not the variant.
//
// Before this module, `loadNews()` iterated the active variant's `FEEDS` map,
// so any enabled news panel whose category wasn't in that one variant's preset
// never had its feeds fetched and the panel sat on "Loading..." forever.
//
// `mergeCanonicalFeeds` builds the union of every variant's feed map;
// `resolveNewsCategories` then loads the active preset PLUS whatever extra
// categories the user's enabled panels require.
// ─────────────────────────────────────────────────────────────────────────────

/** Stable dedup key for a feed — handles both single-URL and multi-URL feeds. */
function feedKey(feed: Feed): string {
  return typeof feed.url === 'string' ? feed.url : JSON.stringify(feed.url);
}

/**
 * Merge multiple variant feed maps into one canonical category→feeds map.
 * For category keys present in more than one variant, feeds are unioned and
 * deduped by URL (first occurrence wins, so earlier maps in the list take
 * precedence for shared keys).
 */
export function mergeCanonicalFeeds(
  variantMaps: Array<Record<string, Feed[]>>,
): Record<string, Feed[]> {
  const merged: Record<string, Feed[]> = {};
  for (const map of variantMaps) {
    for (const [category, feeds] of Object.entries(map)) {
      if (!Array.isArray(feeds)) continue;
      const bucket = merged[category] ?? (merged[category] = []);
      const seen = new Set(bucket.map(feedKey));
      for (const feed of feeds) {
        const key = feedKey(feed);
        if (!seen.has(key)) {
          bucket.push(feed);
          seen.add(key);
        }
      }
    }
  }
  return merged;
}

export interface ResolvedCategory {
  key: string;
  feeds: Feed[];
  /**
   * `true` when the category is NOT part of the active variant's preset — it
   * comes from a user-customized panel. The server digest is built per-variant
   * and won't carry it, so it must be loaded via direct client-side fetch.
   */
  isCustom: boolean;
}

/**
 * Resolve every news category that should be loaded for the current session:
 * the active variant's preset categories, PLUS any extra categories required
 * by enabled news panels the preset doesn't cover (user customization).
 *
 * @param presetFeeds      the active variant's `FEEDS` map
 * @param canonicalFeeds   merged map covering every category across all variants
 * @param enabledPanelKeys keys of the news panels the user actually has enabled
 *                         (i.e. `Object.keys(ctx.newsPanels)`)
 */
export function resolveNewsCategories(
  presetFeeds: Record<string, Feed[]>,
  canonicalFeeds: Record<string, Feed[]>,
  enabledPanelKeys: Iterable<string>,
): ResolvedCategory[] {
  const resolved: ResolvedCategory[] = [];
  const presetKeys = new Set<string>();

  for (const [key, feeds] of Object.entries(presetFeeds)) {
    if (Array.isArray(feeds) && feeds.length > 0) {
      resolved.push({ key, feeds, isCustom: false });
      presetKeys.add(key);
    }
  }

  const seenCustom = new Set<string>();
  for (const key of enabledPanelKeys) {
    if (presetKeys.has(key) || seenCustom.has(key)) continue;
    const feeds = canonicalFeeds[key];
    if (Array.isArray(feeds) && feeds.length > 0) {
      resolved.push({ key, feeds, isCustom: true });
      seenCustom.add(key);
    }
  }

  return resolved;
}
