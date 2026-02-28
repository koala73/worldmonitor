export interface TokenizedTitle {
  words: Set<string>;
  ordered: string[];
}

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

export function matchKeyword(tokens: TokenizedTitle, keyword: string): boolean {
  const parts = keyword.toLowerCase().split(/\s+/).filter((w): w is string => w.length > 0);
  if (parts.length === 0) return false;
  if (parts.length === 1) return tokens.words.has(parts[0]!);
  const { ordered } = tokens;
  for (let i = 0; i <= ordered.length - parts.length; i++) {
    let match = true;
    for (let j = 0; j < parts.length; j++) {
      if (ordered[i + j] !== parts[j]) { match = false; break; }
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
