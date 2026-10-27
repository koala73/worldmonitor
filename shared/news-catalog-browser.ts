// The browser's slice of the news catalog. shared/news-catalog.ts projects the
// full catalog into this shape and scripts/generate-browser-news-catalog.mjs
// writes it to src/config/news-catalog.browser.generated.ts, so the browser
// bundle carries only what the browser serves: no server-only fields, notes or
// server placements. Feeds are pre-grouped in browser order so the bundle
// carries no placement data. This module must not import the full catalog.

export type CatalogUrl = string | Record<string, string>;

export interface BrowserCatalogFeed {
  name: string;
  url: CatalogUrl;
  type?: string;
  lang?: string;
  strategicDefault?: boolean;
}

export interface BrowserCatalog {
  version: 3;
  /** edition → category → feeds, in browser order. Excludes intel. */
  editions: Record<string, Record<string, BrowserCatalogFeed[]>>;
  intel: BrowserCatalogFeed[];
  /** edition → categories its server digest builds (the catalog's server layout). */
  digestLayout: Record<string, string[]>;
}

/** Placement edition for intel sources; it has one category, `intel`. */
export const INTEL_EDITION = 'intel';

/** Browser view of one edition: category → feeds, in browser order. */
export function browserCategoryFeeds(catalog: BrowserCatalog, edition: string): Record<string, BrowserCatalogFeed[]> {
  const categories = catalog.editions[edition];
  if (!categories) throw new Error(`news catalog: no browser layout for edition "${edition}"`);
  return categories;
}

export function browserIntelSources(catalog: BrowserCatalog): BrowserCatalogFeed[] {
  return catalog.intel;
}

/**
 * Editions whose digest carries `category`, in layout order. A panel the user
 * added from another edition reads these digests instead of fetching feeds.
 */
export function digestEditionsForCategory(catalog: BrowserCatalog, category: string): string[] {
  return Object.entries(catalog.digestLayout)
    .filter(([, categories]) => categories.includes(category))
    .map(([edition]) => edition);
}
