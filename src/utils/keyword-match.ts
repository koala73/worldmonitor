/**
 * Tokenization-based keyword matching for geo-tagging.
 * Single source of truth — all geo/hotspot keyword matching imports from here.
 *
 * Uses Set-based lookups (O(1)) instead of regex to eliminate:
 *  - Substring false positives ("assad" inside "ambassador")
 *  - Per-keyword RegExp allocations in hot loops
 *
 * @see https://github.com/koala73/worldmonitor/issues/324
 */

export interface TokenizedTitle {
  /** Unique lowercase words for O(1) single-word lookups */
  words: Set<string>;
  /** Ordered lowercase words for contiguous phrase matching */
  ordered: string[];
}

/**
 * Tokenize a title into lowercase words.
 * Call once per title, reuse across all keyword checks.
 */
export function tokenizeForMatch(title: string): TokenizedTitle {
  const ordered = title.toLowerCase().split(/[^a-z0-9'-]+/).filter(w => w.length > 0);
  return { words: new Set(ordered), ordered };
}

/**
 * Check if a single keyword matches within a tokenized title.
 * - Single-word keywords: O(1) Set lookup
 * - Multi-word keywords (e.g. "white house"): contiguous phrase search
 */
export function matchKeyword(tokens: TokenizedTitle, keyword: string): boolean {
  const parts = keyword.toLowerCase().split(/\s+/).filter(w => w.length > 0);
  if (parts.length === 0) return false;

  if (parts.length === 1) {
    return tokens.words.has(parts[0]!);
  }

  // Multi-word: find contiguous phrase in ordered tokens
  const { ordered } = tokens;
  for (let i = 0; i <= ordered.length - parts.length; i++) {
    let match = true;
    for (let j = 0; j < parts.length; j++) {
      if (ordered[i + j] !== parts[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

/** Check if any keyword in the list matches the tokenized title. */
export function matchesAnyKeyword(tokens: TokenizedTitle, keywords: string[]): boolean {
  return keywords.some(kw => matchKeyword(tokens, kw));
}

/** Return all keywords that match the tokenized title. */
export function findMatchingKeywords(tokens: TokenizedTitle, keywords: string[]): string[] {
  return keywords.filter(kw => matchKeyword(tokens, kw));
}
