/**
 * Unified market service module -- replaces legacy service:
 *   - src/services/markets.ts (Finnhub + Yahoo + CoinGecko)
 *
 * All data now flows through the MarketServiceClient RPCs.
 */

import { getRpcBaseUrl } from '@/services/rpc-client';
import {
  MarketServiceClient,
  type ListMarketQuotesResponse,
  type ListCommodityQuotesResponse,
  type GetSectorSummaryResponse,
  type ListCryptoQuotesResponse,
  type ListCryptoSectorsResponse,
  type CryptoSector,
  type ListDefiTokensResponse,
  type ListAiTokensResponse,
  type ListOtherTokensResponse,
  type MarketQuote as ProtoMarketQuote,
  type CryptoQuote as ProtoCryptoQuote,
} from '@/generated/client/worldmonitor/market/v1/service_client';
import type { MarketData, CryptoData, TokenData } from '@/types';
import { createCircuitBreaker } from '@/utils/circuit-breaker';
import { getHydratedData } from '@/services/bootstrap';

// ---- Client + Circuit Breakers ----

const client = new MarketServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });
const MARKET_QUOTES_CACHE_TTL_MS = 5 * 60 * 1000;
const stockBreaker = createCircuitBreaker<ListMarketQuotesResponse>({ name: 'Market Quotes', cacheTtlMs: MARKET_QUOTES_CACHE_TTL_MS, persistCache: true });
const commodityBreaker = createCircuitBreaker<ListCommodityQuotesResponse>({ name: 'Commodity Quotes', cacheTtlMs: MARKET_QUOTES_CACHE_TTL_MS, persistCache: true });
const sectorBreaker = createCircuitBreaker<GetSectorSummaryResponse>({ name: 'Sector Summary v2', cacheTtlMs: MARKET_QUOTES_CACHE_TTL_MS, persistCache: true });
const cryptoBreaker = createCircuitBreaker<ListCryptoQuotesResponse>({ name: 'Crypto Quotes', persistCache: true });
const cryptoSectorsBreaker = createCircuitBreaker<ListCryptoSectorsResponse>({ name: 'Crypto Sectors', persistCache: true });
const defiBreaker = createCircuitBreaker<ListDefiTokensResponse>({ name: 'DeFi Tokens', persistCache: true });
const aiBreaker = createCircuitBreaker<ListAiTokensResponse>({ name: 'AI Tokens', persistCache: true });
const otherBreaker = createCircuitBreaker<ListOtherTokensResponse>({ name: 'Other Tokens', persistCache: true });

const emptyStockFallback: ListMarketQuotesResponse = { quotes: [], finnhubSkipped: false, skipReason: '', rateLimited: false };
const emptyCommodityFallback: ListCommodityQuotesResponse = { quotes: [] };
const emptySectorFallback: GetSectorSummaryResponse = { sectors: [] };
const emptyCryptoFallback: ListCryptoQuotesResponse = { quotes: [] };
const emptyCryptoSectorsFallback: ListCryptoSectorsResponse = { sectors: [] };
const emptyDefiTokensFallback: ListDefiTokensResponse = { tokens: [] };
const emptyAiTokensFallback: ListAiTokensResponse = { tokens: [] };
const emptyOtherTokensFallback: ListOtherTokensResponse = { tokens: [] };

const LOCAL_STOCK_FALLBACK_QUOTES: ProtoMarketQuote[] = [
  { symbol: '^GSPC', name: 'S&P 500', display: 'S&P 500', price: 5294.2, change: 0.6, sparkline: [5248, 5256, 5263, 5278, 5286, 5290, 5294.2] },
  { symbol: '^IXIC', name: 'Nasdaq Composite', display: 'NASDAQ', price: 17142.8, change: 0.8, sparkline: [16930, 16988, 17032, 17076, 17100, 17121, 17142.8] },
  { symbol: '^DJI', name: 'Dow Jones', display: 'DOW', price: 38862.4, change: 0.2, sparkline: [38740, 38785, 38801, 38822, 38810, 38841, 38862.4] },
  { symbol: '^VIX', name: 'VIX', display: 'VIX', price: 13.9, change: -1.4, sparkline: [14.8, 14.6, 14.4, 14.2, 14.1, 14.0, 13.9] },
  { symbol: 'AAPL', name: 'Apple', display: 'AAPL', price: 202.4, change: 0.7, sparkline: [199.2, 199.8, 200.7, 201.3, 201.6, 202.0, 202.4] },
  { symbol: 'MSFT', name: 'Microsoft', display: 'MSFT', price: 428.7, change: 0.5, sparkline: [423.3, 424.9, 425.6, 426.4, 427.0, 427.8, 428.7] },
  { symbol: 'NVDA', name: 'NVIDIA', display: 'NVDA', price: 118.5, change: 1.6, sparkline: [114.2, 115.0, 115.8, 116.7, 117.1, 117.8, 118.5] },
  { symbol: 'AMZN', name: 'Amazon', display: 'AMZN', price: 183.6, change: 0.4, sparkline: [181.2, 181.9, 182.2, 182.9, 183.1, 183.4, 183.6] },
  { symbol: 'META', name: 'Meta', display: 'META', price: 498.2, change: 0.9, sparkline: [491.0, 492.8, 494.1, 495.9, 496.8, 497.4, 498.2] },
];

const LOCAL_COMMODITY_FALLBACK_QUOTES = [
  { symbol: 'GC=F', name: 'Gold', display: 'GOLD', price: 2364.2, change: 0.4, sparkline: [2338, 2344, 2348, 2353, 2356, 2360, 2364.2] },
  { symbol: 'SI=F', name: 'Silver', display: 'SILVER', price: 30.6, change: 0.5, sparkline: [29.9, 30.1, 30.0, 30.2, 30.3, 30.4, 30.6] },
  { symbol: 'HG=F', name: 'Copper', display: 'COPPER', price: 4.72, change: 0.3, sparkline: [4.61, 4.64, 4.66, 4.67, 4.69, 4.70, 4.72] },
  { symbol: 'CL=F', name: 'Crude Oil', display: 'WTI', price: 78.4, change: 0.8, sparkline: [76.8, 77.0, 77.2, 77.6, 77.8, 78.1, 78.4] },
  { symbol: 'BZ=F', name: 'Brent', display: 'BRENT', price: 82.1, change: 0.7, sparkline: [80.4, 80.8, 81.0, 81.2, 81.5, 81.8, 82.1] },
  { symbol: 'NG=F', name: 'Nat Gas', display: 'NATGAS', price: 2.78, change: -0.2, sparkline: [2.84, 2.83, 2.82, 2.80, 2.79, 2.79, 2.78] },
];

const LOCAL_CRYPTO_FALLBACK_QUOTES: ProtoCryptoQuote[] = [
  { name: 'Bitcoin', symbol: 'BTC', price: 68420, change: 1.3, sparkline: [66780, 67120, 67400, 67680, 67950, 68100, 68420], change7d: 4.1 },
  { name: 'Ethereum', symbol: 'ETH', price: 3725, change: 1.0, sparkline: [3620, 3645, 3662, 3684, 3691, 3705, 3725], change7d: 3.4 },
  { name: 'Solana', symbol: 'SOL', price: 167.8, change: 2.2, sparkline: [159.1, 160.4, 161.8, 163.2, 164.5, 166.1, 167.8], change7d: 6.9 },
  { name: 'XRP', symbol: 'XRP', price: 0.61, change: 0.6, sparkline: [0.59, 0.595, 0.598, 0.602, 0.605, 0.608, 0.61], change7d: 2.1 },
  { name: 'BNB', symbol: 'BNB', price: 612.4, change: 0.7, sparkline: [601.4, 603.2, 605.6, 607.4, 609.2, 610.8, 612.4], change7d: 3.0 },
];

const LOCAL_SECTOR_FALLBACK = {
  sectors: [
    { symbol: 'XLK', name: 'Technology', change: 1.1 },
    { symbol: 'XLF', name: 'Financials', change: 0.4 },
    { symbol: 'XLE', name: 'Energy', change: 0.9 },
    { symbol: 'XLV', name: 'Health Care', change: 0.2 },
    { symbol: 'XLI', name: 'Industrials', change: 0.3 },
    { symbol: 'XLY', name: 'Consumer Discretionary', change: 0.5 },
    { symbol: 'XLP', name: 'Consumer Staples', change: -0.1 },
    { symbol: 'XLB', name: 'Materials', change: 0.2 },
    { symbol: 'XLU', name: 'Utilities', change: -0.2 },
  ],
} satisfies GetSectorSummaryResponse;

function getLocalStockFallback(
  requested: Array<{ symbol: string; name: string; display: string }>,
): MarketData[] {
  const fallbackBySymbol = new Map(LOCAL_STOCK_FALLBACK_QUOTES.map((quote) => [quote.symbol, quote]));
  return requested
    .map((entry) => {
      const quote = fallbackBySymbol.get(entry.symbol.trim());
      return quote ? toMarketData(quote, entry) : null;
    })
    .filter((entry): entry is MarketData => entry !== null);
}

function getLocalCommodityFallback(symbols: string[]): MarketData[] {
  const symbolSet = new Set(symbols);
  return LOCAL_COMMODITY_FALLBACK_QUOTES
    .filter((quote) => symbolSet.has(quote.symbol))
    .map((quote) => ({
      symbol: quote.symbol,
      name: quote.name,
      display: quote.display,
      price: quote.price,
      change: quote.change,
      sparkline: quote.sparkline,
    }));
}

// ---- Proto -> legacy adapters ----

function toMarketData(proto: ProtoMarketQuote, meta?: { name?: string; display?: string }): MarketData {
  return {
    symbol: proto.symbol,
    name: meta?.name || proto.name,
    display: meta?.display || proto.display || proto.symbol,
    price: proto.price != null ? proto.price : null,
    change: proto.change ?? null,
    sparkline: proto.sparkline.length > 0 ? proto.sparkline : undefined,
  };
}

function toCryptoData(proto: ProtoCryptoQuote): CryptoData {
  return {
    name: proto.name,
    symbol: proto.symbol,
    price: proto.price,
    change: proto.change,
    sparkline: proto.sparkline.length > 0 ? proto.sparkline : undefined,
  };
}

// ========================================================================
// Exported types (preserving legacy interface)
// ========================================================================

export interface MarketFetchResult {
  data: MarketData[];
  skipped?: boolean;
  reason?: string;
  rateLimited?: boolean;
}

// ========================================================================
// Stocks -- replaces fetchMultipleStocks + fetchStockQuote
// ========================================================================

const lastSuccessfulByKey = new Map<string, MarketData[]>();

function symbolSetKey(symbols: string[]): string {
  return [...new Set(symbols.map((symbol) => symbol.trim()))].sort().join(',');
}

export async function fetchMultipleStocks(
  symbols: Array<{ symbol: string; name: string; display: string }>,
  options: { onBatch?: (results: MarketData[]) => void } = {},
): Promise<MarketFetchResult> {
  // Preserve exact requested symbols for cache keys and request payloads so
  // case-distinct instruments do not collapse into one cache entry.
  const symbolMetaMap = new Map<string, { symbol: string; name: string; display: string }>();
  // Case-insensitive fallback: maps UPPER(symbol) → first requested candidate.
  // "First wins" is intentional — assumes case-variants are the same instrument
  // (e.g. btc-usd / BTC-USD both refer to the same asset). When the backend
  // normalizes casing (e.g. returns "Btc-Usd"), we still recover metadata
  // rather than silently dropping it as the old null-sentinel approach did.
  const uppercaseMetaMap = new Map<string, { symbol: string; name: string; display: string }>();
  for (const s of symbols) {
    const trimmed = s.symbol.trim();
    if (!symbolMetaMap.has(trimmed)) symbolMetaMap.set(trimmed, s);

    const upper = trimmed.toUpperCase();
    if (!uppercaseMetaMap.has(upper)) {
      uppercaseMetaMap.set(upper, s);
    }
  }
  const allSymbolStrings = [...symbolMetaMap.keys()];
  const setKey = symbolSetKey(allSymbolStrings);

  const resp = await stockBreaker.execute(async () => {
    return client.listMarketQuotes({ symbols: allSymbolStrings });
  }, emptyStockFallback, {
    cacheKey: setKey,
    shouldCache: (r) => r.quotes.length > 0,
  });

  const results = resp.quotes.map((q) => {
    const trimmed = q.symbol.trim();
    const meta = symbolMetaMap.get(trimmed) ?? uppercaseMetaMap.get(trimmed.toUpperCase()) ?? undefined;
    return toMarketData(q, meta);
  });

  // Fire onBatch with whatever we got
  if (results.length > 0) {
    options.onBatch?.(results);
  }

  if (results.length > 0) {
    lastSuccessfulByKey.set(setKey, results);
  }

  const localFallback = getLocalStockFallback(symbols);
  const data = results.length > 0
    ? results
    : (lastSuccessfulByKey.get(setKey) || localFallback);
  return {
    data,
    skipped: resp.finnhubSkipped || undefined,
    reason: resp.skipReason || undefined,
    rateLimited: resp.rateLimited || undefined,
  };
}

export async function fetchStockQuote(
  symbol: string,
  name: string,
  display: string,
): Promise<MarketData> {
  const result = await fetchMultipleStocks([{ symbol, name, display }]);
  return result.data[0] || { symbol, name, display, price: null, change: null };
}

// ========================================================================
// Commodities -- uses listCommodityQuotes (reads market:commodities-bootstrap:v1)
// ========================================================================

/** Pre-warm the commodity circuit-breaker cache from bootstrap hydration data.
 *  Called from data-loader when bootstrap quotes are consumed so the SWR path
 *  has stale data to serve if the first live RPC call fails. */
export function warmCommodityCache(quotes: ListCommodityQuotesResponse): void {
  const symbols = quotes.quotes.map((q) => q.symbol);
  const cacheKey = [...symbols].sort().join(',');
  commodityBreaker.recordSuccess(quotes, cacheKey);
}

/**
 * Pre-warm the sector circuit-breaker cache from bootstrap hydration data.
 * Valuations are included in the sector summary payload; clients pick them up
 * on the next breaker refresh (5-min TTL) without a separate cache-bust.
 */
export function warmSectorCache(resp: GetSectorSummaryResponse): void {
  sectorBreaker.recordSuccess(resp);
}

export async function fetchCommodityQuotes(
  commodities: Array<{ symbol: string; name: string; display: string }>,
  options: { onBatch?: (results: MarketData[]) => void } = {},
): Promise<MarketFetchResult> {
  const symbols = commodities.map((c) => c.symbol);
  const meta = new Map(commodities.map((c) => [c.symbol, c]));
  const cacheKey = [...symbols].sort().join(',');

  const resp = await commodityBreaker.execute(async () => {
    return client.listCommodityQuotes({ symbols });
  }, emptyCommodityFallback, {
    cacheKey,
    shouldCache: (r: ListCommodityQuotesResponse) => r.quotes.length > 0,
  });

  const results: MarketData[] = resp.quotes.map((q) => {
    const m = meta.get(q.symbol);
    return {
      symbol: q.symbol,
      name: m?.name ?? q.name,
      display: m?.display ?? q.display ?? q.symbol,
      price: q.price,
      change: q.change,
      sparkline: q.sparkline?.length > 0 ? q.sparkline : undefined,
    };
  });

  if (results.length > 0) options.onBatch?.(results);
  return { data: results.length > 0 ? results : getLocalCommodityFallback(symbols) };
}

// ========================================================================
// Sectors -- uses getSectorSummary (reads market:sectors:v2)
// ========================================================================

export async function fetchSectors(): Promise<GetSectorSummaryResponse> {
  const result = await sectorBreaker.execute(async () => {
    return client.getSectorSummary({ period: '' });
  }, emptySectorFallback, {
    // Require sectors AND the valuations field to be present (not missing) so
    // pre-PR payloads that lack the valuations key are never cached/replayed
    // as stale data for the session. Empty object {} is OK (API may legitimately
    // return zero valuations after Yahoo failures) but the key must exist.
    shouldCache: (r: GetSectorSummaryResponse) => {
      if (r.sectors.length === 0) return false;
      const withValuations = r as GetSectorSummaryResponse & { valuations?: unknown };
      return Object.prototype.hasOwnProperty.call(withValuations, 'valuations');
    },
  });
  return result.sectors.length > 0 ? result : LOCAL_SECTOR_FALLBACK;
}

// ========================================================================
// Crypto -- replaces fetchCrypto
// ========================================================================

let lastSuccessfulCrypto: CryptoData[] = [];

export async function fetchCrypto(): Promise<CryptoData[]> {
  const hydrated = getHydratedData('cryptoQuotes') as ListCryptoQuotesResponse | undefined;
  if (hydrated?.quotes?.length) {
    const mapped = hydrated.quotes.map(toCryptoData).filter(c => c.price > 0);
    if (mapped.length > 0) { lastSuccessfulCrypto = mapped; return mapped; }
  }

  const resp = await cryptoBreaker.execute(async () => {
    return client.listCryptoQuotes({ ids: [] }); // empty = all defaults
  }, emptyCryptoFallback);

  const results = resp.quotes
    .map(toCryptoData)
    .filter(c => c.price > 0);

  if (results.length > 0) {
    lastSuccessfulCrypto = results;
    return results;
  }

  return lastSuccessfulCrypto.length > 0 ? lastSuccessfulCrypto : LOCAL_CRYPTO_FALLBACK_QUOTES.map(toCryptoData);
}

// ========================================================================
// Crypto Sectors
// ========================================================================

let lastSuccessfulSectors: CryptoSector[] = [];

export async function fetchCryptoSectors(): Promise<CryptoSector[]> {
  const hydrated = getHydratedData('cryptoSectors') as ListCryptoSectorsResponse | undefined;
  if (hydrated?.sectors?.length) {
    lastSuccessfulSectors = hydrated.sectors;
    return hydrated.sectors;
  }

  const resp = await cryptoSectorsBreaker.execute(async () => {
    return client.listCryptoSectors({});
  }, emptyCryptoSectorsFallback);

  if (resp.sectors.length > 0) {
    lastSuccessfulSectors = resp.sectors;
    return resp.sectors;
  }
  return lastSuccessfulSectors;
}

// ========================================================================
// Token Panels (DeFi, AI, Other)
// ========================================================================

function toTokenData(q: ProtoCryptoQuote): TokenData {
  // Bootstrap hydration delivers the raw seed shape ({change24h}) while the RPC
  // handler normalises to the proto field name ({change}).  Handle both.
  const raw = q as unknown as { change?: number; change24h?: number };
  return {
    name: q.name,
    symbol: q.symbol,
    price: q.price ?? 0,
    change24h: (raw.change ?? raw.change24h) ?? 0,
    change7d: q.change7d ?? 0,
  };
}

let lastSuccessfulDefi: TokenData[] = [];
let lastSuccessfulAi: TokenData[] = [];
let lastSuccessfulOther: TokenData[] = [];

export async function fetchDefiTokens(): Promise<TokenData[]> {
  const hydrated = getHydratedData('defiTokens') as ListDefiTokensResponse | undefined;
  if (hydrated?.tokens?.length) {
    const mapped = hydrated.tokens.map(toTokenData).filter(t => t.price > 0);
    if (mapped.length > 0) { lastSuccessfulDefi = mapped; return mapped; }
  }

  const resp = await defiBreaker.execute(async () => {
    return client.listDefiTokens({});
  }, emptyDefiTokensFallback);

  const results = resp.tokens.map(toTokenData).filter(t => t.price > 0);
  if (results.length > 0) { lastSuccessfulDefi = results; return results; }
  return lastSuccessfulDefi;
}

export async function fetchAiTokens(): Promise<TokenData[]> {
  const hydrated = getHydratedData('aiTokens') as ListAiTokensResponse | undefined;
  if (hydrated?.tokens?.length) {
    const mapped = hydrated.tokens.map(toTokenData).filter(t => t.price > 0);
    if (mapped.length > 0) { lastSuccessfulAi = mapped; return mapped; }
  }

  const resp = await aiBreaker.execute(async () => {
    return client.listAiTokens({});
  }, emptyAiTokensFallback);

  const results = resp.tokens.map(toTokenData).filter(t => t.price > 0);
  if (results.length > 0) { lastSuccessfulAi = results; return results; }
  return lastSuccessfulAi;
}

export async function fetchOtherTokens(): Promise<TokenData[]> {
  const hydrated = getHydratedData('otherTokens') as ListOtherTokensResponse | undefined;
  if (hydrated?.tokens?.length) {
    const mapped = hydrated.tokens.map(toTokenData).filter(t => t.price > 0);
    if (mapped.length > 0) { lastSuccessfulOther = mapped; return mapped; }
  }

  const resp = await otherBreaker.execute(async () => {
    return client.listOtherTokens({});
  }, emptyOtherTokensFallback);

  const results = resp.tokens.map(toTokenData).filter(t => t.price > 0);
  if (results.length > 0) { lastSuccessfulOther = results; return results; }
  return lastSuccessfulOther;
}
