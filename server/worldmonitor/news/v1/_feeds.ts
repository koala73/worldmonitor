// Read the generated server slice, never shared/news-catalog: a value import
// from it bundles the whole catalog JSON into the digest and MCP functions.
import { SERVER_NEWS_CATALOG } from '../../../../shared/news-catalog.server.generated';
import { hashString } from '../../../_shared/hash';

export interface ServerFeed {
  name: string;
  url: string;
  lang?: string;
  fetchInAllLanguages?: boolean;
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
  /**
   * The feed republishes a dated snapshot: items carry no date of their own,
   * so an undated item takes the channel's date. Opt-in per feed, because a
   * static page that only dates its channel must still fail the date gate.
   */
  channelDated?: boolean;
  /**
   * Hosts this feed's items link to besides the feed host and its publisher
   * family's domains, for a feed that lists another site's pages (GitHub
   * Trending links to github.com). A host many owners share belongs here, on
   * the one feed, never in a publisher family.
   */
  linkHosts?: string[];
  /**
   * The feed lists items in editorial order, not by date. The parser ranks
   * them newest first before taking the digest's top items.
   */
  newestFirst?: boolean;
  /**
   * Link path segments that mark items outside this feed's scope (CNN's
   * site-wide news sitemap lists video clips and shopping pages). An item
   * whose link path has one of these segments is dropped before ranking.
   */
  excludePathSegments?: string[];
}

/** Match the digest language unless the catalog explicitly permits cross-language fetching. */
export function isServerFeedReachableForLanguage(
  feed: Pick<ServerFeed, 'lang' | 'strategicDefault' | 'fetchInAllLanguages'>,
  language: string,
): boolean {
  return !feed.lang || feed.lang === language || !!feed.strategicDefault || !!feed.fetchInAllLanguages;
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
export const VARIANT_FEEDS: Record<string, Record<string, ServerFeed[]>> = SERVER_NEWS_CATALOG.variantFeeds;

export const INTEL_SOURCES: ServerFeed[] = SERVER_NEWS_CATALOG.intelSources;

/** Every edition the digest builds. Derived from the catalog layout. */
export const SERVER_EDITIONS: readonly string[] = SERVER_NEWS_CATALOG.editions;

export interface DigestGateProfile {
  /** Categories the last-good gate leaves out of its category count. */
  exemptCategories: string[];
  /**
   * Fingerprint of the feeds this edition's digest fetches. When it differs
   * from the accepted snapshot's, the snapshot was built from a different
   * catalog, so it cannot veto a candidate and its item peak resets.
   */
  catalogFingerprint: string;
}

const gateProfiles = new Map<string, DigestGateProfile>();

export function digestGateProfile(variant: string): DigestGateProfile {
  const cached = gateProfiles.get(variant);
  if (cached) return cached;
  const categories = VARIANT_FEEDS[variant] ?? {};
  const shape = Object.entries(categories).map(([category, feeds]) => [category, feeds.map((f) => f.url)]);
  if (variant === 'full') shape.push(['intel', INTEL_SOURCES.map((f) => f.url)]);
  const profile: DigestGateProfile = {
    exemptCategories: [...(SERVER_NEWS_CATALOG.gateExempt[variant] ?? [])],
    catalogFingerprint: hashString(JSON.stringify(shape)),
  };
  gateProfiles.set(variant, profile);
  return profile;
}
