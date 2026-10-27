// Coverage rules for shared/news-catalog.json: every source the browser can
// show must be fetched by a digest the server builds, and every language the
// catalog uses must be a digest language. Pure functions so tests can feed
// fixtures as well as the real catalog.

export interface CoverageFeed {
  name: string;
  url: unknown;
  lang?: string;
  browser?: { url?: unknown; lang?: string | null } | null;
  placements: Array<{ edition: string; serverOrder?: number; browserOrder?: number }>;
}

/** Names placed in at least one edition the digest serves. */
export function serverPlacedNames(feeds: CoverageFeed[], servedEditions: ReadonlySet<string>): Set<string> {
  const names = new Set<string>();
  for (const feed of feeds) {
    if (feed.placements.some((p) => p.serverOrder !== undefined && servedEditions.has(p.edition))) {
      names.add(feed.name);
    }
  }
  return names;
}

/** Names the browser catalog places anywhere. */
export function browserPlacedNames(feeds: CoverageFeed[]): Set<string> {
  return new Set(feeds.filter((f) => f.placements.some((p) => p.browserOrder !== undefined)).map((f) => f.name));
}

/**
 * Referenced names that no served digest fetches and that are not pending
 * migration. Sorted, so a failure names every gap.
 */
export function uncoveredSources(
  referenced: Iterable<string>,
  feeds: CoverageFeed[],
  servedEditions: ReadonlySet<string>,
  pending: ReadonlySet<string>,
): string[] {
  const covered = serverPlacedNames(feeds, servedEditions);
  return [...new Set(referenced)].filter((name) => !covered.has(name) && !pending.has(name)).sort();
}

/** Server placements in editions no digest serves. */
export function unservedServerPlacements(feeds: CoverageFeed[], servedEditions: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const feed of feeds) {
    for (const p of feed.placements) {
      if (p.serverOrder !== undefined && !servedEditions.has(p.edition)) out.push(`${feed.name} → ${p.edition}`);
    }
  }
  return out.sort();
}

/** Every language a feed declares: `lang`, browser `lang`, and per-language URL keys. */
export function catalogLanguages(feeds: CoverageFeed[]): Map<string, string[]> {
  const byLang = new Map<string, string[]>();
  const add = (lang: string, name: string) => {
    const names = byLang.get(lang) ?? [];
    if (!names.includes(name)) names.push(name);
    byLang.set(lang, names);
  };
  for (const feed of feeds) {
    if (feed.lang) add(feed.lang, feed.name);
    if (feed.browser?.lang) add(feed.browser.lang, feed.name);
    for (const url of [feed.url, feed.browser?.url]) {
      if (url && typeof url === 'object') for (const lang of Object.keys(url)) add(lang, feed.name);
    }
  }
  return byLang;
}

export function unsupportedLanguages(feeds: CoverageFeed[], digestLanguages: ReadonlySet<string>): string[] {
  return [...catalogLanguages(feeds)]
    .filter(([lang]) => !digestLanguages.has(lang))
    .map(([lang, names]) => `${lang} (${names.join(', ')})`)
    .sort();
}
