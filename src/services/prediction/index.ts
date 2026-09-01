
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

interface PredictionCountryLanguageFile {
  countries?: Record<string, PredictionCountryLanguage>;
  termShadows?: Record<string, { term: string; specificCountryCode: string }>;
}

interface CountrySearchMatcher {
  countryCode: string;
  names: string[];
  terms: string[];
  requiredContext: string[];
  excludedPhrases: string[];
}

interface CountryTermShadow {
  term: string;
  specificCountryCode: string;
}

interface CountryTermOccurrence {
  countryCode: string;
  start: number;
  end: number;
  term: string;
}

interface CountrySearchIndex {
  matchers: CountrySearchMatcher[];
  shadows: Record<string, CountryTermShadow>;
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

function compileCountrySearchMatcher(
  countryCode: string,
  displayNames: string[],
  metadata: CountryMetadata,
  language: PredictionCountryLanguage,
): CountrySearchMatcher {
  const names = [...new Set(displayNames
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
    countryCode,
    names: names.map(normalizeCountryText),
    terms: terms.map(normalizeCountryText),
    requiredContext: (language.requiredContext ?? []).map(normalizeCountryText),
    excludedPhrases: (language.excludedPhrases ?? []).map(normalizeCountryText),
  };
}

async function loadCountrySearchIndex(country: string, countryCode: string): Promise<CountrySearchIndex> {
  const [{ default: countryCodes }, { default: predictionCountryLanguage }] = await Promise.all([
    import('../../../scripts/data/country-codes.json'),
    import('../../../scripts/shared/prediction-country-language.json'),
  ]);
  const countryMetadata = countryCodes as Record<string, CountryMetadata>;
  const languageFile = predictionCountryLanguage as PredictionCountryLanguageFile;
  const countryLanguage = languageFile.countries ?? {};
  const matchers = Object.entries(countryMetadata).map(([code, metadata]) => (
    compileCountrySearchMatcher(
      code,
      code === countryCode ? [country, metadata.name ?? ''] : [metadata.name ?? ''],
      metadata,
      countryLanguage[code] ?? {},
    )
  ));
  if (!countryMetadata[countryCode]) {
    matchers.push(compileCountrySearchMatcher(
      countryCode,
      [country],
      {},
      countryLanguage[countryCode] ?? {},
    ));
  }
  const shadows = Object.fromEntries(
    Object.entries(languageFile.termShadows ?? {}).map(([code, shadow]) => [
      code,
      { specificCountryCode: shadow.specificCountryCode, term: normalizeCountryText(shadow.term) },
    ]),
  );
  return { matchers, shadows };
}

function termOccurrences(
  normalizedTitle: string,
  term: string,
  countryCode: string,
): CountryTermOccurrence[] {
  if (!term) return [];
  const matches: CountryTermOccurrence[] = [];
  let start = normalizedTitle.indexOf(term);
  while (start >= 0) {
    matches.push({ countryCode, start, end: start + term.length, term });
    start = normalizedTitle.indexOf(term, start + 1);
  }
  return matches;
}

function occurrenceFallsWithin(
  normalizedTitle: string,
  candidate: CountryTermOccurrence,
  enclosingTerm: string,
): boolean {
  if (!enclosingTerm) return false;
  let start = normalizedTitle.indexOf(enclosingTerm);
  while (start >= 0) {
    if (start <= candidate.start && start + enclosingTerm.length >= candidate.end) return true;
    start = normalizedTitle.indexOf(enclosingTerm, start + 1);
  }
  return false;
}

function associatedCountryCodes(
  title: string,
  matchers: CountrySearchMatcher[],
  shadows: Record<string, CountryTermShadow>,
): Set<string> {
  const normalizedTitle = normalizeCountryText(title);
  const rawMatches: CountryTermOccurrence[] = [];
  const matcherByCountryCode = new Map(matchers.map((matcher) => [matcher.countryCode, matcher]));

  for (const matcher of matchers) {
    const hasRequiredContext = matcher.requiredContext.length === 0
      || matcher.requiredContext.some((term) => normalizedTitle.includes(term));
    if (hasRequiredContext) {
      for (const name of matcher.names) {
        rawMatches.push(...termOccurrences(normalizedTitle, name, matcher.countryCode));
      }
    }
    for (const term of matcher.terms) {
      rawMatches.push(...termOccurrences(normalizedTitle, term, matcher.countryCode));
    }
  }

  const associated = new Set<string>();
  for (const candidate of rawMatches) {
    const shadow = shadows[candidate.countryCode];
    const shadowedByCountryContext = Boolean(
      shadow
      && candidate.term === shadow.term
      && rawMatches.some((other) => other.countryCode === shadow.specificCountryCode),
    );
    const matcher = matcherByCountryCode.get(candidate.countryCode);
    const shadowedByPhrase = (matcher?.excludedPhrases ?? [])
      .some((phrase) => occurrenceFallsWithin(normalizedTitle, candidate, phrase));
    const embeddedInSpecificCountry = rawMatches.some((other) => (
      other.countryCode !== candidate.countryCode
      && other.term.length > candidate.term.length
      && other.start <= candidate.start
      && other.end >= candidate.end
    ));
    if (shadowedByCountryContext || shadowedByPhrase || embeddedInSpecificCountry) continue;
    associated.add(candidate.countryCode);
  }
  return associated;
}

function matchesCountryTerms(
  title: string,
  countryCode: string,
  matchers: CountrySearchMatcher[],
  shadows: Record<string, CountryTermShadow>,
): boolean {
  return associatedCountryCodes(title, matchers, shadows).has(countryCode);
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

  // Fallback: search bootstrap data across all buckets. `tech` must be included
  // explicitly — until #5733 the geopolitical bucket was an unfiltered copy of
  // every market, so omitting tech here was invisible; now the buckets are a
  // disjoint partition and a tech-classified country market (e.g. a Chinese AI
  // model line) would be unreachable without it.
  const hydrated = getHydratedData('predictions') as BootstrapPredictionData | undefined;
  if (hydrated) {
    const { matchers, shadows } = await loadCountrySearchIndex(country, normalizedCode);
    const buckets = [...(hydrated.geopolitical ?? []), ...(hydrated.tech ?? []), ...(hydrated.finance ?? [])];
    const filtered = buckets
      .filter(m => !isExpired(m.endDate) && matchesCountryTerms(m.title, normalizedCode, matchers, shadows))
      .filter((market, index, all) => all.findIndex((candidate) => candidate.url === market.url) === index)
      .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
      .slice(0, 5);
    if (filtered.length > 0) return filtered;
  }

  return [];
}
