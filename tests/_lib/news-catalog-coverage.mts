// Coverage rules for shared/news-catalog.json: every source the browser can
// show must be fetched by a digest the server builds, and every language the
// catalog uses must be a digest language. Pure functions so tests can feed
// fixtures as well as the real catalog.

export interface CoverageFeed {
  name: string;
  url: unknown;
  lang?: string;
  browser?: { url?: unknown; lang?: string | null } | null;
  placements: Array<{ edition: string; category: string; serverOrder?: number; browserOrder?: number }>;
}

/** Edition → categories a digest actually fetches. */
export type ServedLayout = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * What the server builds: `layout.server` categories for each digest variant,
 * plus the intel list the full digest also fetches.
 */
export function servedLayout(
  serverLayout: Record<string, string[]>,
  digestVariants: Iterable<string>,
  intelEdition: string,
): ServedLayout {
  const served = new Map<string, ReadonlySet<string>>();
  for (const variant of digestVariants) served.set(variant, new Set(serverLayout[variant] ?? []));
  served.set(intelEdition, new Set([intelEdition]));
  return served;
}

const isServed = (served: ServedLayout, edition: string, category: string) =>
  served.get(edition)?.has(category) ?? false;

/** Names placed in at least one edition/category a digest fetches. */
export function serverPlacedNames(feeds: CoverageFeed[], served: ServedLayout): Set<string> {
  const names = new Set<string>();
  for (const feed of feeds) {
    if (feed.placements.some((p) => p.serverOrder !== undefined && isServed(served, p.edition, p.category))) {
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
  served: ServedLayout,
  pending: ReadonlySet<string>,
): string[] {
  const covered = serverPlacedNames(feeds, served);
  return [...new Set(referenced)].filter((name) => !covered.has(name) && !pending.has(name)).sort();
}

/** Server placements in an edition/category no digest fetches. */
export function unservedServerPlacements(feeds: CoverageFeed[], served: ServedLayout): string[] {
  const out: string[] = [];
  for (const feed of feeds) {
    for (const p of feed.placements) {
      if (p.serverOrder !== undefined && !isServed(served, p.edition, p.category)) {
        out.push(`${feed.name} → ${p.edition}/${p.category}`);
      }
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
