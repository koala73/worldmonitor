/**
 * Shared single-pass HTML/XML entity decoder for the client SPA.
 *
 * Why single-pass: sequential `.replace(/&amp;/g, '&')` chains decode TWO
 * levels when `&amp;` runs before the other replaces — `&amp;lt;` becomes
 * `<` in one call, turning escaped text into live markup. One regex pass
 * over an alternation decodes exactly one level for every input.
 *
 * `String.fromCodePoint` throws `RangeError` on anything outside the Unicode
 * range, which would turn one malformed numeric reference (`&#999999999;`)
 * into a crashed render. Out-of-range references are preserved instead.
 * `fromCharCode` is not usable here: it truncates to 16 bits, so `&#128512;`
 * would decode to U+F600 (a private-use glyph) rather than 😀.
 *
 * Mirrors `scripts/_html-entities.mjs` (kept separate because seed scripts
 * cannot be imported from `src/`).
 */

/**
 * Returns null for anything that is not a Unicode scalar value: out-of-range
 * numbers throw RangeError in fromCodePoint, and surrogates (0xD800-0xDFFF)
 * would otherwise pass through as lone surrogates into published text.
 */
function decodeNumericReference(codePoint: number): string | null {
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
    ? String.fromCodePoint(codePoint)
    : null;
}

// Named entities the decoders historically handled. `nbsp` maps to a plain
// space (matching every prior decoder); curly quotes map to their correct
// Unicode code points.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

const ENTITY_RE = /&(?:#x([0-9a-f]+)|#(\d+)|([a-z][a-z0-9]*));/gi;

/**
 * Decode exactly one level of HTML/XML entities.
 *
 * `unknownEntity` controls unrecognized entities AND invalid numeric
 * references: `keep` (default) leaves unknown entities and invalid references
 * untouched; `blank` replaces both with a single space (a space keeps
 * adjacent digits from welding into one number, e.g. `100&#999999999;200`).
 */
export function decodeHtmlEntities(
  text: unknown,
  { unknownEntity = 'keep' }: { unknownEntity?: 'keep' | 'blank' } = {},
): string {
  return String(text ?? '').replace(ENTITY_RE, (match, hex, dec, name) => {
    if (hex !== undefined || dec !== undefined) {
      const decoded = decodeNumericReference(hex !== undefined ? parseInt(hex as string, 16) : Number(dec));
      // Preserve invalid references by default; 'blank' intentionally replaces
      // them with a separator so adjacent identifier segments cannot weld.
      return decoded ?? (unknownEntity === 'blank' ? ' ' : match);
    }
    const value = NAMED_ENTITIES[(name as string).toLowerCase()];
    if (value !== undefined) return value;
    return unknownEntity === 'blank' ? ' ' : match;
  });
}
