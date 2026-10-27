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

export type CatalogUrl = string | Record<string, string>;

export interface CatalogPlacement {
  edition: string;
  category: string;
  serverOrder?: number;
  browserOrder?: number;
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
  categoryNotes: CatalogCategoryNote[];
  feeds: CatalogFeed[];
}

/** Placement edition for intel sources; it has one category, `intel`. */
export const INTEL_EDITION = 'intel';

export const NEWS_CATALOG = catalogJson as NewsCatalog;

export interface ServerCatalogFeed {
  name: string;
  url: string;
  lang?: string;
  strategicDefault?: boolean;
  deadlinePriority?: number;
  depthUrl?: string;
}

export interface BrowserCatalogFeed {
  name: string;
  url: CatalogUrl;
  type?: string;
  lang?: string;
  strategicDefault?: boolean;
}

type Side = 'server' | 'browser';

function indexPlacements(catalog: NewsCatalog): Map<string, CatalogFeed[]> {
  const buckets = new Map<string, Array<{ order: number; feed: CatalogFeed }>>();
  for (const feed of catalog.feeds) {
    for (const placement of feed.placements) {
      for (const side of ['server', 'browser'] as const) {
        const order = side === 'server' ? placement.serverOrder : placement.browserOrder;
        if (order === undefined) continue;
        const key = `${side}|${placement.edition}|${placement.category}`;
        let bucket = buckets.get(key);
        if (!bucket) buckets.set(key, (bucket = []));
        bucket.push({ order, feed });
      }
    }
  }
  const index = new Map<string, CatalogFeed[]>();
  for (const [key, bucket] of buckets) {
    index.set(key, bucket.sort((a, b) => a.order - b.order).map((entry) => entry.feed));
  }
  return index;
}

let placementIndex: Map<string, CatalogFeed[]> | null = null;

function placedFeeds(side: Side, edition: string, category: string): CatalogFeed[] {
  placementIndex ??= indexPlacements(NEWS_CATALOG);
  return placementIndex.get(`${side}|${edition}|${category}`) ?? [];
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

function toBrowserFeed(feed: CatalogFeed): BrowserCatalogFeed {
  const entry: BrowserCatalogFeed = { name: feed.name, url: feed.browser?.url ?? feed.url };
  if (feed.type !== undefined) entry.type = feed.type;
  const lang = browserField(feed, 'lang');
  if (lang !== undefined) entry.lang = lang;
  const strategicDefault = browserField(feed, 'strategicDefault');
  if (strategicDefault !== undefined) entry.strategicDefault = strategicDefault;
  return entry;
}

/** Server view: edition → category → feeds, in server order. Excludes intel. */
export function buildServerVariantFeeds(): Record<string, Record<string, ServerCatalogFeed[]>> {
  const out: Record<string, Record<string, ServerCatalogFeed[]>> = {};
  for (const [edition, categories] of Object.entries(NEWS_CATALOG.layout.server)) {
    const byCategory: Record<string, ServerCatalogFeed[]> = {};
    for (const category of categories) {
      byCategory[category] = placedFeeds('server', edition, category).map(toServerFeed);
    }
    out[edition] = byCategory;
  }
  return out;
}

export function buildServerIntelSources(): ServerCatalogFeed[] {
  return placedFeeds('server', INTEL_EDITION, INTEL_EDITION).map(toServerFeed);
}

/** Browser view of one edition: category → feeds, in browser order. */
export function buildBrowserCategoryFeeds(edition: string): Record<string, BrowserCatalogFeed[]> {
  const categories = NEWS_CATALOG.layout.browser[edition];
  if (!categories) throw new Error(`news catalog: no browser layout for edition "${edition}"`);
  const out: Record<string, BrowserCatalogFeed[]> = {};
  for (const category of categories) {
    out[category] = placedFeeds('browser', edition, category).map(toBrowserFeed);
  }
  return out;
}

export function buildBrowserIntelSources(): BrowserCatalogFeed[] {
  return placedFeeds('browser', INTEL_EDITION, INTEL_EDITION).map(toBrowserFeed);
}
