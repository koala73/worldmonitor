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
  regions?: string[];
}

function isExpired(endDate?: string): boolean {
  if (!endDate) return false;
  const ms = Date.parse(endDate);
  return Number.isFinite(ms) && ms < Date.now();
}

const breaker = createCircuitBreaker<PredictionMarket[]>({ name: 'Polymarket', cacheTtlMs: 10 * 60 * 1000, persistCache: true });

const client = new PredictionServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });

const GEOPOLITICAL_TAGS = [
  'politics', 'geopolitics', 'elections', 'world',
  'ukraine', 'china', 'middle-east', 'europe',
  'economy', 'fed', 'inflation',
];

const TECH_TAGS = [
  'ai', 'tech', 'crypto', 'science',
  'elon-musk', 'business', 'economy',
];

const FINANCE_TAGS = [
  'economy', 'fed', 'inflation', 'interest-rates', 'recession',
  'trade', 'tariffs', 'debt-ceiling',
];

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

function protoToMarket(m: { title: string; yesPrice: number; volume: number; url: string; closesAt: number; category: string }): PredictionMarket {
  return {
    title: m.title,
    yesPrice: m.yesPrice * 100,
    volume: m.volume,
    url: m.url || undefined,
    endDate: m.closesAt ? new Date(m.closesAt).toISOString() : undefined,
    regions: tagRegions(m.title),
  };
}

export async function fetchPredictions(opts?: { region?: string }): Promise<PredictionMarket[]> {
  const markets = await breaker.execute(async () => {
    const hydrated = getHydratedData('predictions') as BootstrapPredictionData | undefined;
    if (hydrated && hydrated.fetchedAt && Date.now() - hydrated.fetchedAt < 20 * 60 * 1000) {
      const variant = SITE_VARIANT === 'tech' ? hydrated.tech
        : SITE_VARIANT === 'finance' ? (hydrated.finance ?? hydrated.geopolitical)
        : hydrated.geopolitical;
      if (variant && variant.length > 0) {
        return variant.filter(m => !isExpired(m.endDate)).slice(0, 25);
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

export async function fetchCountryMarkets(country: string): Promise<PredictionMarket[]> {
  try {
    const resp = await client.listPredictionMarkets({
      category: 'geopolitics',
      query: country,
      pageSize: 30,
      cursor: '',
    });
    if (resp.markets && resp.markets.length > 0) {
      return resp.markets
        .map(protoToMarket)
        .filter(m => !isExpired(m.endDate))
        .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
        .slice(0, 5);
    }
  } catch { /* RPC failed, fall through to bootstrap filter */ }

  const hydrated = getHydratedData('predictions') as BootstrapPredictionData | undefined;
  if (hydrated?.geopolitical?.length) {
    const lower = country.toLowerCase();
    const filtered = hydrated.geopolitical
      .filter(m => !isExpired(m.endDate) && m.title.toLowerCase().includes(lower))
      .slice(0, 5);
    if (filtered.length > 0) return filtered;
  }

  return [];
}
