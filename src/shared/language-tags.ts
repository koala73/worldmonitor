/**
 * BCP-47 tag resolution for the i18next catalogue lookup.
 *
 * Split out of `src/services/i18n.ts` so it can be table-tested: that module
 * reaches for `import.meta.glob` at load time, which only exists under Vite, so
 * a `node --test` import of it fails before any assertion runs.
 *
 * `SUPPORTED_LANGUAGES` deliberately stays in `src/services/i18n.ts` — the
 * locale-registry gate in `scripts/docs-stats.mjs` finds it there by regex and
 * fails closed if it moves.
 */

/**
 * Traditional-Chinese tags, matched before the region suffix is stripped.
 *
 * `zh-TW`/`zh-HK`/`zh-Hant` would otherwise collapse to `zh` and serve the
 * Simplified dictionary to readers who asked for Traditional (#6546).
 */
export const TRADITIONAL_CHINESE_TAGS: ReadonlySet<string> = new Set([
  'zh-tw',
  'zh-hk',
  'zh-mo',
  'zh-hant',
]);

/**
 * Resolve a browser/user language tag to a catalogue code.
 *
 * Returns `zh-TW` for Traditional tags, the base subtag for anything else the
 * catalogue supports, and `en` otherwise. The match must stay narrow: `zh-SG`
 * and `zh-Hans-*` are Simplified and have to keep resolving to `zh`, which is
 * why this tests explicit tags plus the `zh-hant` prefix rather than treating
 * every regioned `zh` as Traditional.
 */
export function resolveLanguageTag(lng: string, supported: ReadonlySet<string>): string {
  const tag = (lng || 'en').toLowerCase();
  if (TRADITIONAL_CHINESE_TAGS.has(tag) || tag.startsWith('zh-hant')) {
    return 'zh-TW';
  }
  const base = tag.split('-')[0] || 'en';
  return supported.has(base) ? base : 'en';
}
