const PROMO_TOKENS = new Set([
  'fresh', 'save', 'sale', 'deal', 'offer', 'limited', 'new', 'best', 'value',
  'buy', 'get', 'free', 'bonus', 'extra', 'special', 'exclusive', 'online only',
  'website exclusive', 'price drop', 'clearance', 'now', 'only',
]);

const STOP_WORDS = new Set(['a', 'an', 'the', 'with', 'and', 'or', 'in', 'of', 'for', 'to', 'by']);

export function cleanTitle(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s\-&]/g, ' ')
    .split(' ')
    .filter((t) => t.length > 1 && !PROMO_TOKENS.has(t))
    .join(' ')
    .trim();
}

export function titleTokens(title: string): string[] {
  return cleanTitle(title)
    .split(' ')
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

export function tokenOverlap(a: string, b: string): number {
  const ta = new Set(titleTokens(a));
  const tb = new Set(titleTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;

  let shared = 0;
  for (const t of ta) {
    if (tb.has(t)) shared++;
  }
  return shared / Math.min(ta.size, tb.size);
}
