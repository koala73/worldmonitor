/**
 * Shared helpers, types, and constants for the market service handler RPCs.
 */

declare const process: { env: Record<string, string | undefined> };

// ========================================================================
// Constants
// ========================================================================

export const UPSTREAM_TIMEOUT_MS = 10_000;

// Yahoo-only symbols: indices and futures not on Finnhub free tier
export const YAHOO_ONLY_SYMBOLS = new Set([
  '^GSPC', '^DJI', '^IXIC', '^VIX',
  'GC=F', 'CL=F', 'NG=F', 'SI=F', 'HG=F',
]);

// Known crypto IDs and their metadata
export const CRYPTO_META: Record<string, { name: string; symbol: string }> = {
  bitcoin: { name: 'Bitcoin', symbol: 'BTC' },
  ethereum: { name: 'Ethereum', symbol: 'ETH' },
  solana: { name: 'Solana', symbol: 'SOL' },
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
      headers: { Accept: 'application/json' },
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

export async function fetchYahooQuote(
  symbol: string,
): Promise<{ price: number; change: number; sparkline: number[] } | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!resp.ok) return null;

    const data: YahooChartResponse = await resp.json();
    const result = data.chart.result[0];
    const meta = result?.meta;
    if (!meta) return null;

    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose || price;
    const change = ((price - prevClose) / prevClose) * 100;

    const closes = result.indicators?.quote?.[0]?.close;
    const sparkline = closes?.filter((v): v is number => v != null) || [];

    return { price, change, sparkline };
  } catch {
    return null;
  }
}

// ========================================================================
// CoinGecko fetcher
// ========================================================================

export async function fetchCoinGeckoMarkets(
  ids: string[],
): Promise<CoinGeckoMarketItem[]> {
  try {
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids.join(',')}&order=market_cap_desc&sparkline=true&price_change_percentage=24h`;
    const resp = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!resp.ok) return [];

    const data = await resp.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}
