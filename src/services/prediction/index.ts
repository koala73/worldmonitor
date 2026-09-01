
import { getRpcBaseUrl } from '@/services/rpc-client';
import { createCircuitBreaker } from '@/utils';
import { SITE_VARIANT } from '@/config';
import { getHydratedData } from '@/services/bootstrap';

export interface PredictionMarket {
  title: string;
  yesPrice: number;     // 0-100 scale (legacy compat)
  volume?: number;
  url?: string;
  endDate?: string;
  source?: 'polymarket' | 'kalshi';
  regions?: string[];
}

function isExpired(endDate?: string): boolean {
  if (!endDate) return false;
  const ms = Date.parse(endDate);
  return Number.isFinite(ms) && ms < Date.now();
}

const breaker = createCircuitBreaker<PredictionMarket[]>({ name: 'Polymarket', cacheTtlMs: 10 * 60 * 1000, persistCache: true });

const client = new PredictionServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });

import predictionTags from '../../../scripts/data/prediction-tags.json';
import { PredictionServiceClient } from '@/services/generated-rpc-clients';

const GEOPOLITICAL_TAGS = predictionTags.geopolitical;
const TECH_TAGS = predictionTags.tech;
const FINANCE_TAGS = predictionTags.finance;

interface BootstrapPredictionData {
  geopolitical: PredictionMarket[];
  tech: PredictionMarket[];
  finance?: PredictionMarket[];
  fetchedAt: number;
}

const REGION_PATTERNS: Record<string, RegExp> = {
  america: /\b(us|u\.s\.|united states|america|trump|biden|congress|federal reserve|canada|mexico|brazil)\b/i,
  eu: /\b(europe|european|eu|nato|germany|france|uk|britain|macron|ecb)\b/i,
  mena: /\b(middle east|iran|iraq|syria|israel|palestine|gaza|saudi|yemen|houthi|lebanon)\b/i,
  asia: /\b(china|japan|korea|india|taiwan|xi jinping|asean)\b/i,
  latam: /\b(latin america|brazil|argentina|venezuela|colombia|chile)\b/i,
  africa: /\b(africa|nigeria|south africa|ethiopia|sahel|kenya)\b/i,
  oceania: /\b(australia|new zealand)\b/i,
};

function tagRegions(title: string): string[] {
  return Object.entries(REGION_PATTERNS)
    .filter(([, re]) => re.test(title))
    .map(([region]) => region);
}

function protoToMarket(m: { title: string; yesPrice: number; volume: number; url: string; closesAt: number; category: string; source?: string }): PredictionMarket {
  return {
    title: m.title,
    yesPrice: m.yesPrice * 100,
    volume: m.volume,
    url: m.url || undefined,
    endDate: m.closesAt ? new Date(m.closesAt).toISOString() : undefined,
    source: m.source === 'MARKET_SOURCE_KALSHI' ? 'kalshi' : 'polymarket',
    regions: tagRegions(m.title),
  };
}

export async function fetchPredictions(opts?: { region?: string }): Promise<PredictionMarket[]> {
  const markets = await breaker.execute(async () => {
    const hydrated = getHydratedData('predictions') as BootstrapPredictionData | undefined;
    if (hydrated?.fetchedAt && Date.now() - hydrated.fetchedAt < 40 * 60 * 1000) {
      const variant = SITE_VARIANT === 'tech' ? hydrated.tech
        : SITE_VARIANT === 'finance' ? (hydrated.finance ?? hydrated.geopolitical)
        : hydrated.geopolitical;
      if (variant && variant.length > 0) {
        return variant
          .filter(m => !isExpired(m.endDate))
          .slice(0, 25)
          .map(m => m.source ? m : { ...m, source: 'polymarket' as const });
      }
    }

    const tags = SITE_VARIANT === 'tech' ? TECH_TAGS
      : SITE_VARIANT === 'finance' ? FINANCE_TAGS
      : GEOPOLITICAL_TAGS;
    const rpcResults = await client.listPredictionMarkets({
      category: tags[0] ?? '',
      query: '',
      pageSize: 50,
      cursor: '',
    });
    if (rpcResults.markets && rpcResults.markets.length > 0) {
      return rpcResults.markets
        .map(protoToMarket)
        .filter(m => !isExpired(m.endDate))
        .filter(m => m.yesPrice >= 10 && m.yesPrice <= 90)
        .sort((a, b) => {
          const aUncertainty = 1 - (2 * Math.abs(a.yesPrice - 50) / 100);
          const bUncertainty = 1 - (2 * Math.abs(b.yesPrice - 50) / 100);
          return bUncertainty - aUncertainty;
        })
        .slice(0, 25);
    }

    throw new Error('No markets returned — upstream may be down');
  }, []);

  if (opts?.region && opts.region !== 'global' && markets.length > 0) {
    const sorted = [...markets];
    sorted.sort((a, b) => {
      const aMatch = a.regions?.includes(opts.region!) ? 1 : 0;
      const bMatch = b.regions?.includes(opts.region!) ? 1 : 0;
      return bMatch - aMatch;
    });
    return sorted.slice(0, 15);
  }
  return markets.slice(0, 15);
}

interface CountryMetadata {
  name?: string;
  keywords?: string[];
}

interface PredictionCountryLanguage {
  terms?: string[];
  excludedBaseTerms?: string[];
  requiredContext?: string[];
  excludedPhrases?: string[];
}

interface CountrySearchMatcher {
  names: string[];
  terms: string[];
  requiredContext: string[];
  excludedPhrases: string[];
}

function normalizeCountryText(value: string): string {
  const words = value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return words ? ` ${words} ` : '';
}

async function countrySearchMatcher(country: string, countryCode: string): Promise<CountrySearchMatcher> {
  const [{ default: countryCodes }, { default: predictionCountryLanguage }] = await Promise.all([
    import('../../../scripts/data/country-codes.json'),
    import('../../../scripts/shared/prediction-country-language.json'),
  ]);
  const countryMetadata = countryCodes as Record<string, CountryMetadata>;
  const countryLanguage = predictionCountryLanguage.countries as Record<string, PredictionCountryLanguage>;
  const metadata = countryMetadata[countryCode] ?? {};
  const language = countryLanguage[countryCode] ?? {};
  const names = [...new Set([country, metadata.name]
    .map((name) => String(name ?? '').trim())
    .filter(Boolean))];
  const normalizedNames = new Set(names.map((name) => name.toLowerCase()));
  const excludedBaseTerms = new Set(language.excludedBaseTerms ?? []);
  const terms = [...new Set([
    ...(metadata.keywords ?? []).filter((term) => !excludedBaseTerms.has(term.toLowerCase())),
    ...(language.terms ?? []),
  ]
    .map((term) => String(term).trim())
    .filter((term) => term && !normalizedNames.has(term.toLowerCase())))];

  return {
    names: names.map(normalizeCountryText),
    terms: terms.map(normalizeCountryText),
    requiredContext: (language.requiredContext ?? []).map(normalizeCountryText),
    excludedPhrases: (language.excludedPhrases ?? []).map(normalizeCountryText),
  };
}

function termOccursOutsideExcludedPhrase(
  normalizedTitle: string,
  term: string,
  excludedPhrases: string[],
): boolean {
  let start = normalizedTitle.indexOf(term);
  while (start >= 0) {
    const end = start + term.length;
    const excluded = excludedPhrases.some((phrase) => {
      let phraseStart = normalizedTitle.indexOf(phrase);
      while (phraseStart >= 0) {
        if (phraseStart <= start && phraseStart + phrase.length >= end) return true;
        phraseStart = normalizedTitle.indexOf(phrase, phraseStart + 1);
      }
      return false;
    });
    if (!excluded) return true;
    start = normalizedTitle.indexOf(term, start + 1);
  }
  return false;
}

function matchesCountryTerms(title: string, matcher: CountrySearchMatcher): boolean {
  const normalizedTitle = normalizeCountryText(title);
  const hasRequiredContext = matcher.requiredContext.length === 0
    || matcher.requiredContext.some((term) => normalizedTitle.includes(term));
  const matchingNames = hasRequiredContext ? matcher.names : [];
  return [...matchingNames, ...matcher.terms]
    .some((term) => termOccursOutsideExcludedPhrase(normalizedTitle, term, matcher.excludedPhrases));
}

export async function fetchCountryMarkets(country: string, countryCode: string): Promise<PredictionMarket[]> {
  const normalizedCode = countryCode.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(normalizedCode)) {
    const response = await client.listPredictionMarkets({
      category: `country:${normalizedCode}`,
      query: '',
      pageSize: 5,
      cursor: '',
    }).catch(() => null);
    if (response?.markets?.length) {
      return response.markets.map(protoToMarket).filter(m => !isExpired(m.endDate)).slice(0, 5);
    }
    if (response?.dataAvailable) return [];
  }

  const matcher = await countrySearchMatcher(country, normalizedCode);

  // Fallback: search bootstrap data across all buckets. `tech` must be included
  // explicitly — until #5733 the geopolitical bucket was an unfiltered copy of
  // every market, so omitting tech here was invisible; now the buckets are a
  // disjoint partition and a tech-classified country market (e.g. a Chinese AI
  // model line) would be unreachable without it.
  const hydrated = getHydratedData('predictions') as BootstrapPredictionData | undefined;
  if (hydrated) {
    const buckets = [...(hydrated.geopolitical ?? []), ...(hydrated.tech ?? []), ...(hydrated.finance ?? [])];
    const filtered = buckets
      .filter(m => !isExpired(m.endDate) && matchesCountryTerms(m.title, matcher))
      .filter((market, index, all) => all.findIndex((candidate) => candidate.url === market.url) === index)
      .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
      .slice(0, 5);
    if (filtered.length > 0) return filtered;
  }

  return [];
}
