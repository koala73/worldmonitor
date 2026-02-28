export interface TokenizedTitle {
  words: Set<string>;
  ordered: string[];
}

const INFLECTION_SUFFIXES = ['s', 'es', 'ian', 'ians', 'ean', 'eans', 'an', 'ans', 'n', 'ns', 'i', 'is', 'ish', 'ese'];
const MIN_SUFFIX_KEYWORD_LEN = 4;

export function tokenizeForMatch(title: string): TokenizedTitle {
  const lower = title.toLowerCase();
  const words = new Set<string>();
  const ordered: string[] = [];
  for (const raw of lower.split(/\s+/)) {
    const cleaned = raw.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    if (!cleaned) continue;
    words.add(cleaned);
    ordered.push(cleaned);
    for (const part of cleaned.split(/[^a-z0-9]+/)) {
      if (part) words.add(part);
    }
  }
  return { words, ordered };
}

function hasSuffix(word: string, keyword: string): boolean {
  if (word.length <= keyword.length) return false;
  if (word.startsWith(keyword)) {
    const suffix = word.slice(keyword.length);
    if (INFLECTION_SUFFIXES.includes(suffix)) return true;
  }
  if (keyword.endsWith('e')) {
    const stem = keyword.slice(0, -1);
    if (word.length > stem.length && word.startsWith(stem)) {
      const suffix = word.slice(stem.length);
      if (INFLECTION_SUFFIXES.includes(suffix)) return true;
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
  const parts = keyword.toLowerCase().split(/\s+/).filter((w): w is string => w.length > 0);
  if (parts.length === 0) return false;
  if (parts.length === 1) return matchSingleWord(tokens.words, parts[0]!);
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
