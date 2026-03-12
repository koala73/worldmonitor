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

interface BootstrapPredictionData {
  geopolitical: PredictionMarket[];
  tech: PredictionMarket[];
  fetchedAt: number;
}

function protoToMarket(m: { title: string; yesPrice: number; volume: number; url: string; closesAt: number; category: string }): PredictionMarket {
  return {
    title: m.title,
    yesPrice: m.yesPrice * 100,
    volume: m.volume,
    url: m.url || undefined,
    endDate: m.closesAt ? new Date(m.closesAt).toISOString() : undefined,
  };
}

export async function fetchPredictions(): Promise<PredictionMarket[]> {
  return breaker.execute(async () => {
    // Strategy 1: Bootstrap hydration (zero network cost — data arrived with page load)
    const hydrated = getHydratedData('predictions') as BootstrapPredictionData | undefined;
    if (hydrated && hydrated.fetchedAt && Date.now() - hydrated.fetchedAt < 20 * 60 * 1000) {
      const variant = SITE_VARIANT === 'tech' ? hydrated.tech : hydrated.geopolitical;
      if (variant && variant.length > 0) {
        return variant.filter(m => !isExpired(m.endDate)).slice(0, 15);
      }
    }

    // Strategy 2: Sebuf RPC (Vercel → Redis / Gamma API server-side)
    const tags = SITE_VARIANT === 'tech' ? TECH_TAGS : GEOPOLITICAL_TAGS;
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
        .filter(m => {
          const discrepancy = Math.abs(m.yesPrice - 50);
          return discrepancy > 5 || (m.volume && m.volume > 50000);
        })
        .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
        .slice(0, 15);
    }

    throw new Error('No markets returned — upstream may be down');
  }, []);
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
