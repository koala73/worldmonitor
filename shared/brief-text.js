// Script-aware display truncation shared by the magazine pipeline, digest
// formatters and (PR 7) the edge carousel. No node: imports.

const ELLIPSIS = '…';
// Written without spaces between words; a stray space (a Latin brand name)
// must not send them down the space-separated path.
const UNSPACED_LANGS = new Set(['ja', 'zh', 'zh-TW', 'th']);

function segmenter(lang, granularity) {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return null;
  try {
    return new Intl.Segmenter(lang || 'en', { granularity });
  } catch {
    return new Intl.Segmenter('en', { granularity });
  }
}

/**
 * Cut `text` to at most `max` grapheme clusters, ending on a word boundary for
 * the given language, and append "…" when cut. Never splits a surrogate pair or
 * a combining sequence. Uses Intl.Segmenter; falls back to a code-point slice
 * when Intl.Segmenter is unavailable.
 * @param {string} text
 * @param {number} max
 * @param {string} [lang]
 */
export function truncateForDisplay(text, max, lang = 'en') {
  const str = String(text ?? '');
  const graphemes = segmenter(lang, 'grapheme');
  if (!graphemes) {
    const cps = Array.from(str);
    return cps.length <= max ? str : `${cps.slice(0, max).join('').trimEnd()}${ELLIPSIS}`;
  }
  const clusters = Array.from(graphemes.segment(str), (s) => s.segment);
  if (clusters.length <= max) return str;
  const head = clusters.slice(0, max).join('');
  // Space-separated text: drop the trailing partial word, as English always did.
  if (!UNSPACED_LANGS.has(lang) && /\S\s/u.test(head)) return `${head.replace(/\s+\S*$/u, '')}${ELLIPSIS}`;
  // Scripts without spaces (ja, zh, th): last word boundary from the segmenter.
  let cut = 0;
  for (const { index, segment, isWordLike } of segmenter(lang, 'word').segment(head)) {
    if (isWordLike && index + segment.length < head.length) cut = index + segment.length;
  }
  return `${(cut > 0 ? head.slice(0, cut) : head).trimEnd()}${ELLIPSIS}`;
}
