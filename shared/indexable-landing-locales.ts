/**
 * Indexable welcome-landing locales.
 *
 * Application localization (`?lang=`) is not an indexable document. These rows
 * are the crawlable, prerendered homepages that may appear in hreflang,
 * canonical, and sitemap output. One table drives prerender, sitemap
 * xhtml:link alternates, slash redirects, and 404 passthrough prefixes.
 *
 * x-default always points at the English root. Portuguese stays `/pt/` (the
 * app locale id) with hreflang `pt-BR`. Indonesian is omitted: there is no
 * `id.json` dictionary.
 */

export const INDEXABLE_LANDING_ORIGIN = 'https://www.worldmonitor.app' as const;

export interface IndexableLandingLocale {
  readonly id: string;
  readonly pathSegment: string;
  readonly canonicalPath: string;
  readonly canonicalUrl: string;
  readonly hreflang: string;
  readonly htmlLang: string;
  readonly ogLocale: string;
  readonly dir: 'ltr' | 'rtl';
  readonly isDefault: boolean;
}

export interface LandingAlternate {
  readonly hreflang: string;
  readonly href: string;
}

function landing(row: Omit<IndexableLandingLocale, 'canonicalUrl'>): IndexableLandingLocale {
  return Object.freeze({
    ...row,
    canonicalUrl: `${INDEXABLE_LANDING_ORIGIN}${row.canonicalPath}`,
  });
}

function assertLandingTable(rows: readonly IndexableLandingLocale[]): void {
  const ids = new Set<string>();
  const hreflangs = new Set<string>();
  let defaults = 0;
  for (const row of rows) {
    const expectedPath = row.isDefault ? '/' : `/${row.id}/`;
    if (row.canonicalPath !== expectedPath) {
      throw new Error(`landing locale ${row.id} must live at ${expectedPath}, not ${row.canonicalPath}`);
    }
    if (row.pathSegment !== (row.isDefault ? '' : row.id)) {
      throw new Error(`landing locale ${row.id} pathSegment must match the app locale id`);
    }
    if (ids.has(row.id)) throw new Error(`duplicate landing locale id ${row.id}`);
    if (hreflangs.has(row.hreflang) || row.hreflang === 'x-default') {
      throw new Error(`landing locale ${row.id} reuses hreflang ${row.hreflang}`);
    }
    const base = row.id.toLowerCase();
    if (
      row.hreflang.split('-')[0]?.toLowerCase() !== base
      || row.htmlLang.split('-')[0]?.toLowerCase() !== base
    ) {
      throw new Error(`landing locale ${row.id} declares a different language in hreflang or html lang`);
    }
    ids.add(row.id);
    hreflangs.add(row.hreflang);
    if (row.isDefault) defaults += 1;
  }
  if (defaults !== 1) throw new Error('exactly one landing locale must be the default');
}

export const INDEXABLE_LANDING_LOCALES: readonly IndexableLandingLocale[] = Object.freeze([
  landing({
    id: 'en',
    pathSegment: '',
    canonicalPath: '/',
    hreflang: 'en',
    htmlLang: 'en',
    ogLocale: 'en_US',
    dir: 'ltr',
    isDefault: true,
  }),
  landing({
    id: 'es',
    pathSegment: 'es',
    canonicalPath: '/es/',
    hreflang: 'es',
    htmlLang: 'es',
    ogLocale: 'es_ES',
    dir: 'ltr',
    isDefault: false,
  }),
  landing({
    id: 'pt',
    pathSegment: 'pt',
    canonicalPath: '/pt/',
    hreflang: 'pt-BR',
    htmlLang: 'pt',
    ogLocale: 'pt_BR',
    dir: 'ltr',
    isDefault: false,
  }),
  landing({
    id: 'ru',
    pathSegment: 'ru',
    canonicalPath: '/ru/',
    hreflang: 'ru',
    htmlLang: 'ru',
    ogLocale: 'ru_RU',
    dir: 'ltr',
    isDefault: false,
  }),
  landing({
    id: 'fr',
    pathSegment: 'fr',
    canonicalPath: '/fr/',
    hreflang: 'fr',
    htmlLang: 'fr',
    ogLocale: 'fr_FR',
    dir: 'ltr',
    isDefault: false,
  }),
  landing({
    id: 'de',
    pathSegment: 'de',
    canonicalPath: '/de/',
    hreflang: 'de',
    htmlLang: 'de',
    ogLocale: 'de_DE',
    dir: 'ltr',
    isDefault: false,
  }),
  landing({
    id: 'ar',
    pathSegment: 'ar',
    canonicalPath: '/ar/',
    hreflang: 'ar',
    htmlLang: 'ar',
    ogLocale: 'ar_SA',
    dir: 'rtl',
    isDefault: false,
  }),
]);

assertLandingTable(INDEXABLE_LANDING_LOCALES);

const BY_ID = new Map(INDEXABLE_LANDING_LOCALES.map((locale) => [locale.id, locale]));

export function defaultLandingLocale(): IndexableLandingLocale {
  const locale = INDEXABLE_LANDING_LOCALES.find((row) => row.isDefault);
  if (!locale) throw new Error('indexable landing locales must include a default English row');
  return locale;
}

export function nonDefaultLandingLocales(): readonly IndexableLandingLocale[] {
  return INDEXABLE_LANDING_LOCALES.filter((row) => !row.isDefault);
}

/**
 * Reciprocal cluster: x-default (English root) first, then every locale in
 * table order. Every landing HTML document and every landing sitemap URL
 * publishes this same list.
 */
export function landingHreflangCluster(): readonly LandingAlternate[] {
  const english = defaultLandingLocale();
  return Object.freeze([
    { hreflang: 'x-default', href: english.canonicalUrl },
    ...INDEXABLE_LANDING_LOCALES.map((locale) => ({
      hreflang: locale.hreflang,
      href: locale.canonicalUrl,
    })),
  ]);
}

export function landingById(id: string): IndexableLandingLocale | undefined {
  return BY_ID.get(id);
}

/** Exact landing paths only (`/`, `/es`, `/es/`). Nested paths do not match. */
export function landingByPath(pathname: string): IndexableLandingLocale | undefined {
  const raw = typeof pathname === 'string' ? pathname : '';
  if (raw === '' || raw === '/') return defaultLandingLocale();
  const stripped = raw.replace(/\/+$/, '') || '/';
  if (stripped === '/') return defaultLandingLocale();
  if (stripped.includes('/', 1)) return undefined;
  const segment = stripped.slice(1);
  return INDEXABLE_LANDING_LOCALES.find((locale) => locale.pathSegment === segment);
}

export function indexableLandingPassthroughPrefixes(): readonly string[] {
  return nonDefaultLandingLocales().map((locale) => `/${locale.pathSegment}`);
}
