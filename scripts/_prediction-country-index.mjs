import countryCodes from './data/country-codes.json' with { type: 'json' };
import { isExpired, shouldInclude } from './_prediction-scoring.mjs';

export const COUNTRY_MARKET_LIMIT = 5;

export function countCountryMarkets(countryMarkets) {
  return Object.values(countryMarkets ?? {})
    .reduce((count, markets) => count + (Array.isArray(markets) ? markets.length : 0), 0);
}

const PREDICTION_COUNTRY_KEYWORDS = Object.freeze({
  US: ['american', 'congress', 'white house', 'federal reserve', 'the fed', 'fed rate', 'fed chair', 'fed cut', 'fed hike', 'us recession', 'us gdp', 'us election', 'us tariff', 'us president', 'us presidency'],
  GB: ['british', 'uk election', 'uk economy', 'uk prime minister'],
  KR: ['south korean'],
  KP: ['dprk'],
  AE: ['emirati'],
  SA: ['saudi'],
  CD: ['democratic republic of congo', 'democratic republic of the congo'],
  GE: ['georgian'],
  JO: ['jordanian'],
  TD: ['chadian', 'n djamena'],
});

const AMBIGUOUS_COUNTRY_KEYWORDS = Object.freeze({
  US: new Set(['america', 'washington']),
  CD: new Set(['congo']),
});

const REQUIRED_COUNTRY_CONTEXT = Object.freeze({
  GE: ['tbilisi', 'georgian', 'abkhazia', 'ossetia', 'caucasus', 'saakashvili', 'ivanishvili', 'batumi', 'kutaisi'],
  JO: ['jordanian', 'amman'],
  TD: ['chadian', 'n djamena', 'ndjamena'],
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

const COUNTRY_TERM_SHADOWS = Object.freeze({
  CG: { term: normalizeSearchText('congo'), specificCountryCode: 'CD' },
});

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
      requiredContext: (REQUIRED_COUNTRY_CONTEXT[countryCode] ?? []).map(normalizeSearchText),
    };
  });
}

function termOccurrences(normalizedTitle, term, matchStrength, countryCode) {
  const matches = [];
  let start = normalizedTitle.indexOf(term);
  while (start >= 0) {
    matches.push({ countryCode, start, end: start + term.length, term, matchStrength });
    start = normalizedTitle.indexOf(term, start + 1);
  }
  return matches;
}

function countryMatches(normalizedTitle, matchers) {
  const rawMatches = [];
  for (const matcher of matchers) {
    const hasCountryContext = matcher.requiredContext.length === 0
      || matcher.requiredContext.some((term) => normalizedTitle.includes(term));
    if (matcher.name && hasCountryContext) {
      rawMatches.push(...termOccurrences(normalizedTitle, matcher.name, 2, matcher.countryCode));
    }
    for (const keyword of matcher.keywords) {
      rawMatches.push(...termOccurrences(normalizedTitle, keyword, 1, matcher.countryCode));
    }
  }

  const strongest = new Map();
  for (const candidate of rawMatches) {
    const shadow = COUNTRY_TERM_SHADOWS[candidate.countryCode];
    const shadowedByCountryContext = shadow
      && candidate.term === shadow.term
      && rawMatches.some((other) => other.countryCode === shadow.specificCountryCode);
    const embeddedInSpecificCountry = rawMatches.some((other) => (
      other.countryCode !== candidate.countryCode
      && other.term.length > candidate.term.length
      && other.start <= candidate.start
      && other.end >= candidate.end
    ));
    if (shadowedByCountryContext || embeddedInSpecificCountry) continue;
    const incumbent = strongest.get(candidate.countryCode);
    if (!incumbent
      || candidate.matchStrength > incumbent.matchStrength
      || (candidate.matchStrength === incumbent.matchStrength && candidate.term.length > incumbent.term.length)) {
      strongest.set(candidate.countryCode, candidate);
    }
  }
  return strongest;
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
  const matchers = compileCountryMatchers(countries);
  const candidates = Array.isArray(markets)
    ? markets
      .filter((market) => market && !isExpired(market.endDate, now))
      .map((market) => {
        const normalizedTitle = normalizeSearchText(market.title);
        return { market, countryMatches: countryMatches(normalizedTitle, matchers) };
      })
    : [];
  const strictCandidates = candidates.filter(({ market }) => shouldInclude(market));
  const relaxedCandidates = candidates.filter(({ market }) => shouldInclude(market, true));
  const index = {};

  for (const matcher of matchers) {
    const rank = (eligible) => dedupeEvents(eligible
      .map(({ market, countryMatches: matches }) => {
        const match = matches.get(matcher.countryCode);
        return {
          market,
          matchStrength: match?.matchStrength ?? 0,
          closeAt: closeTime(market),
          volume: volume(market),
        };
      })
      .filter(({ matchStrength }) => matchStrength > 0));

    let ranked = rank(strictCandidates);
    if (ranked.length < limit) ranked = rank(relaxedCandidates);
    if (ranked.length === 0) continue;

    index[matcher.countryCode] = selectWithProviderCoverage(ranked, limit)
      .map(({ market }) => publicMarket(market));
  }

  return index;
}
