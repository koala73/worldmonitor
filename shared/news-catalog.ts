// The news catalog: every RSS feed and intel source WorldMonitor lists is
// declared once in news-catalog.json. The browser catalog (src/config/feeds.ts)
// and the server catalog (server/worldmonitor/news/v1/_feeds.ts) are views
// built here, so a feed cannot exist for one surface without the other
// knowing. Scripts that must not execute app code read the JSON directly.
//
// Base fields are what the server fetches. `browser` overrides fields the
// browser view serves differently (null removes the field). Each placement
// carries its order per view, which drives fetch scheduling and panel order.

import catalogJson from './news-catalog.json';
import {
  INTEL_EDITION,
  browserCategoryFeeds,
  browserIntelSources,
  type BrowserCatalog,
  type BrowserCatalogFeed,
  type CatalogUrl,
} from './news-catalog-browser';

export { INTEL_EDITION };
export type { BrowserCatalog, BrowserCatalogFeed, CatalogUrl };

export interface CatalogPlacement {
  edition: string;
  category: string;
  serverOrder?: number;
  browserOrder?: number;
  /** Browser source type for this placement only (overrides the feed's). */
  type?: string;
}

export interface CatalogFeed {
  name: string;
  url: CatalogUrl;
  lang?: string;
  strategicDefault?: boolean;
  type?: string;
  deadlinePriority?: number;
  depthUrl?: string;
  browser?: {
    url?: CatalogUrl;
    lang?: string | null;
    strategicDefault?: boolean | null;
  };
  notes?: string[];
  placements: CatalogPlacement[];
}

export interface CatalogCategoryNote {
  side: 'browser' | 'server';
  edition: string;
  category: string;
  note: string;
}

export interface NewsCatalog {
  version: 1;
  layout: {
    browser: Record<string, string[]>;
    server: Record<string, string[]>;
  };
  /**
   * Server categories the digest last-good gate leaves out of its category
   * count, per edition: small categories added after the gate's baseline, whose
   * every feed can fail at once without that meaning the edition regressed.
   */
  gateExempt: Record<string, string[]>;
  categoryNotes: CatalogCategoryNote[];
  feeds: CatalogFeed[];
}

export const NEWS_CATALOG = catalogJson as NewsCatalog;

export interface ServerCatalogFeed {
  name: string;
  url: string;
  lang?: string;
  strategicDefault?: boolean;
  deadlinePriority?: number;
  depthUrl?: string;
}

function indexServerPlacements(catalog: NewsCatalog): Map<string, CatalogFeed[]> {
  const buckets = new Map<string, Array<{ order: number; feed: CatalogFeed }>>();
  for (const feed of catalog.feeds) {
    for (const placement of feed.placements) {
      const order = placement.serverOrder;
      if (order === undefined) continue;
      const key = `${placement.edition}|${placement.category}`;
      let bucket = buckets.get(key);
      if (!bucket) buckets.set(key, (bucket = []));
      bucket.push({ order, feed });
    }
  }
  const index = new Map<string, CatalogFeed[]>();
  for (const [key, bucket] of buckets) {
    index.set(key, bucket.sort((a, b) => a.order - b.order).map((entry) => entry.feed));
  }
  return index;
}

let placementIndex: Map<string, CatalogFeed[]> | null = null;

function serverPlacedFeeds(edition: string, category: string): CatalogFeed[] {
  placementIndex ??= indexServerPlacements(NEWS_CATALOG);
  return placementIndex.get(`${edition}|${category}`) ?? [];
}

function toServerFeed(feed: CatalogFeed): ServerCatalogFeed {
  if (typeof feed.url !== 'string') {
    throw new Error(`news catalog: server-placed feed "${feed.name}" needs a single URL`);
  }
  const entry: ServerCatalogFeed = { name: feed.name, url: feed.url };
  if (feed.lang !== undefined) entry.lang = feed.lang;
  if (feed.strategicDefault !== undefined) entry.strategicDefault = feed.strategicDefault;
  if (feed.deadlinePriority !== undefined) entry.deadlinePriority = feed.deadlinePriority;
  if (feed.depthUrl !== undefined) entry.depthUrl = feed.depthUrl;
  return entry;
}

function browserField<K extends 'lang' | 'strategicDefault'>(feed: CatalogFeed, key: K): CatalogFeed[K] | undefined {
  const override = feed.browser?.[key];
  if (override === null) return undefined;
  return (override ?? feed[key]) as CatalogFeed[K] | undefined;
}

/**
 * The browser's slice: browser overrides resolved, browser placements only,
 * grouped edition → category in browser order. The browser bundle imports the
 * generated copy of this, not the full catalog.
 */
export function projectBrowserCatalog(catalog: NewsCatalog = NEWS_CATALOG): BrowserCatalog {
  const buckets = new Map<string, Array<{ order: number; feed: BrowserCatalogFeed }>>();
  for (const feed of catalog.feeds) {
    let browserFeed: BrowserCatalogFeed | null = null;
    for (const placement of feed.placements) {
      if (placement.browserOrder === undefined) continue;
      if (!browserFeed) {
        browserFeed = { name: feed.name, url: feed.browser?.url ?? feed.url };
        if (feed.type !== undefined) browserFeed.type = feed.type;
        const lang = browserField(feed, 'lang');
        if (lang !== undefined) browserFeed.lang = lang;
        const strategicDefault = browserField(feed, 'strategicDefault');
        if (strategicDefault !== undefined) browserFeed.strategicDefault = strategicDefault;
        if (feed.lang !== undefined && !feed.strategicDefault && feed.lang !== lang) browserFeed.digestLang = feed.lang;
      }
      let placedFeed = placement.type === undefined ? browserFeed : { ...browserFeed, type: placement.type };
      const digestServed = feed.placements.some((p) =>
        p.serverOrder !== undefined
        && p.category === placement.category
        && (p.edition === INTEL_EDITION || catalog.layout.server[p.edition]?.includes(p.category)));
      if (!digestServed) placedFeed = { ...placedFeed, browserOnly: true };
      const key = `${placement.edition}|${placement.category}`;
      let bucket = buckets.get(key);
      if (!bucket) buckets.set(key, (bucket = []));
      bucket.push({ order: placement.browserOrder, feed: placedFeed });
    }
  }
  const placed = (edition: string, category: string): BrowserCatalogFeed[] =>
    (buckets.get(`${edition}|${category}`) ?? []).sort((a, b) => a.order - b.order).map(({ feed }) => feed);
  const editions: BrowserCatalog['editions'] = {};
  for (const [edition, categories] of Object.entries(catalog.layout.browser)) {
    editions[edition] = Object.fromEntries(categories.map((category) => [category, placed(edition, category)]));
  }
  const digestLayout = Object.fromEntries(
    Object.entries(catalog.layout.server).map(([edition, categories]) => [edition, [...categories]]),
  );
  return { version: 3, editions, intel: placed(INTEL_EDITION, INTEL_EDITION), digestLayout };
}

let browserSlice: BrowserCatalog | null = null;

/** Server view: edition → category → feeds, in server order. Excludes intel. */
export function buildServerVariantFeeds(): Record<string, Record<string, ServerCatalogFeed[]>> {
  const out: Record<string, Record<string, ServerCatalogFeed[]>> = {};
  for (const [edition, categories] of Object.entries(NEWS_CATALOG.layout.server)) {
    const byCategory: Record<string, ServerCatalogFeed[]> = {};
    for (const category of categories) {
      byCategory[category] = serverPlacedFeeds(edition, category).map(toServerFeed);
    }
    out[edition] = byCategory;
  }
  return out;
}

export function buildServerIntelSources(): ServerCatalogFeed[] {
  return serverPlacedFeeds(INTEL_EDITION, INTEL_EDITION).map(toServerFeed);
}

/** Browser view of one edition: category → feeds, in browser order. */
export function buildBrowserCategoryFeeds(edition: string): Record<string, BrowserCatalogFeed[]> {
  return browserCategoryFeeds((browserSlice ??= projectBrowserCatalog()), edition);
}

export function buildBrowserIntelSources(): BrowserCatalogFeed[] {
  return browserIntelSources((browserSlice ??= projectBrowserCatalog()));
}
