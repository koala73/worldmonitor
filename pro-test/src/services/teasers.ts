/**
 * Live data teasers for the root welcome landing page.
 *
 * Strategy: render the committed fallback (src/generated/teasers.json)
 * immediately, then upgrade each card in place when its live fetch succeeds.
 * Anonymous access uses the same free `wm-session` HttpOnly cookie the
 * dashboard mints on boot (POST /api/wm-session, ref src/services/wm-session.ts
 * in the main package). A card only earns its LIVE badge when the fetch
 * succeeded AND the response doesn't flag itself degraded/stale/rate-limited.
 *
 * The response interfaces below are hand-copied subsets of the dashboard's
 * generated proto-JSON clients (src/generated/client/worldmonitor/...) —
 * pro-test is an isolated package and must not import them directly.
 */

import fallbackJson from '../generated/teasers.json';

export interface TeaserHeadline {
  title: string;
  source: string;
  publishedAt: number;
}

export interface TeaserCiiScore {
  region: string;
  combinedScore: number;
  trend: string;
}

export interface TeaserChokepoint {
  name: string;
  status: string;
  disruptionScore: number;
}

export interface TeaserQuote {
  symbol: string;
  display: string;
  price: number;
  change: number;
  sparkline: number[];
}

export interface TeaserState {
  headlines: { items: TeaserHeadline[]; live: boolean };
  cii: { items: TeaserCiiScore[]; live: boolean };
  chokepoints: { items: TeaserChokepoint[]; total: number; disrupted: number; live: boolean };
  quotes: { items: TeaserQuote[]; live: boolean };
}

const FETCH_TIMEOUT_MS = 5000;

interface FallbackShape {
  headlines: TeaserHeadline[];
  cii: TeaserCiiScore[];
  chokepoints: TeaserChokepoint[];
  chokepointTotal: number;
  quotes: TeaserQuote[];
}

const fallback = fallbackJson as unknown as FallbackShape;

const isDisrupted = (c: { status: string }) => c.status !== 'green';

export function getFallbackTeasers(): TeaserState {
  return {
    headlines: { items: fallback.headlines, live: false },
    cii: { items: fallback.cii, live: false },
    chokepoints: {
      items: fallback.chokepoints,
      total: fallback.chokepointTotal,
      disrupted: fallback.chokepoints.filter(isDisrupted).length,
      live: false,
    },
    quotes: { items: fallback.quotes, live: false },
  };
}

let sessionMinted = false;

async function mintSession(): Promise<void> {
  try {
    const resp = await fetch('/api/wm-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // fetch() resolves on 4xx/5xx too (e.g. CORS-blocked preview domains) —
    // only an OK response means the cookie actually exists, otherwise the
    // 401-retry path in fetchJson would re-mint and re-fire every request.
    if (resp.ok) sessionMinted = true;
  } catch { /* fall back to static teasers */ }
}

async function fetchJson<T>(path: string): Promise<T | null> {
  const doFetch = () => fetch(path, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  try {
    let resp = await doFetch();
    if (resp.status === 401 && sessionMinted) {
      // Cookie may have expired between mint and call — re-mint once.
      sessionMinted = false;
      await mintSession();
      if (!sessionMinted) return null;
      resp = await doFetch();
    }
    if (!resp.ok) return null;
    return await resp.json() as T;
  } catch {
    return null;
  }
}

interface RiskScoresResponse {
  ciiScores?: Array<{ region?: string; combinedScore?: number; trend?: string }>;
  degraded?: boolean;
  stale?: boolean;
}

async function fetchCii(): Promise<{ items: TeaserCiiScore[]; live: boolean } | null> {
  const resp = await fetchJson<RiskScoresResponse>('/api/intelligence/v1/get-risk-scores?region=');
  if (!resp || !Array.isArray(resp.ciiScores)) return null;
  const items = resp.ciiScores
    .filter(s => typeof s.region === 'string' && typeof s.combinedScore === 'number')
    .sort((a, b) => (b.combinedScore ?? 0) - (a.combinedScore ?? 0))
    .slice(0, 5)
    .map(s => ({ region: s.region as string, combinedScore: s.combinedScore as number, trend: s.trend ?? '' }));
  if (!items.length) return null;
  return { items, live: !resp.degraded && !resp.stale };
}

interface ChokepointStatusResponse {
  chokepoints?: Array<{ name?: string; status?: string; disruptionScore?: number }>;
  upstreamUnavailable?: boolean;
}

async function fetchChokepoints(): Promise<{ items: TeaserChokepoint[]; total: number; disrupted: number; live: boolean } | null> {
  const resp = await fetchJson<ChokepointStatusResponse>('/api/supply-chain/v1/get-chokepoint-status');
  if (!resp || !Array.isArray(resp.chokepoints)) return null;
  const all = resp.chokepoints
    .filter(c => typeof c.name === 'string' && typeof c.status === 'string')
    .map(c => ({ name: c.name as string, status: c.status as string, disruptionScore: c.disruptionScore ?? 0 }));
  if (!all.length) return null;
  const items = [...all].sort((a, b) => b.disruptionScore - a.disruptionScore).slice(0, 5);
  // "N of M disrupted" must count across ALL chokepoints, not the top-5 slice.
  return { items, total: all.length, disrupted: all.filter(isDisrupted).length, live: !resp.upstreamUnavailable };
}

interface MarketQuotesResponse {
  quotes?: Array<{ symbol?: string; display?: string; price?: number; change?: number; sparkline?: number[] }>;
  rateLimited?: boolean;
}

interface CommodityQuotesResponse {
  quotes?: Array<{ symbol?: string; display?: string; price?: number; change?: number; sparkline?: number[] }>;
}

interface CryptoQuotesResponse {
  quotes?: Array<{ symbol?: string; name?: string; price?: number; change?: number; sparkline?: number[] }>;
}

const MARKET_QUOTE_SYMBOLS = ['^GSPC', '^IXIC', '^VIX'];
const COMMODITY_QUOTE_SYMBOLS = ['CL=F', 'BZ=F', 'GC=F', 'HG=F', 'NG=F', 'EURUSD=X', 'USDJPY=X'];
const CRYPTO_QUOTE_IDS = ['bitcoin', 'ethereum'];
const QUOTE_SYMBOLS = ['^GSPC', '^IXIC', '^VIX', 'BTC', 'ETH', 'CL=F', 'BZ=F', 'GC=F', 'HG=F', 'NG=F', 'EURUSD=X', 'USDJPY=X'];

const QUOTE_LABELS: Record<string, string> = {
  '^GSPC': 'S&P 500',
  '^IXIC': 'Nasdaq',
  '^VIX': 'VIX',
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  'CL=F': 'WTI crude',
  'BZ=F': 'Brent',
  'GC=F': 'Gold',
  'HG=F': 'Copper',
  'NG=F': 'Nat gas',
  'EURUSD=X': 'EUR/USD',
  'USDJPY=X': 'USD/JPY',
};

function normalizeQuote(q: { symbol?: string; display?: string; name?: string; price?: number; change?: number; sparkline?: number[] }): TeaserQuote | null {
  if (typeof q.symbol !== 'string' || typeof q.price !== 'number' || q.price <= 0) return null;
  return {
    symbol: q.symbol,
    display: QUOTE_LABELS[q.symbol] ?? q.display ?? q.name ?? q.symbol,
    price: q.price,
    change: q.change ?? 0,
    sparkline: Array.isArray(q.sparkline) ? q.sparkline : [],
  };
}

function orderAndBackfillQuotes(liveItems: TeaserQuote[]): TeaserQuote[] {
  const bySymbol = new Map<string, TeaserQuote>();
  for (const q of fallback.quotes) bySymbol.set(q.symbol, q);
  for (const q of liveItems) bySymbol.set(q.symbol, q);
  return QUOTE_SYMBOLS
    .map(symbol => bySymbol.get(symbol))
    .filter((q): q is TeaserQuote => Boolean(q));
}

function hasCompleteLiveQuoteSet(liveItems: TeaserQuote[]): boolean {
  const liveSymbols = new Set(liveItems.map(q => q.symbol));
  return QUOTE_SYMBOLS.every(symbol => liveSymbols.has(symbol));
}

async function fetchQuotes(): Promise<{ items: TeaserQuote[]; live: boolean } | null> {
  const marketQs = MARKET_QUOTE_SYMBOLS.map(s => `symbols=${encodeURIComponent(s)}`).join('&');
  const commodityQs = COMMODITY_QUOTE_SYMBOLS.map(s => `symbols=${encodeURIComponent(s)}`).join('&');
  const cryptoQs = CRYPTO_QUOTE_IDS.map(id => `ids=${encodeURIComponent(id)}`).join('&');
  const [market, commodities, crypto] = await Promise.all([
    fetchJson<MarketQuotesResponse>(`/api/market/v1/list-market-quotes?${marketQs}`),
    fetchJson<CommodityQuotesResponse>(`/api/market/v1/list-commodity-quotes?${commodityQs}`),
    fetchJson<CryptoQuotesResponse>(`/api/market/v1/list-crypto-quotes?${cryptoQs}`),
  ]);
  const liveItems = [
    ...(market?.quotes ?? []),
    ...(commodities?.quotes ?? []),
    ...(crypto?.quotes ?? []),
  ].map(normalizeQuote).filter((q): q is TeaserQuote => Boolean(q));
  const items = orderAndBackfillQuotes(liveItems);
  if (!items.length) return null;
  const live =
    market !== null &&
    commodities !== null &&
    crypto !== null &&
    !market.rateLimited &&
    hasCompleteLiveQuoteSet(liveItems);
  return { items, live };
}

interface FeedDigestResponse {
  categories?: Record<string, { items?: Array<{ title?: string; source?: string; publishedAt?: number; importanceScore?: number }> }>;
  generatedAt?: string;
}

const DIGEST_FRESH_MS = 30 * 60 * 1000;

async function fetchHeadlines(): Promise<{ items: TeaserHeadline[]; live: boolean } | null> {
  const resp = await fetchJson<FeedDigestResponse>('/api/news/v1/list-feed-digest?variant=full&lang=en');
  if (!resp || !resp.categories) return null;
  const all = Object.values(resp.categories)
    .flatMap(c => c?.items ?? [])
    .filter(i => typeof i.title === 'string' && i.title.length > 0);
  if (!all.length) return null;
  const items = all
    .sort((a, b) => (b.importanceScore ?? 0) - (a.importanceScore ?? 0))
    .slice(0, 4)
    .map(i => ({ title: i.title as string, source: i.source ?? '', publishedAt: i.publishedAt ?? 0 }));
  // The digest response carries no degraded/stale booleans — its freshness
  // signal is generatedAt. Only claim LIVE when the digest is recent; an
  // unparseable/missing timestamp keeps the badge (matches the other
  // fetchers, which only demote on explicit signals).
  const generated = resp.generatedAt ? Date.parse(resp.generatedAt) : Number.NaN;
  const live = Number.isNaN(generated) || Date.now() - generated < DIGEST_FRESH_MS;
  return { items, live };
}

/**
 * Fetch all four teasers, merging successes over the committed fallback.
 * Never throws; cards whose fetch failed keep their fallback values with
 * live=false so the UI shows SAMPLE instead of LIVE.
 */
export async function fetchLiveTeasers(): Promise<TeaserState> {
  const state = getFallbackTeasers();
  await mintSession();
  const [headlines, cii, chokepoints, quotes] = await Promise.all([
    fetchHeadlines(),
    fetchCii(),
    fetchChokepoints(),
    fetchQuotes(),
  ]);
  if (headlines) state.headlines = headlines;
  if (cii) state.cii = cii;
  if (chokepoints) state.chokepoints = chokepoints;
  if (quotes) state.quotes = quotes;
  return state;
}
