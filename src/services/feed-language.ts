import type { Feed } from '@/types';

/**
 * Whether a feed is fetchable in a given UI language.
 *
 * A feed with no explicit `lang` is universal (or multi-URL, resolved per
 * language inside `fetchFeed`). A feed that declares one is only fetched when
 * it matches — `fetchCategoryFeeds` drops the rest before it batches.
 *
 * Extracted so callers that must reason about a category's REACHABLE feed set
 * share this rule rather than restating it. Custom news categories rotate a
 * capped window through their sources and report the resulting coverage on the
 * panel badge (#5873), and both are wrong if they count feeds the fetch will
 * silently discard: `europe` declares 47 feeds but only 6 are fetchable for an
 * English user, so rotating over all 47 would spend roughly seven of every
 * eight twenty-minute cycles fetching nothing, and the badge would sit at
 * "6/47 sources" permanently — a fresh version of the same lie #5873 is about.
 *
 * The language is a parameter rather than read from i18n here so this stays a
 * pure, unit-testable rule; callers pass `getCurrentLanguage()`.
 */
export function isFeedInLanguage(feed: Feed, language: string): boolean {
  return !feed.lang || feed.lang === language;
}

/** The subset of `feeds` a fetch in `language` would actually attempt. */
export function filterFeedsByLanguage(feeds: readonly Feed[], language: string): Feed[] {
  return feeds.filter(feed => isFeedInLanguage(feed, language));
}
