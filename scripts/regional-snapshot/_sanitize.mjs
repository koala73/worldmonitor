// @ts-check
//
// Belt-and-suspenders sanitizer for strings sourced from third-party upstream
// feeds (cross-source signals, chokepoints, forecasts, CII scores, etc.) that
// are interpolated into snapshot evidence/driver description and summary
// fields and persisted to Redis.
//
// The render layer (`src/components/regional-intelligence-board-utils.ts`)
// already wraps EVERY snapshot string interpolation in `escapeHtml`, so this
// writer-side strip is defense-in-depth, not the primary control. It exists
// to:
//
//   1. Strip structural HTML markers (`<`, `>`) so a hostile upstream payload
//      cannot bloat the persisted Redis blob with markup that any future
//      consumer might forget to escape.
//   2. Remove NUL and zero-width characters that confuse downstream parsers
//      and length checks.
//   3. Collapse whitespace runs (including `\n` / `\t`) into single spaces so
//      a multi-megabyte newline-padded payload cannot blow up the snapshot.
//   4. Cap length to a reasonable bound so a single upstream record cannot
//      dominate the snapshot size.
//
// Tracked by todos/177 (closed by PR for issue #3730).

const DEFAULT_MAX_LEN = 500;

// Matches NUL plus the common zero-width characters:
//   U+0000 NUL
//   U+200B ZWSP (zero-width space)
//   U+200C ZWNJ (zero-width non-joiner)
//   U+200D ZWJ  (zero-width joiner)
//   U+2060 WJ   (word joiner)
//   U+FEFF BOM  (byte-order mark / zero-width no-break space)
//
// Written as an alternation of \u escapes (not a character class) for two
// reasons:
//   1. biome's lint/suspicious/noMisleadingCharacterClass rule flags ZWJ
//      inside a character class as a potential emoji-composition footgun.
//   2. scripts/check-unicode-safety.mjs forbids literal invisible code
//      points in source — \u escapes are the sanctioned form.
const STRIP_CHARS_RE = /\u0000|\u200B|\u200C|\u200D|\u2060|\uFEFF/g;
const ANGLE_BRACKETS_RE = /[<>]/g;
const WHITESPACE_RUN_RE = /\s+/g;

/**
 * Sanitize a string sourced from an untrusted upstream feed before it is
 * embedded in a snapshot description/summary field and persisted to Redis.
 *
 * Safe to call on any value: null/undefined return an empty string rather
 * than throwing.
 *
 * @param {unknown} value - The raw upstream value (string, number, null, etc).
 * @param {object} [opts]
 * @param {number} [opts.maxLen=500] - Maximum output length.
 * @returns {string} Sanitized string, never null/undefined.
 */
export function sanitizeEvidenceString(value, opts = {}) {
  if (value === null || value === undefined) return '';
  const maxLen = typeof opts.maxLen === 'number' && opts.maxLen > 0
    ? opts.maxLen
    : DEFAULT_MAX_LEN;

  let s = String(value);
  s = s.replace(STRIP_CHARS_RE, '');
  s = s.replace(ANGLE_BRACKETS_RE, '');
  s = s.replace(WHITESPACE_RUN_RE, ' ');
  s = s.trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}
