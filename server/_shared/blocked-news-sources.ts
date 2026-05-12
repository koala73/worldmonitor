/**
 * Source names dropped for commercial-usage permissions. Used as a defensive
 * filter at every news response boundary: even if a cached digest still has
 * items from one of these outlets, we strip them before returning so users
 * never see them.
 *
 * Why a runtime filter instead of just cache invalidation: the per-feed
 * caches (10 min TTL) and digest caches (~30 s TTL) each materialize items
 * from the source list at fetch time. Bumping the cache key forces a one-
 * shot rebuild but doesn't catch stale data that's already in flight, and
 * doesn't help if a source slips back into the config later. Filtering at
 * the response boundary is permanent defense in depth.
 *
 * Matching is by EXACT source name as it appears in `_sources.ts` /
 * `_feeds.ts`. We deliberately do NOT match by URL or domain — multiple
 * feeds can share a source name (e.g. direct RSS + a gn site: scraper),
 * and we only want to block the names whose ALL backing feeds have been
 * removed from the config. If a source name still has at least one
 * allowed feed, it stays out of this list.
 *
 * Keep this synchronized with feed removals in:
 *   - server/live-news/v1/_sources.ts
 *   - server/worldmonitor/news/v1/_feeds.ts
 */
export const BLOCKED_SOURCE_NAMES: ReadonlySet<string> = new Set([
  // BBC — RSS ToS forbids commercial use across all BBC feeds.
  'BBC News World',
  'BBC Middle East',
  'BBC Europe',
  'BBC Africa',
  'BBC World',
  'BBC Asia',
  'BBC Persian',
  'BBC Latin America',

  // CNN — RSS Terms of Use forbid commercial use.
  'CNN Top',
  'CNN World',

  // News Corp / aggressive enforcement.
  'Fox News',
  'NYPost',
  'Wall Street Journal',

  // Other aggressive non-commercial publishers.
  'Times of Israel',
  'Defense News',
  'Financial Times',
  'Seeking Alpha',
  'Seeking Alpha Metals',

  // Wire services / aggressive publishers reached via Google News site: scrapers.
  'AP News',
  'Reuters World',
  'Reuters US',
  'Reuters Business',
  'Reuters Energy',
  'Reuters Commodities',
  'Bloomberg Commodities',
  'MarketWatch',
  'Nikkei Asia',
  'South China Morning Post',
  'Asia News',
  'S&P Global Commodity',
  'CNBC Commodities',
  'Kitco News',
  'Kitco Gold',
  'Mining Journal',
  'Northern Miner',
  'Mining Weekly',
  'Arabian Business',
  'Arab News',
]);

export function isBlockedSource(name: string | null | undefined): boolean {
  if (!name) return false;
  return BLOCKED_SOURCE_NAMES.has(name);
}
