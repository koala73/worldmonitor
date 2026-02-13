import type { PredictionMarket } from '@/types';
import { createCircuitBreaker } from '@/utils';
import { SITE_VARIANT } from '@/config';

interface PolymarketMarket {
  question: string;
  outcomes?: string;
  outcomePrices?: string;
  volume?: string;
  volumeNum?: number;
  closed?: boolean;
  slug?: string;
}

interface PolymarketEvent {
  id: string;
  title: string;
  slug: string;
  volume?: number;
  liquidity?: number;
  markets?: PolymarketMarket[];
  tags?: Array<{ slug: string }>;
  closed?: boolean;
}

const breaker = createCircuitBreaker<PredictionMarket[]>({ name: 'Polymarket' });

const GEOPOLITICAL_TAGS = [
  'politics', 'geopolitics', 'elections', 'world',
  'ukraine', 'china', 'middle-east', 'europe',
  'economy', 'fed', 'inflation',
];

const TECH_TAGS = [
  'ai', 'tech', 'crypto', 'science',
  'elon-musk', 'business', 'economy',
];

const EXCLUDE_KEYWORDS = [
  'nba', 'nfl', 'mlb', 'nhl', 'fifa', 'world cup', 'super bowl', 'championship',
  'playoffs', 'oscar', 'grammy', 'emmy', 'box office', 'movie', 'album', 'song',
  'streamer', 'influencer', 'celebrity', 'kardashian',
  'bachelor', 'reality tv', 'mvp', 'touchdown', 'home run', 'goal scorer',
  'academy award', 'bafta', 'golden globe', 'cannes', 'sundance',
  'documentary', 'feature film', 'tv series', 'season finale',
];

function isExcluded(title: string): boolean {
  const lower = title.toLowerCase();
  return EXCLUDE_KEYWORDS.some(kw => lower.includes(kw));
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
  } catch { /* keep default */ }
  return 50;
}

function buildMarketUrl(eventSlug?: string, marketSlug?: string): string | undefined {
  if (eventSlug) return `https://polymarket.com/event/${eventSlug}`;
  if (marketSlug) return `https://polymarket.com/market/${marketSlug}`;
  return undefined;
}

async function fetchEventsByTag(tag: string, limit = 30): Promise<PolymarketEvent[]> {
  const response = await fetch(
    `/api/polymarket?endpoint=events&tag=${tag}&closed=false&order=volume&ascending=false&limit=${limit}`
  );
  if (!response.ok) return [];
  return response.json();
}

async function fetchTopMarkets(): Promise<PredictionMarket[]> {
  const response = await fetch('/api/polymarket?closed=false&order=volume&ascending=false&limit=100');
  if (!response.ok) return [];
  const data: PolymarketMarket[] = await response.json();

  return data
    .filter(m => m.question && !isExcluded(m.question))
    .map(m => {
      const yesPrice = parseMarketPrice(m);
      const volume = m.volumeNum ?? (m.volume ? parseFloat(m.volume) : 0);
      return {
        title: m.question,
        yesPrice,
        volume,
        url: buildMarketUrl(undefined, m.slug),
      };
    });
}

export async function fetchPredictions(): Promise<PredictionMarket[]> {
  return breaker.execute(async () => {
    const tags = SITE_VARIANT === 'tech' ? TECH_TAGS : GEOPOLITICAL_TAGS;

    const eventResults = await Promise.all(tags.map(tag => fetchEventsByTag(tag, 20)));

    const seen = new Set<string>();
    const markets: PredictionMarket[] = [];

    for (const events of eventResults) {
      for (const event of events) {
        if (event.closed || seen.has(event.id)) continue;
        seen.add(event.id);

        if (isExcluded(event.title)) continue;

        const eventVolume = event.volume ?? 0;
        if (eventVolume < 1000) continue;

        if (event.markets && event.markets.length > 0) {
          const topMarket = event.markets.reduce((best, m) => {
            const vol = m.volumeNum ?? (m.volume ? parseFloat(m.volume) : 0);
            const bestVol = best.volumeNum ?? (best.volume ? parseFloat(best.volume) : 0);
            return vol > bestVol ? m : best;
          });

          const yesPrice = parseMarketPrice(topMarket);
          markets.push({
            title: topMarket.question || event.title,
            yesPrice,
            volume: eventVolume,
            url: buildMarketUrl(event.slug),
          });
        } else {
          markets.push({
            title: event.title,
            yesPrice: 50,
            volume: eventVolume,
            url: buildMarketUrl(event.slug),
          });
        }
      }
    }

    // Fallback: only fetch top markets if tag queries didn't yield enough
    if (markets.length < 15) {
      const fallbackMarkets = await fetchTopMarkets();
      for (const m of fallbackMarkets) {
        if (markets.length >= 20) break;
        if (!markets.some(existing => existing.title === m.title)) {
          markets.push(m);
        }
      }
    }

    // Sort by volume descending, then filter for meaningful signal
    const result = markets
      .filter(m => {
        const discrepancy = Math.abs(m.yesPrice - 50);
        return discrepancy > 5 || (m.volume && m.volume > 50000);
      })
      .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
      .slice(0, 15);

    // Throw on empty so circuit breaker doesn't cache a failed upstream as "success"
    if (result.length === 0 && markets.length === 0) {
      throw new Error('No markets returned — upstream may be down');
    }

    return result;
  }, []);
}

export function getPolymarketStatus(): string {
  return breaker.getStatus();
}

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

function getCountryVariants(country: string): string[] {
  const lower = country.toLowerCase();
  const variants = [lower];

  const VARIANT_MAP: Record<string, string[]> = {
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
    'brazil': ['brazilian', 'brasilia', 'lula'],
    'syria': ['syrian', 'damascus', 'assad'],
    'yemen': ['yemeni', 'houthi', 'sanaa'],
    'lebanon': ['lebanese', 'beirut', 'hezbollah'],
    'egypt': ['egyptian', 'cairo', 'sisi'],
    'pakistan': ['pakistani', 'islamabad'],
    'sudan': ['sudanese', 'khartoum'],
    'myanmar': ['burmese', 'burma'],
  };

  const extra = VARIANT_MAP[lower];
  if (extra) variants.push(...extra);
  return variants;
}

export async function fetchCountryMarkets(country: string): Promise<PredictionMarket[]> {
  const tags = COUNTRY_TAG_MAP[country] ?? ['geopolitics', 'world'];
  const uniqueTags = [...new Set(tags)].slice(0, 3);
  const variants = getCountryVariants(country);

  try {
    const eventResults = await Promise.all(uniqueTags.map(tag => fetchEventsByTag(tag, 30)));
    const seen = new Set<string>();
    const markets: PredictionMarket[] = [];

    for (const events of eventResults) {
      for (const event of events) {
        if (event.closed || seen.has(event.id)) continue;
        seen.add(event.id);

        const titleLower = event.title.toLowerCase();
        const matches = variants.some(v => titleLower.includes(v));
        if (!matches) {
          const marketTitles = (event.markets ?? []).map(m => (m.question ?? '').toLowerCase());
          if (!marketTitles.some(mt => variants.some(v => mt.includes(v)))) continue;
        }

        if (isExcluded(event.title)) continue;

        if (event.markets && event.markets.length > 0) {
          const topMarket = event.markets.reduce((best, m) => {
            const vol = m.volumeNum ?? (m.volume ? parseFloat(m.volume) : 0);
            const bestVol = best.volumeNum ?? (best.volume ? parseFloat(best.volume) : 0);
            return vol > bestVol ? m : best;
          });
          markets.push({
            title: topMarket.question || event.title,
            yesPrice: parseMarketPrice(topMarket),
            volume: event.volume ?? 0,
            url: buildMarketUrl(event.slug),
          });
        } else {
          markets.push({
            title: event.title,
            yesPrice: 50,
            volume: event.volume ?? 0,
            url: buildMarketUrl(event.slug),
          });
        }
      }
    }

    return markets
      .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
      .slice(0, 5);
  } catch (e) {
    console.error(`[Polymarket] fetchCountryMarkets(${country}) failed:`, e);
    return [];
  }
}
