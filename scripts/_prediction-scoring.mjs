import predictionTags from './data/prediction-tags.json' with { type: 'json' };

export const EXCLUDE_KEYWORDS = predictionTags.excludeKeywords;

export const MEME_PATTERNS = [
  /\b(lebron|kanye|oprah|swift|rogan|dwayne|kardashian|cardi\s*b)\b/i,
  /\b(alien|ufo|zombie|flat earth)\b/i,
];

export const REGION_PATTERNS = {
  america: /\b(us|u\.s\.|united states|america|trump|biden|congress|federal reserve|canada|mexico|brazil)\b/i,
  eu: /\b(europe|european|eu|nato|germany|france|uk|britain|macron|ecb)\b/i,
  mena: /\b(middle east|iran|iraq|syria|israel|palestine|gaza|saudi|yemen|houthi|lebanon)\b/i,
  asia: /\b(china|japan|korea|india|taiwan|xi jinping|asean)\b/i,
  latam: /\b(latin america|brazil|argentina|venezuela|colombia|chile)\b/i,
  africa: /\b(africa|nigeria|south africa|ethiopia|sahel|kenya)\b/i,
  oceania: /\b(australia|new zealand)\b/i,
};

export function isExcluded(title) {
  const lower = title.toLowerCase();
  return EXCLUDE_KEYWORDS.some(kw => lower.includes(kw));
}

export function isMemeCandidate(title, yesPrice) {
  if (yesPrice >= 15) return false;
  return MEME_PATTERNS.some(p => p.test(title));
}

export function tagRegions(title) {
  return Object.entries(REGION_PATTERNS)
    .filter(([, re]) => re.test(title))
    .map(([region]) => region);
}

export function parseYesPrice(market) {
  try {
    const prices = JSON.parse(market.outcomePrices || '[]');
    if (prices.length >= 1) {
      const p = parseFloat(prices[0]);
      if (!Number.isNaN(p) && p >= 0 && p <= 1) return +(p * 100).toFixed(1);
    }
  } catch {}
  return null;
}

export function shouldInclude(m, relaxed = false) {
  const minPrice = relaxed ? 5 : 10;
  const maxPrice = relaxed ? 95 : 90;
  if (m.yesPrice < minPrice || m.yesPrice > maxPrice) return false;
  if (m.volume < 5000) return false;
  if (isExcluded(m.title)) return false;
  if (isMemeCandidate(m.title, m.yesPrice)) return false;
  return true;
}

export function scoreMarket(m) {
  const uncertainty = 1 - (2 * Math.abs(m.yesPrice - 50) / 100);
  const vol = Math.log10(Math.max(m.volume, 1)) / Math.log10(10_000_000);
  return (uncertainty * 0.6) + (Math.min(vol, 1) * 0.4);
}

export function isExpired(endDate) {
  if (!endDate) return false;
  const ms = Date.parse(endDate);
  return Number.isFinite(ms) && ms < Date.now();
}

export function filterAndScore(candidates, tagFilter, limit = 25) {
  let filtered = candidates.filter(m => !isExpired(m.endDate));
  if (tagFilter) filtered = filtered.filter(tagFilter);

  let result = filtered.filter(m => shouldInclude(m));
  if (result.length < 15) {
    result = filtered.filter(m => shouldInclude(m, true));
  }

  return result
    .map(m => ({ ...m, regions: tagRegions(m.title) }))
    .sort((a, b) => scoreMarket(b) - scoreMarket(a))
    .slice(0, limit);
}
