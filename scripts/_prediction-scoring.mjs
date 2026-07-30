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

// Kalshi mirror of parseYesPrice: null for unreadable prices — a fabricated
// default (e.g. 50) would flow downstream as a finite anchor and calibrate
// forecasts against invented data. Whole-string validation: parseFloat would
// accept malformed prefixes ('0.62oops' → 0.62, '0,62' → 0).
export function parseKalshiYesPrice(market) {
  const raw = market?.last_price_dollars;
  const str = typeof raw === 'number' ? raw : String(raw ?? '').trim();
  const p = str === '' ? NaN : Number(str);
  if (!Number.isFinite(p) || p < 0 || p > 1) return null;
  return +(p * 100).toFixed(1);
}

// Pick the highest-volume PRICED market of a Kalshi event; an unpriced
// top-volume market must not sink the whole event when a priced sibling exists.
export function selectPricedKalshiMarket(markets) {
  let best = null;
  let bestPrice = null;
  let bestVol = -1;
  for (const m of markets || []) {
    const price = parseKalshiYesPrice(m);
    if (price === null) continue;
    const vol = parseFloat(m.volume_fp) || 0;
    if (vol > bestVol) {
      best = m;
      bestVol = vol;
      bestPrice = price;
    }
  }
  return best ? { market: best, yesPrice: bestPrice } : null;
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

// Rank markets by crowd CONVICTION (distance from 50/50), not maximum
// uncertainty. The analyst LLM should see the markets where collective
// betting has converged on a directional answer, with volume as a tiebreaker.
//
// The previous formula inverted this — it weighted 50/50 markets highest,
// burying high-signal contested markets (e.g. "Iran strike: 88% YES") below
// coin-flip ones. See #3735 + #3726. Lopsided markets are not a concern here
// because shouldInclude() already clips yesPrice to [10, 90] (relaxed [5, 95]),
// so 99% locks-in never reach the ranker.
export function scoreMarket(m) {
  const conviction = (2 * Math.abs(m.yesPrice - 50)) / 100;
  const vol = Math.log10(Math.max(m.volume, 1)) / Math.log10(10_000_000);
  return (conviction * 0.5) + (Math.min(vol, 1) * 0.5);
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
