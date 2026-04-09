import { PredictionServiceClient } from '@/generated/client/worldmonitor/prediction/v1/service_client';
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

const COUNTRY_SEARCH_ALIASES: Record<string, string[]> = {
  'United States': ['US', 'America', 'American', 'Trump', 'Biden', 'Fed', 'tariff'],
  'United Kingdom': ['UK', 'Britain', 'British'],
  'South Korea': ['Korea'],
  'United Arab Emirates': ['UAE', 'Dubai', 'Abu Dhabi'],
  'Saudi Arabia': ['Saudi', 'MBS'],
  'North Korea': ['DPRK', 'Pyongyang', 'Kim Jong'],
};

function countrySearchTerms(country: string): string[] {
  const terms = [country];
  const aliases = COUNTRY_SEARCH_ALIASES[country];
  if (aliases) terms.push(...aliases);
  return terms;
}

function matchesCountryTerms(title: string, terms: string[]): boolean {
  return terms.some(t => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(title));
}

export async function fetchCountryMarkets(country: string): Promise<PredictionMarket[]> {
  const terms = countrySearchTerms(country);
  const allMarkets: PredictionMarket[] = [];

  // Try RPC across geopolitics + finance (parallel, both cover most country markets)
  const rpcResults = await Promise.allSettled(
    (['geopolitics', 'economy'] as const).map(category =>
      client.listPredictionMarkets({ category, query: country, pageSize: 30, cursor: '' })
    )
  );
  for (const result of rpcResults) {
    if (result.status === 'fulfilled' && result.value.markets?.length) {
      allMarkets.push(...result.value.markets.map(protoToMarket).filter(m => !isExpired(m.endDate)));
    }
  }

  if (allMarkets.length > 0) {
    // Filter by any matching term, deduplicate by URL, sort by volume
    const matched = allMarkets
      .filter(m => matchesCountryTerms(m.title, terms))
      .filter((m, i, arr) => arr.findIndex(x => x.url === m.url) === i)
      .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
      .slice(0, 5);
    if (matched.length > 0) return matched;
  }

  // Fallback: search bootstrap data across all buckets
  const hydrated = getHydratedData('predictions') as BootstrapPredictionData | undefined;
  if (hydrated) {
    const buckets = [...(hydrated.geopolitical ?? []), ...(hydrated.finance ?? [])];
    const filtered = buckets
      .filter(m => !isExpired(m.endDate) && matchesCountryTerms(m.title, terms))
      .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
      .slice(0, 5);
    if (filtered.length > 0) return filtered;
  }

  return [];
}
