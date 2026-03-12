/**
 * Unified market service module
 * Fetches stocks/commodities via sidecar (Yahoo Finance or Finnhub),
 * crypto via sidecar (CoinGecko). Falls back to upstream cloud API if sidecar fails.
 */

import {
  MarketServiceClient,
  type ListMarketQuotesResponse,
  type ListCryptoQuotesResponse,
  type MarketQuote as ProtoMarketQuote,
  type CryptoQuote as ProtoCryptoQuote,
} from '@/generated/client/worldmonitor/market/v1/service_client';
import type { MarketData, CryptoData } from '@/types';
import { createCircuitBreaker } from '@/utils';
import { getApiBaseUrl } from '@/services/runtime';

// ---- Upstream cloud client (fallback) ----

const client = new MarketServiceClient('', { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });
const stockBreaker = createCircuitBreaker<ListMarketQuotesResponse>({ name: 'Market Quotes', cacheTtlMs: 0 });
const cryptoBreaker = createCircuitBreaker<ListCryptoQuotesResponse>({ name: 'Crypto Quotes' });

const emptyStockFallback: ListMarketQuotesResponse = { quotes: [], finnhubSkipped: false, skipReason: '', rateLimited: false };
const emptyCryptoFallback: ListCryptoQuotesResponse = { quotes: [] };

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
// Exported types
// ========================================================================

export interface MarketFetchResult {
  data: MarketData[];
  skipped?: boolean;
  reason?: string;
  rateLimited?: boolean;
}

// ========================================================================
// Sidecar helpers
// ========================================================================

interface SidecarQuote { symbol: string; price: number | null; change: number | null; }
interface SidecarCrypto { id: string; price: number | null; change: number | null; }

const CRYPTO_META: Record<string, { name: string; symbol: string }> = {
  bitcoin:  { name: 'Bitcoin',  symbol: 'BTC' },
  ethereum: { name: 'Ethereum', symbol: 'ETH' },
  solana:   { name: 'Solana',   symbol: 'SOL' },
  ripple:   { name: 'XRP',      symbol: 'XRP' },
};

async function fetchMarketQuotesFromSidecar(
  symbols: Array<{ symbol: string; name: string; display: string }>,
): Promise<MarketData[] | null> {
  try {
    const base = getApiBaseUrl();
    const syms = symbols.map(s => s.symbol).join(',');
    const resp = await fetch(`${base}/api/market-quotes?symbols=${encodeURIComponent(syms)}`);
    if (!resp.ok) return null;
    const data = await resp.json() as { quotes?: SidecarQuote[] };
    if (!Array.isArray(data.quotes) || data.quotes.every(q => q.price === null)) return null;
    const metaMap = new Map(symbols.map(s => [s.symbol, s]));
    return data.quotes.map(q => ({
      symbol: q.symbol,
      name: metaMap.get(q.symbol)?.name ?? q.symbol,
      display: metaMap.get(q.symbol)?.display ?? q.symbol,
      price: q.price,
      change: q.change,
    }));
  } catch {
    return null;
  }
}

async function fetchCryptoFromSidecar(): Promise<CryptoData[] | null> {
  try {
    const base = getApiBaseUrl();
    const ids = Object.keys(CRYPTO_META).join(',');
    const resp = await fetch(`${base}/api/crypto-quotes?ids=${encodeURIComponent(ids)}`);
    if (!resp.ok) return null;
    const data = await resp.json() as { quotes?: SidecarCrypto[] };
    if (!Array.isArray(data.quotes) || data.quotes.every(q => q.price === null)) return null;
    return data.quotes
      .map(q => ({
        name: CRYPTO_META[q.id]?.name ?? q.id,
        symbol: CRYPTO_META[q.id]?.symbol ?? q.id.toUpperCase(),
        price: q.price ?? 0,
        change: q.change ?? 0,
      }))
      .filter(c => c.price > 0);
  } catch {
    return null;
  }
}

// ========================================================================
// Stocks -- replaces fetchMultipleStocks + fetchStockQuote
// ========================================================================

const lastSuccessfulByKey = new Map<string, MarketData[]>();

function symbolSetKey(symbols: string[]): string {
  return [...symbols].sort().join(',');
}

export async function fetchMultipleStocks(
  symbols: Array<{ symbol: string; name: string; display: string }>,
  options: { onBatch?: (results: MarketData[]) => void } = {},
): Promise<MarketFetchResult> {
  const setKey = symbolSetKey(symbols.map(s => s.symbol));

  // 1. Try sidecar (Yahoo Finance / Finnhub)
  const sidecarResults = await fetchMarketQuotesFromSidecar(symbols);
  if (sidecarResults && sidecarResults.length > 0) {
    options.onBatch?.(sidecarResults);
    lastSuccessfulByKey.set(setKey, sidecarResults);
    return { data: sidecarResults };
  }

  // 2. Fall back to upstream cloud API
  const resp = await stockBreaker.execute(async () => {
    return client.listMarketQuotes({ symbols: symbols.map(s => s.symbol) });
  }, emptyStockFallback);

  const symbolMetaMap = new Map(symbols.map(s => [s.symbol, s]));
  const results = resp.quotes.map(q => toMarketData(q, symbolMetaMap.get(q.symbol)));

  if (results.length > 0) {
    options.onBatch?.(results);
    lastSuccessfulByKey.set(setKey, results);
  }

  const data = results.length > 0 ? results : (lastSuccessfulByKey.get(setKey) || []);
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
// Crypto -- replaces fetchCrypto
// ========================================================================

let lastSuccessfulCrypto: CryptoData[] = [];

export async function fetchCrypto(): Promise<CryptoData[]> {
  // 1. Try sidecar (CoinGecko)
  const sidecarCrypto = await fetchCryptoFromSidecar();
  if (sidecarCrypto && sidecarCrypto.length > 0) {
    lastSuccessfulCrypto = sidecarCrypto;
    return sidecarCrypto;
  }

  // 2. Fall back to upstream cloud API
  const resp = await cryptoBreaker.execute(async () => {
    return client.listCryptoQuotes({ ids: [] });
  }, emptyCryptoFallback);

  const results = resp.quotes.map(toCryptoData).filter(c => c.price > 0);

  if (results.length > 0) {
    lastSuccessfulCrypto = results;
    return results;
  }

  return lastSuccessfulCrypto;
}
