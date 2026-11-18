/**
 * Cut `text` to at most `max` grapheme clusters, ending on a word boundary for
 * the given language, and append "…" when cut. Never splits a surrogate pair or
 * a combining sequence. Uses Intl.Segmenter; falls back to an approximate cluster cut
 * when Intl.Segmenter is unavailable.
 */
export function truncateForDisplay(text: string, max: number, lang?: string): string;
