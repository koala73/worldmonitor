import { PredictionServiceClient } from '@/generated/client/worldmonitor/prediction/v1/service_client';
import { createCircuitBreaker } from '@/utils';
import { SITE_VARIANT } from '@/config';
import { isDesktopRuntime } from '@/services/runtime';
import { tryInvokeTauri } from '@/services/tauri-bridge';

// Consumer-friendly type (re-export, matches legacy shape)
export interface PredictionMarket {
  title: string;
  yesPrice: number;     // 0-100 scale (legacy compat)
  volume?: number;
  url?: string;
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

// Internal Gamma API interfaces
interface PolymarketMarket {
  question: string;
  outcomes?: string;
  outcomePrices?: string;
  volume?: string;
  volumeNum?: number;
  closed?: boolean;
  slug?: string;
  endDate?: string;
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
  endDate?: string;
}

// Internal constants and state
const GAMMA_API = 'https://gamma-api.polymarket.com';

// Polymarket proxy URL (Vercel server route injects Railway secret server-side)
const POLYMARKET_PROXY_URL = '/api/polymarket';
const wsRelayUrl = import.meta.env.VITE_WS_RELAY_URL || '';
const DIRECT_RAILWAY_POLY_URL = wsRelayUrl
  ? wsRelayUrl.replace('wss://', 'https://').replace('ws://', 'http://').replace(/\/$/, '') + '/polymarket'
  : '';
const isLocalhostRuntime = typeof window !== 'undefined' && ['localhost', '127.0.0.1'].includes(window.location.hostname);
const PROXY_STRIP_KEYS = new Set(['end_date_min', 'active', 'archived']);

const breaker = createCircuitBreaker<PredictionMarket[]>({ name: 'Polymarket', cacheTtlMs: 10 * 60 * 1000, persistCache: true });

// Sebuf client for strategy 4
const client = new PredictionServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });

// Track whether direct browser->Polymarket fetch works
// Cloudflare blocks server-side TLS but browsers pass JA3 fingerprint checks
let directFetchWorks: boolean | null = null;
let directFetchProbe: Promise<boolean> | null = null;
async function probeDirectFetchCapability(): Promise<boolean> {
  if (directFetchWorks !== null) return directFetchWorks;
  if (!directFetchProbe) {
    directFetchProbe = fetch(`${GAMMA_API}/events?closed=false&active=true&archived=false&order=volume&ascending=false&limit=1`, {
      headers: { 'Accept': 'application/json' },
    })
      .then(resp => {
        directFetchWorks = resp.ok;
        return directFetchWorks;
      })
      .catch(() => {
        directFetchWorks = false;
        return false;
      })
      .finally(() => {
        directFetchProbe = null;
      });
  }
  return directFetchProbe;
}

async function polyFetch(endpoint: 'events' | 'markets', params: Record<string, string>): Promise<Response> {
  const qs = new URLSearchParams(params).toString();

  // Probe direct connectivity once before parallel tag fanout to avoid reset storms.
  const canUseDirect = directFetchWorks === true || (directFetchWorks === null && await probeDirectFetchCapability());
  if (canUseDirect) {
    try {
      const resp = await fetch(`${GAMMA_API}/${endpoint}?${qs}`, {
        headers: { 'Accept': 'application/json' },
      });
      if (resp.ok) {
        directFetchWorks = true;
        return resp;
      }
    } catch {
      directFetchWorks = false;
    }
  }

  // Desktop: use Tauri Rust command (native TLS bypasses Cloudflare JA3 blocking)
  if (isDesktopRuntime()) {
    try {
      const body = await tryInvokeTauri<string>('fetch_polymarket', { path: endpoint, params: qs });
      if (body) {
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    } catch { /* Tauri command failed, fall through to proxy */ }
  }

  const proxyParams: Record<string, string> = { endpoint };
  for (const [k, v] of Object.entries(params)) {
    if (PROXY_STRIP_KEYS.has(k)) continue;
    proxyParams[k === 'tag_slug' ? 'tag' : k] = v;
  }
  const proxyQs = new URLSearchParams(proxyParams).toString();

  // Try Vercel proxy first; it forwards to Railway with server-side auth headers.
  try {
    const resp = await fetch(`${POLYMARKET_PROXY_URL}?${proxyQs}`);
    if (resp.ok) {
      const data = await resp.clone().json();
      if (Array.isArray(data) && data.length > 0) return resp;
    }
  } catch { /* Proxy unavailable */ }

  // Local development fallback: allow direct Railway requests.
  if (isLocalhostRuntime && DIRECT_RAILWAY_POLY_URL) {
    try {
      const resp = await fetch(`${DIRECT_RAILWAY_POLY_URL}?${proxyQs}`);
      if (resp.ok) {
        const data = await resp.clone().json();
        if (Array.isArray(data) && data.length > 0) return resp;
      }
    } catch { /* Railway unavailable */ }
  }

  // Strategy 4: sebuf handler via generated client
  try {
    const resp = await client.listPredictionMarkets({
      category: params.tag_slug ?? '',
      query: '',
      pageSize: parseInt(params.limit ?? '50', 10),
      cursor: '',
    });
    if (resp.markets && resp.markets.length > 0) {
      // Convert proto PredictionMarket[] to Gamma-compatible Response
      // so downstream parsing works uniformly.
      // Proto yesPrice is 0-1; outcomePrices will be parsed by parseMarketPrice
      // which multiplies by 100, resulting in the correct 0-100 scale output.
      const gammaData = resp.markets.map(m => ({
        question: m.title,
        outcomePrices: JSON.stringify([String(m.yesPrice), String(1 - m.yesPrice)]),
        volumeNum: m.volume,
        slug: m.id,
        endDate: m.closesAt ? new Date(m.closesAt).toISOString() : undefined,
      }));
      return new Response(JSON.stringify(endpoint === 'events'
        ? [{ id: 'sebuf', title: gammaData[0]?.question, slug: '', volume: 0, markets: gammaData }]
        : gammaData
      ), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  } catch { /* sebuf handler failed (Cloudflare expected) */ }

  // Final fallback: same-origin proxy
  return fetch(`${POLYMARKET_PROXY_URL}?${proxyQs}`);
}

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
  const response = await polyFetch('events', {
    tag_slug: tag,
    closed: 'false',
    active: 'true',
    archived: 'false',
    end_date_min: new Date().toISOString(),
    order: 'volume',
    ascending: 'false',
    limit: String(limit),
  });
  if (!response.ok) return [];
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

async function fetchTopMarkets(): Promise<PredictionMarket[]> {
  const response = await polyFetch('markets', {
    closed: 'false',
    active: 'true',
    archived: 'false',
    end_date_min: new Date().toISOString(),
    order: 'volume',
    ascending: 'false',
    limit: '100',
  });
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
        endDate: parseEndDate(m.endDate),
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
          const activeCandidates = event.markets.filter(m =>
            !m.closed && !isExpired(m.endDate)
          );
          if (activeCandidates.length === 0) continue;

          const topMarket = activeCandidates.reduce((best, m) => {
            const vol = m.volumeNum ?? (m.volume ? parseFloat(m.volume) : 0);
            const bestVol = best.volumeNum ?? (best.volume ? parseFloat(best.volume) : 0);
            return vol > bestVol ? m : best;
          });

          markets.push({
            title: topMarket.question || event.title,
            yesPrice: parseMarketPrice(topMarket),
            volume: eventVolume,
            url: buildMarketUrl(event.slug),
            endDate: parseEndDate(topMarket.endDate ?? event.endDate),
          });
        } else {
          markets.push({
            title: event.title,
            yesPrice: 50,
            volume: eventVolume,
            url: buildMarketUrl(event.slug),
            endDate: parseEndDate(event.endDate),
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
      .filter(m => !isExpired(m.endDate))
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
        const eventTitleMatches = variants.some(v => titleLower.includes(v));
        if (!eventTitleMatches) {
          const marketTitles = (event.markets ?? []).map(m => (m.question ?? '').toLowerCase());
          if (!marketTitles.some(mt => variants.some(v => mt.includes(v)))) continue;
        }

        if (isExcluded(event.title)) continue;

        if (event.markets && event.markets.length > 0) {
          const candidates = eventTitleMatches
            ? event.markets.filter(m => !m.closed && !isExpired(m.endDate))
            : event.markets.filter(m =>
                !m.closed && !isExpired(m.endDate) &&
                variants.some(v => (m.question ?? '').toLowerCase().includes(v)));
          if (candidates.length === 0) continue;

          const topMarket = candidates.reduce((best, m) => {
            const vol = m.volumeNum ?? (m.volume ? parseFloat(m.volume) : 0);
            const bestVol = best.volumeNum ?? (best.volume ? parseFloat(best.volume) : 0);
            return vol > bestVol ? m : best;
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
      .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
      .slice(0, 5);
  } catch (e) {
    console.error(`[Polymarket] fetchCountryMarkets(${country}) failed:`, e);
    return [];
  }
}
