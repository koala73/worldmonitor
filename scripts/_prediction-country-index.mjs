import countryCodes from './data/country-codes.json' with { type: 'json' };
import { isExpired, shouldInclude } from './_prediction-scoring.mjs';

export const COUNTRY_MARKET_LIMIT = 5;

const PREDICTION_COUNTRY_KEYWORDS = Object.freeze({
  US: ['american', 'congress', 'white house', 'federal reserve', 'fed rate', 'fed chair', 'fed cut', 'fed hike', 'us recession', 'us gdp', 'us election', 'us tariff', 'us president', 'us presidency'],
  GB: ['british', 'uk election', 'uk economy', 'uk prime minister'],
  KR: ['south korean'],
  KP: ['dprk'],
  AE: ['emirati'],
  SA: ['saudi'],
});

const AMBIGUOUS_COUNTRY_KEYWORDS = Object.freeze({
  US: new Set(['america']),
});

function normalizeSearchText(value) {
  const words = String(value)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return words ? ` ${words} ` : '';
}

function compileCountryMatchers(countries) {
  return Object.entries(countries).map(([countryCode, country]) => {
    const name = String(country?.name ?? '').trim();
    const ambiguous = AMBIGUOUS_COUNTRY_KEYWORDS[countryCode] ?? new Set();
    const keywords = [...new Set([...(country?.keywords ?? []), ...(PREDICTION_COUNTRY_KEYWORDS[countryCode] ?? [])]
      .map((keyword) => String(keyword).trim())
      .filter((keyword) => keyword
        && keyword.toLowerCase() !== name.toLowerCase()
        && !ambiguous.has(keyword.toLowerCase())))];
    return {
      countryCode,
      name: normalizeSearchText(name),
      keywords: keywords.map(normalizeSearchText),
    };
  });
}

function countryMatchStrength(normalizedTitle, matcher) {
  if (matcher.name && normalizedTitle.includes(matcher.name)) return 2;
  if (matcher.keywords.some((keyword) => normalizedTitle.includes(keyword))) return 1;
  return 0;
}

function marketEventIdentity(market) {
  const eventKey = String(market?.eventKey ?? '').trim();
  if (eventKey) return eventKey;
  const url = String(market?.url ?? '').trim();
  if (url) return url;
  return String(market?.title ?? '').trim().toLowerCase();
}

function closeTime(market) {
  const value = Date.parse(String(market?.endDate ?? ''));
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function volume(market) {
  const value = Number(market?.volume);
  return Number.isFinite(value) ? value : 0;
}

function compareRankedMarkets(left, right) {
  return left.closeAt - right.closeAt
    || right.matchStrength - left.matchStrength
    || right.volume - left.volume
    || String(left.market.title).localeCompare(String(right.market.title));
}

function dedupeEvents(ranked) {
  const best = new Map();
  for (const candidate of ranked) {
    const identity = marketEventIdentity(candidate.market);
    const incumbent = best.get(identity);
    if (!incumbent || compareRankedMarkets(candidate, incumbent) < 0) {
      best.set(identity, candidate);
    }
  }
  return [...best.values()].sort(compareRankedMarkets);
}

function selectWithProviderCoverage(ranked, limit) {
  const selected = ranked.slice(0, limit);
  const availableSources = new Set(ranked.map(({ market }) => market.source).filter(Boolean));
  const selectedSources = new Set(selected.map(({ market }) => market.source).filter(Boolean));

  for (const source of availableSources) {
    if (selectedSources.has(source)) continue;
    const candidate = ranked.find(({ market }) => market.source === source);
    if (!candidate) continue;
    if (selected.length < limit) selected.push(candidate);
    else selected[selected.length - 1] = candidate;
    selectedSources.add(source);
  }

  return [...new Map(selected.map((candidate) => [marketEventIdentity(candidate.market), candidate])).values()]
    .sort(compareRankedMarkets)
    .slice(0, limit);
}

function publicMarket(market) {
  return {
    title: market.title,
    yesPrice: market.yesPrice,
    volume: market.volume,
    url: market.url,
    ...(market.endDate ? { endDate: market.endDate } : {}),
    source: market.source,
  };
}

export function buildCountryMarketIndex(markets, {
  limit = COUNTRY_MARKET_LIMIT,
  now = Date.now(),
  countries = countryCodes,
} = {}) {
  const candidates = Array.isArray(markets)
    ? markets
      .filter((market) => market && !isExpired(market.endDate, now))
      .map((market) => ({ market, normalizedTitle: normalizeSearchText(market.title) }))
    : [];
  const strictCandidates = candidates.filter(({ market }) => shouldInclude(market));
  const relaxedCandidates = candidates.filter(({ market }) => shouldInclude(market, true));
  const index = {};

  for (const matcher of compileCountryMatchers(countries)) {
    const rank = (eligible) => dedupeEvents(eligible
      .map(({ market, normalizedTitle }) => ({
        market,
        matchStrength: countryMatchStrength(normalizedTitle, matcher),
        closeAt: closeTime(market),
        volume: volume(market),
      }))
      .filter(({ matchStrength }) => matchStrength > 0));

    let ranked = rank(strictCandidates);
    if (ranked.length < limit) ranked = rank(relaxedCandidates);
    if (ranked.length === 0) continue;

    index[matcher.countryCode] = selectWithProviderCoverage(ranked, limit)
      .map(({ market }) => publicMarket(market));
  }

  return index;
}
