// Script-aware display truncation shared by the magazine pipeline, digest
// formatters and (PR 7) the edge carousel. No node: imports.

const ELLIPSIS = '…';
// Written without spaces between words; a stray space (a Latin brand name)
// must not send them down the space-separated path.
const UNSPACED_LANGS = new Set(['ja', 'zh', 'zh-TW', 'th']);

// Without Intl.Segmenter: a base character plus its combining marks, emoji
// modifiers, tag characters and ZWJ-joined followers, or a flag pair. Close
// to extended grapheme clusters for the text a brief carries.
const CLUSTER_RE = /\p{Regional_Indicator}{2}|[\s\S](?:[\p{M}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]|\u200D[\s\S]?)*/gu;

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
 * a combining sequence. Uses Intl.Segmenter; falls back to CLUSTER_RE when
 * Intl.Segmenter is unavailable.
 * @param {string} text
 * @param {number} max
 * @param {string} [lang]
 */
export function truncateForDisplay(text, max, lang = 'en') {
  const str = String(text ?? '');
  const graphemes = segmenter(lang, 'grapheme');
  if (!graphemes) {
    const clusters = str.match(CLUSTER_RE) ?? [];
    return clusters.length <= max ? str : `${clusters.slice(0, max).join('').trimEnd()}${ELLIPSIS}`;
  }
  const clusters = Array.from(graphemes.segment(str), (s) => s.segment);
  if (clusters.length <= max) return str;
  const head = clusters.slice(0, max).join('');
  // Space-separated text: drop the trailing partial word, as English always did.
  if (!UNSPACED_LANGS.has(lang) && /\S\s/u.test(head)) return `${head.replace(/\s+\S*$/u, '')}${ELLIPSIS}`;
  // Scripts without spaces (ja, zh, th): the last word boundary of the whole
  // text that fits the budget. Segmenting only the prefix would split a word
  // the cut itself truncated (ประเทศไ|ทย reads as ประ|เทศ|ไ). No whole word
  // fits: cut at the grapheme budget.
  let cut = 0;
  for (const { index, segment, isWordLike } of segmenter(lang, 'word').segment(str)) {
    const end = index + segment.length;
    if (end > head.length) break;
    if (isWordLike) cut = end;
  }
  return `${(cut > 0 ? head.slice(0, cut) : head).trimEnd()}${ELLIPSIS}`;
}
