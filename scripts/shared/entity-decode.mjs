// Single-pass HTML/XML entity decoder shared by the RSS/HTML seeders and the
// client-side news utilities.
//
// Why this exists (issue #5436): every hand-rolled decoder in the repo used a
// chain of sequential `.replace()` calls that decoded `&amp;` in the same pass
// as the other entities. That decodes two levels in one pass — `&amp;lt;`
// becomes `&` and the next replace then turns the resulting `&lt;` into `<`, so
// escaped-once text like `&amp;lt;script&amp;gt;` surfaced as live `<script>`.
// A single-pass alternation decodes exactly one level for every input, and the
// numeric decoder is range-guarded so a malformed `&#999999999;` yields '' via
// a caught RangeError source instead of throwing.
//
// Each call site keeps its own behaviour by passing its own config, so this is
// a pure de-duplication of the decode *mechanism* with no change to any
// seeder's output.

// Decode a numeric character reference, guarding the RangeError that
// String.fromCodePoint throws for values outside the Unicode range or for
// non-integers (e.g. from an overflowing `&#999999999;`).
export function decodeNumericReference(codePoint) {
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : '';
}

function escapeForRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Compiled-regex cache. Call sites pass a fresh config object literal per call
// (hundreds of times per seeder run), so memoise on a stable string derived
// from the parts that shape the pattern rather than on object identity.
const _regexCache = new Map();

function compiledRegExp(names, caseInsensitive, unknownToSpace) {
  const key = `${caseInsensitive ? 'i' : '-'}${unknownToSpace ? 'u' : '-'}|${names.join(',')}`;
  let re = _regexCache.get(key);
  if (!re) {
    // Named capture groups keep the replace callback position-independent
    // regardless of which alternatives are present.
    const parts = [];
    if (names.length > 0) parts.push(`(?<name>${names.join('|')})`);
    parts.push('#[xX](?<hex>[0-9a-fA-F]+)', '#(?<dec>\\d+)');
    if (unknownToSpace) parts.push('(?<unknown>[a-zA-Z][a-zA-Z0-9]*)');
    re = new RegExp(`&(?:${parts.join('|')});`, caseInsensitive ? 'gi' : 'g');
    _regexCache.set(key, re);
  }
  return re;
}

/**
 * Decode HTML/XML entities in a single left-to-right pass.
 *
 * @param {string} text
 * @param {object} [config]
 * @param {Record<string,string>} [config.named]
 *   Named entity (without the leading `&` / trailing `;`) to its replacement,
 *   e.g. `{ amp: '&', lt: '<', ldquo: '“' }`.
 * @param {Record<number,string>} [config.numericOverrides]
 *   Fixed replacements for specific numeric code points (decimal and hex refs
 *   are both normalised to a number key), e.g. `{ 8217: "'" }`.
 * @param {'decode'|'literal'|'space'} [config.numericDefault='decode']
 *   What to do with numeric refs not covered by `numericOverrides`: guarded
 *   `decode`, leave the ref `literal`, or replace with a single `space`.
 * @param {boolean} [config.caseInsensitive=false] Match entity names case-insensitively.
 * @param {boolean} [config.unknownToSpace=false]
 *   Replace any remaining `&…;` that matched no named entity with a single
 *   space (mirrors the catch-all a couple of seeders relied on).
 * @returns {string}
 */
export function decodeHtmlEntities(text, config = {}) {
  const {
    named = {},
    numericOverrides = {},
    numericDefault = 'decode',
    caseInsensitive = false,
    unknownToSpace = false,
  } = config;

  const lookup = caseInsensitive
    ? Object.fromEntries(Object.entries(named).map(([k, v]) => [k.toLowerCase(), v]))
    : named;

  const names = Object.keys(named).map(escapeForRegExp);
  const re = compiledRegExp(names, caseInsensitive, unknownToSpace);

  return text.replace(re, (...args) => {
    const match = args[0];
    const { name, hex, dec, unknown } = args[args.length - 1];
    if (name !== undefined) {
      const key = caseInsensitive ? name.toLowerCase() : name;
      return Object.prototype.hasOwnProperty.call(lookup, key) ? lookup[key] : match;
    }
    if (hex !== undefined || dec !== undefined) {
      const codePoint = hex !== undefined ? parseInt(hex, 16) : Number(dec);
      if (Object.prototype.hasOwnProperty.call(numericOverrides, codePoint)) {
        return numericOverrides[codePoint];
      }
      if (numericDefault === 'literal') return match;
      if (numericDefault === 'space') return ' ';
      return decodeNumericReference(codePoint);
    }
    // Reached only when unknownToSpace added the bare-name catch-all.
    if (unknown !== undefined) return ' ';
    return match;
  });
}
