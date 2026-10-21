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
 * Regions whose Chinese is written in Traditional script.
 *
 * Only consulted when the tag carries no script subtag: an explicit `Hans`
 * outranks the region, so `zh-Hans-TW` stays Simplified.
 */
const TRADITIONAL_CHINESE_REGIONS: ReadonlySet<string> = new Set(['tw', 'hk', 'mo']);

/**
 * Split a tag into the two subtags that decide Chinese script, stopping at the
 * first singleton.
 *
 * A singleton (`-u-`, `-x-`) opens an extension, and what follows it is not
 * language data: `zh-TW-u-ca-chinese` carries a two-letter `ca` that reads as a
 * region if the walk does not stop. Length is what separates the fields — four
 * letters is a script, two letters or three digits is a region — so the walk
 * does not depend on position, and `zh-Hant-TW` and `zh-TW` both parse.
 */
function parseSubtags(subtags: readonly string[]): { script: string; region: string } {
  let script = '';
  let region = '';

  for (const subtag of subtags) {
    if (subtag.length === 1) break;
    if (!script && subtag.length === 4) script = subtag;
    else if (!region && (subtag.length === 2 || subtag.length === 3)) region = subtag;
  }

  return { script, region };
}

/**
 * Resolve a browser/user language tag to a catalogue code.
 *
 * Returns `zh-TW` for Traditional tags, the base subtag for anything else the
 * catalogue supports, and `en` otherwise. The Traditional match must stay
 * narrow: `zh-SG` and `zh-Hans-*` are Simplified and have to keep resolving to
 * `zh`, which is why this reads the script and region subtags rather than
 * treating every regioned `zh` as Traditional.
 *
 * `_` is folded to `-` first. `zh_TW` is not valid BCP-47 and no browser emits
 * it, but it is the POSIX locale spelling, so it arrives from stored
 * preferences and hand-written config rather than from `navigator.language`.
 */
export function resolveLanguageTag(lng: string, supported: ReadonlySet<string>): string {
  const tag = (lng || 'en').toLowerCase().replace(/_/g, '-');
  const subtags = tag.split('-');
  const base = subtags[0] || 'en';

  if (base === 'zh') {
    const { script, region } = parseSubtags(subtags.slice(1));
    if (script === 'hant') return 'zh-TW';
    if (!script && TRADITIONAL_CHINESE_REGIONS.has(region)) return 'zh-TW';
  }

  return supported.has(base) ? base : 'en';
}
