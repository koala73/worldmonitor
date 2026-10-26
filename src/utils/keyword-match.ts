export interface TokenizedTitle {
  words: Set<string>;
  ordered: string[];
}

const INFLECTION_SUFFIXES = new Set(['s', 'es', 'ian', 'ians', 'ean', 'eans', 'an', 'ans', 'n', 'ns', 'i', 'is', 'ish', 'ese']);
const MIN_SUFFIX_KEYWORD_LEN = 4;

const LATIN_COMBINING_MARKS = /(\p{Script=Latin})\p{M}+/gu;
const APOSTROPHES = /[\u2018\u2019\u02BC\u0060\u00B4]/g;
const EDGE_NON_WORD = /^[^\p{L}\p{N}\p{M}]+|[^\p{L}\p{N}\p{M}]+$/gu;
const NON_WORD = /[^\p{L}\p{N}\p{M}]+/u;
const POSSESSIVE = /'s$/;

/**
 * Normalize headlines and keywords with NFKD, fold Latin accents and curly
 * apostrophes, and lowercase. Preserve meaningful marks in non-Latin scripts.
 */
export function normalizeForMatch(text: string): string {
  return text.normalize('NFKD').replace(LATIN_COMBINING_MARKS, '$1').toLowerCase().replace(APOSTROPHES, "'");
}

export function tokenizeForMatch(title: string): TokenizedTitle {
  const norm = normalizeForMatch(title);
  const words = new Set<string>();
  const ordered: string[] = [];
  for (const raw of norm.split(/\s+/)) {
    const cleaned = raw.replace(EDGE_NON_WORD, '');
    if (!cleaned) continue;
    words.add(cleaned);
    const parts = cleaned.split(NON_WORD).filter(Boolean);
    for (const part of parts) words.add(part);
    if (parts.length <= 1) {
      ordered.push(cleaned);
    } else {
      // Compound tokens ("north-korea", "assad's") contribute their pieces to
      // the ordered list so phrase keywords match; a trailing possessive 's is
      // dropped from the ordered list only.
      const ord = POSSESSIVE.test(cleaned) ? cleaned.replace(POSSESSIVE, '').split(NON_WORD).filter(Boolean) : parts;
      ordered.push(...ord);
    }
  }
  return { words, ordered };
}

function hasSuffix(word: string, keyword: string): boolean {
  if (word.length <= keyword.length) return false;
  if (word.startsWith(keyword)) {
    const suffix = word.slice(keyword.length);
    if (INFLECTION_SUFFIXES.has(suffix)) return true;
  }
  if (keyword.endsWith('e')) {
    const stem = keyword.slice(0, -1);
    if (word.length > stem.length && word.startsWith(stem)) {
      const suffix = word.slice(stem.length);
      if (INFLECTION_SUFFIXES.has(suffix)) return true;
    }
  }
  return false;
}

function wordMatches(token: string, kwPart: string): boolean {
  if (token === kwPart) return true;
  if (kwPart.length >= MIN_SUFFIX_KEYWORD_LEN) return hasSuffix(token, kwPart);
  return false;
}

function matchSingleWord(words: Set<string>, keyword: string): boolean {
  if (words.has(keyword)) return true;
  if (keyword.length < MIN_SUFFIX_KEYWORD_LEN) return false;
  for (const word of words) {
    if (hasSuffix(word, keyword)) return true;
  }
  return false;
}

export function matchKeyword(tokens: TokenizedTitle, keyword: string): boolean {
  const words = normalizeForMatch(keyword)
    .split(/[^\p{L}\p{N}\p{M}']+/u)
    .map(w => w.replace(/^'+|'+$/g, ''))
    .filter((w): w is string => w.length > 0);
  if (words.length === 0) return false;
  if (words.length === 1) return matchSingleWord(tokens.words, words[0]!);
  const { ordered: parts } = tokenizeForMatch(keyword);
  const { ordered } = tokens;
  for (let i = 0; i <= ordered.length - parts.length; i++) {
    let match = true;
    for (let j = 0; j < parts.length; j++) {
      if (!wordMatches(ordered[i + j]!, parts[j]!)) { match = false; break; }
    }
    if (match) return true;
  }
  return false;
}

export function matchesAnyKeyword(tokens: TokenizedTitle, keywords: string[]): boolean {
  for (const kw of keywords) {
    if (matchKeyword(tokens, kw)) return true;
  }
  return false;
}

export function findMatchingKeywords(tokens: TokenizedTitle, keywords: string[]): string[] {
  return keywords.filter(kw => matchKeyword(tokens, kw));
}
