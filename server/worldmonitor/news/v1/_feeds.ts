import { buildServerIntelSources, buildServerVariantFeeds } from '../../../../shared/news-catalog';

export interface ServerFeed {
  name: string;
  url: string;
  lang?: string;
  strategicDefault?: boolean;
  /**
   * Positive values start earlier in a cold digest build. This is a fetch
   * scheduling hint only; it does not affect ranking, source tier, or UI
   * default selection.
   */
  deadlinePriority?: number;
  /**
   * A deeper feed for the same publisher, fetched with this one in the full
   * variant and cached under its own URL. Only claim search (/verify,
   * verify_claim) reads it; the digest and panels never see its items.
   */
  depthUrl?: string;
}

export function isServerFeedReachableForLanguage(
  feed: Pick<ServerFeed, 'lang' | 'strategicDefault'>,
  language: string,
): boolean {
  return !feed.lang || feed.lang === language || !!feed.strategicDefault;
}

export function orderServerFeedEntries<T extends {
  feed: Pick<ServerFeed, 'deadlinePriority'>;
}>(entries: readonly T[]): T[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const aPriority = Number.isFinite(a.entry.feed.deadlinePriority)
        ? a.entry.feed.deadlinePriority!
        : 0;
      const bPriority = Number.isFinite(b.entry.feed.deadlinePriority)
        ? b.entry.feed.deadlinePriority!
        : 0;
      return bPriority - aPriority || a.index - b.index;
    })
    .map(({ entry }) => entry);
}

// Feeds are declared once in shared/news-catalog.json; these are its server
// view, in server order.
export const VARIANT_FEEDS: Record<string, Record<string, ServerFeed[]>> = buildServerVariantFeeds();

export const INTEL_SOURCES: ServerFeed[] = buildServerIntelSources();
