/**
 * Shared helpers, types, and constants for the market service handler RPCs.
 */

declare const process: { env: Record<string, string | undefined> };

import { CHROME_UA, yahooGate } from '../../../_shared/constants';

// ========================================================================
// Constants
// ========================================================================

export const UPSTREAM_TIMEOUT_MS = 10_000;

export async function fetchYahooQuotesBatch(
  symbols: string[],
  fmpApiKey?: string,
): Promise<{ results: Map<string, { price: number; change: number; sparkline: number[] }>; rateLimited: boolean }> {
  const results = new Map<string, { price: number; change: number; sparkline: number[] }>();
  let rateLimitHits = 0;
  for (let i = 0; i < symbols.length; i++) {
    const q = await fetchYahooQuote(symbols[i]!, fmpApiKey);
    if (q) {
      results.set(symbols[i]!, q);
    } else {
      rateLimitHits++;
    }
    if (rateLimitHits >= 3 && results.size === 0) break;
  }
  return { results, rateLimited: rateLimitHits >= 3 && results.size === 0 };
}

// Yahoo-only symbols: indices and futures not on Finnhub free tier
export const YAHOO_ONLY_SYMBOLS = new Set([
  '^GSPC', '^DJI', '^IXIC', '^VIX',
  'GC=F', 'CL=F', 'NG=F', 'SI=F', 'HG=F',
]);

// Yahoo symbol → FMP symbol mapping (where format differs)
const FMP_SYMBOL_MAP: Record<string, string> = {
  'GC=F': 'GCUSD',
  'CL=F': 'CLUSD',
  'NG=F': 'NGUSD',
  'SI=F': 'SIUSD',
  'HG=F': 'HGUSD',
};

// Known crypto IDs and their metadata
export const CRYPTO_META: Record<string, { name: string; symbol: string }> = {
  bitcoin: { name: 'Bitcoin', symbol: 'BTC' },
  ethereum: { name: 'Ethereum', symbol: 'ETH' },
  solana: { name: 'Solana', symbol: 'SOL' },
  ripple: { name: 'XRP', symbol: 'XRP' },
};

// ========================================================================
// Types
// ========================================================================

export interface YahooChartResponse {
  chart: {
    result: Array<{
      meta: {
        regularMarketPrice: number;
        chartPreviousClose?: number;
        previousClose?: number;
      };
      indicators?: {
        quote?: Array<{ close?: (number | null)[] }>;
      };
    }>;
  };
}

export interface CoinGeckoMarketItem {
  id: string;
  current_price: number;
  price_change_percentage_24h: number;
  sparkline_in_7d?: { price: number[] };
}

// ========================================================================
// Finnhub quote fetcher
// ========================================================================

export async function fetchFinnhubQuote(
  symbol: string,
  apiKey: string,
): Promise<{ symbol: string; price: number; changePercent: number } | null> {
  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`;
    const resp = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!resp.ok) return null;

    const data = await resp.json() as { c: number; d: number; dp: number; h: number; l: number; o: number; pc: number; t: number };
    if (data.c === 0 && data.h === 0 && data.l === 0) return null;

    return { symbol, price: data.c, changePercent: data.dp };
  } catch {
    return null;
  }
}

// ========================================================================
// Yahoo Finance quote fetcher
// ========================================================================
// ========================================================================
// Financial Modeling Prep (FMP) fallback fetcher
// Docs: https://site.financialmodelingprep.com/developer/docs
// Activated when FMP_API_KEY is set and Yahoo returns 429/403 or fails.
// ========================================================================

export async function fetchFMPQuote(
  yahooSymbol: string,
  apiKey: string,
): Promise<{ price: number; change: number; sparkline: number[] } | null> {
  try {
    const fmpSymbol = FMP_SYMBOL_MAP[yahooSymbol] ?? yahooSymbol;
    const url = `https://financialmodelingprep.com/stable/quote?symbol=${encodeURIComponent(fmpSymbol)}&apikey=${apiKey}`;
    const resp = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!resp.ok) return null;

    const data = await resp.json() as Array<{ price: number; changesPercentage: number }>;
    if (!Array.isArray(data) || data.length === 0) return null;

    const item = data[0]!;
    if (!item.price) return null;
    return { price: item.price, change: item.changesPercentage ?? 0, sparkline: [] };
  } catch {
    return null;
  }
}

export async function fetchYahooQuote(
  symbol: string,
  fmpApiKey?: string,
): Promise<{ price: number; change: number; sparkline: number[] } | null> {
  try {
    await yahooGate();
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (resp.status === 429 || resp.status === 403) {
      // Rate-limited or blocked — fall back to FMP if key is available
      return fmpApiKey ? fetchFMPQuote(symbol, fmpApiKey) : null;
    }
    if (!resp.ok) {
      return fmpApiKey ? fetchFMPQuote(symbol, fmpApiKey) : null;
    }

    const data: YahooChartResponse = await resp.json();
    const result = data.chart.result[0];
    const meta = result?.meta;
    if (!meta) return fmpApiKey ? fetchFMPQuote(symbol, fmpApiKey) : null;

    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose || price;
    const change = ((price - prevClose) / prevClose) * 100;

    const closes = result.indicators?.quote?.[0]?.close;
    const sparkline = closes?.filter((v): v is number => v != null) || [];

    return { price, change, sparkline };
  } catch {
    return fmpApiKey ? fetchFMPQuote(symbol, fmpApiKey) : null;
  }
}

// ========================================================================
// CoinGecko fetcher
// ========================================================================

export async function fetchCoinGeckoMarkets(
  ids: string[],
): Promise<CoinGeckoMarketItem[]> {
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids.join(',')}&order=market_cap_desc&sparkline=true&price_change_percentage=24h`;
  const resp = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`CoinGecko HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json();
  if (!Array.isArray(data)) {
    throw new Error(`CoinGecko returned non-array: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}
