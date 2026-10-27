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
  version: 2;
  /** edition → category → feeds, in browser order. Excludes intel. */
  editions: Record<string, Record<string, BrowserCatalogFeed[]>>;
  intel: BrowserCatalogFeed[];
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
