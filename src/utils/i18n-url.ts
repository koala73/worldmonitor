// Pure, zero-import URL helpers for language detection. Kept out of i18n.ts so
// they can be unit-tested under `tsx --test` without pulling in i18next, the
// `import.meta.glob` locale map, or `import.meta.env` (see
// tests/format-price-nullsafe.test.mts for why the barrel can't be imported).

/**
 * Reads the `lang` query param from a URL string (e.g. `/dashboard?lang=fa`).
 * Returns `undefined` for an absent/empty param or an unparseable URL, so
 * i18next detection falls through to the next detector.
 */
export function readQueryLanguage(href: string): string | undefined {
  try {
    return new URL(href).searchParams.get('lang') || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns `href` with any `lang` query param removed (all other params and the
 * hash preserved). Used before an explicit-choice reload so a stale `?lang=`
 * doesn't re-win over the language the user just saved via Settings. Returns the
 * input unchanged when there is no `lang` param or the URL can't be parsed.
 */
export function stripQueryLanguage(href: string): string {
  try {
    const url = new URL(href);
    if (!url.searchParams.has('lang')) return href;
    url.searchParams.delete('lang');
    return url.toString();
  } catch {
    return href;
  }
}
