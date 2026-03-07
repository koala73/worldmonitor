import { PredictionServiceClient } from '@/generated/client/worldmonitor/prediction/v1/service_client';
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

interface PolymarketMarket {
  question: string;
  volume?: string;
  volumeNum?: number;
  closed?: boolean;
  slug?: string;
  endDate?: string;
  outcomePrices?: string;
}

interface PolymarketEvent {
  id: string;
  title: string;
  slug: string;
  volume?: number;
  markets?: PolymarketMarket[];
  closed?: boolean;
  endDate?: string;
}

function parseEndDate(raw?: string): string | undefined {
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? raw : undefined;
}

function isExpired(endDate?: string): boolean {
  if (!endDate) return false;
  const ms = Date.parse(endDate);
  return Number.isFinite(ms) && ms < Date.now();
}

const breaker = createCircuitBreaker<PredictionMarket[]>({ name: 'Polymarket', cacheTtlMs: 10 * 60 * 1000, persistCache: true });

const client = new PredictionServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });

const GEOPOLITICAL_TAGS = [
  'politics', 'geopolitics', 'elections', 'world',
  'ukraine', 'china', 'middle-east', 'europe',
  'economy', 'fed', 'inflation',
];

const TECH_TAGS = [
  'ai', 'tech', 'crypto', 'science',
  'elon-musk', 'business', 'economy',
];

const COUNTRY_TAG_MAP: Record<string, string[]> = {
  'United States': ['usa', 'politics', 'elections'],
  'Russia': ['russia', 'geopolitics', 'ukraine'],
  'Ukraine': ['ukraine', 'geopolitics', 'russia'],
  'China': ['china', 'geopolitics', 'asia'],
  'Taiwan': ['china', 'asia', 'geopolitics'],
  'Israel': ['middle-east', 'geopolitics'],
  'Palestine': ['middle-east', 'geopolitics'],
  'Iran': ['middle-east', 'geopolitics'],
  'Saudi Arabia': ['middle-east', 'geopolitics'],
  'Turkey': ['middle-east', 'europe'],
  'India': ['asia', 'geopolitics'],
  'Japan': ['asia', 'geopolitics'],
  'South Korea': ['asia', 'geopolitics'],
  'North Korea': ['asia', 'geopolitics'],
  'United Kingdom': ['europe', 'politics'],
  'France': ['europe', 'politics'],
  'Germany': ['europe', 'politics'],
  'Italy': ['europe', 'politics'],
  'Poland': ['europe', 'geopolitics'],
  'Brazil': ['world', 'politics'],
  'United Arab Emirates': ['middle-east', 'world'],
  'Mexico': ['world', 'politics'],
  'Argentina': ['world', 'politics'],
  'Canada': ['world', 'politics'],
  'Australia': ['world', 'politics'],
  'South Africa': ['world', 'politics'],
  'Nigeria': ['world', 'politics'],
  'Egypt': ['middle-east', 'world'],
  'Pakistan': ['asia', 'geopolitics'],
  'Syria': ['middle-east', 'geopolitics'],
  'Yemen': ['middle-east', 'geopolitics'],
  'Lebanon': ['middle-east', 'geopolitics'],
  'Iraq': ['middle-east', 'geopolitics'],
  'Afghanistan': ['geopolitics', 'world'],
  'Venezuela': ['world', 'politics'],
  'Colombia': ['world', 'politics'],
  'Sudan': ['world', 'geopolitics'],
  'Myanmar': ['asia', 'geopolitics'],
  'Philippines': ['asia', 'world'],
  'Indonesia': ['asia', 'world'],
  'Thailand': ['asia', 'world'],
  'Vietnam': ['asia', 'world'],
};

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

function parseMarketPrice(market: PolymarketMarket): number {
  try {
    const pricesStr = market.outcomePrices;
    if (pricesStr) {
      const prices: string[] = JSON.parse(pricesStr);
      if (prices.length >= 1) {
        const parsed = parseFloat(prices[0]!);
        if (!isNaN(parsed)) return parsed * 100;
      }
    }
  } catch {
    // Keep the neutral default when upstream sends malformed data.
  }
  return 50;
}

function buildMarketUrl(eventSlug?: string, marketSlug?: string): string | undefined {
  if (eventSlug) return `https://polymarket.com/event/${eventSlug}`;
  if (marketSlug) return `https://polymarket.com/market/${marketSlug}`;
  return undefined;
}

function getCountryVariants(country: string): string[] {
  const lower = country.toLowerCase();
  const variants = [lower];

  const variantMap: Record<string, string[]> = {
    'russia': ['russian', 'moscow', 'kremlin', 'putin'],
    'ukraine': ['ukrainian', 'kyiv', 'kiev', 'zelensky', 'zelenskyy'],
    'china': ['chinese', 'beijing', 'xi jinping', 'prc'],
    'taiwan': ['taiwanese', 'taipei', 'tsmc'],
    'united states': ['american', 'usa', 'biden', 'trump', 'washington'],
    'israel': ['israeli', 'netanyahu', 'idf', 'tel aviv'],
    'palestine': ['palestinian', 'gaza', 'hamas', 'west bank'],
    'iran': ['iranian', 'tehran', 'khamenei', 'irgc'],
    'north korea': ['dprk', 'pyongyang', 'kim jong un'],
    'south korea': ['korean', 'seoul'],
    'saudi arabia': ['saudi', 'riyadh', 'mbs'],
    'united kingdom': ['british', 'uk', 'britain', 'london'],
    'france': ['french', 'paris', 'macron'],
    'germany': ['german', 'berlin', 'scholz'],
    'turkey': ['turkish', 'ankara', 'erdogan'],
    'india': ['indian', 'delhi', 'modi'],
    'japan': ['japanese', 'tokyo'],
    'brazil': ['brazilian', 'brasilia', 'lula', 'bolsonaro'],
    'united arab emirates': ['uae', 'emirati', 'dubai', 'abu dhabi'],
    'syria': ['syrian', 'damascus', 'assad'],
    'yemen': ['yemeni', 'houthi', 'sanaa'],
    'lebanon': ['lebanese', 'beirut', 'hezbollah'],
    'egypt': ['egyptian', 'cairo', 'sisi'],
    'pakistan': ['pakistani', 'islamabad'],
    'sudan': ['sudanese', 'khartoum'],
    'myanmar': ['burmese', 'burma'],
  };

  const extra = variantMap[lower];
  if (extra) variants.push(...extra);
  return variants;
}

async function fetchCountryEventsByTag(tag: string, limit = 30): Promise<PolymarketEvent[]> {
  const params = new URLSearchParams({
    endpoint: 'events',
    tag,
    order: 'volume',
    ascending: 'false',
    limit: String(limit),
  });
  const response = await fetch(`/api/polymarket?${params}`);
  if (!response.ok) return [];
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

async function fetchCountryMarketsViaProxy(country: string): Promise<PredictionMarket[]> {
  const tags = COUNTRY_TAG_MAP[country] ?? ['geopolitics', 'world'];
  const uniqueTags = [...new Set(tags)].slice(0, 3);
  const variants = getCountryVariants(country);
  const eventResults = await Promise.all(uniqueTags.map((tag) => fetchCountryEventsByTag(tag, 30)));

  const seen = new Set<string>();
  const markets: PredictionMarket[] = [];

  for (const events of eventResults) {
    for (const event of events) {
      if (event.closed || seen.has(event.id)) continue;
      seen.add(event.id);

      const titleLower = event.title.toLowerCase();
      const eventTitleMatches = variants.some((variant) => titleLower.includes(variant));
      if (!eventTitleMatches) {
        const marketTitles = (event.markets ?? []).map((market) => (market.question ?? '').toLowerCase());
        if (!marketTitles.some((title) => variants.some((variant) => title.includes(variant)))) continue;
      }

      if (event.markets?.length) {
        const candidates = eventTitleMatches
          ? event.markets.filter((market) => !market.closed && !isExpired(market.endDate))
          : event.markets.filter((market) =>
              !market.closed
              && !isExpired(market.endDate)
              && variants.some((variant) => (market.question ?? '').toLowerCase().includes(variant)));
        if (candidates.length === 0) continue;

        const topMarket = candidates.reduce((best, market) => {
          const volume = market.volumeNum ?? (market.volume ? parseFloat(market.volume) : 0);
          const bestVolume = best.volumeNum ?? (best.volume ? parseFloat(best.volume) : 0);
          return volume > bestVolume ? market : best;
        });

        markets.push({
          title: topMarket.question || event.title,
          yesPrice: parseMarketPrice(topMarket),
          volume: event.volume ?? 0,
          url: buildMarketUrl(event.slug),
          endDate: parseEndDate(topMarket.endDate ?? event.endDate),
        });
      } else {
        markets.push({
          title: event.title,
          yesPrice: 50,
          volume: event.volume ?? 0,
          url: buildMarketUrl(event.slug),
          endDate: parseEndDate(event.endDate),
        });
      }
    }
  }

  return markets
    .filter((market) => !isExpired(market.endDate))
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
    .slice(0, 5);
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
  } catch {
    // Fall through to the same-origin proxy path.
  }

  try {
    return await fetchCountryMarketsViaProxy(country);
  } catch {
    return [];
  }
}
