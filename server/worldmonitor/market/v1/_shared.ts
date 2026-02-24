/**
 * Shared helpers, types, and constants for the market service handler RPCs.
 */

declare const process: { env: Record<string, string | undefined> };

import { CHROME_UA, yahooGate } from '../../../_shared/constants';

// ========================================================================
// Constants
// ========================================================================

export const UPSTREAM_TIMEOUT_MS = 10_000;

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function fetchYahooQuotesBatch(
  symbols: string[],
): Promise<Map<string, { price: number; change: number; sparkline: number[] }>> {
  const results = new Map<string, { price: number; change: number; sparkline: number[] }>();
  for (let i = 0; i < symbols.length; i++) {
    const q = await fetchYahooQuote(symbols[i]!);
    if (q) results.set(symbols[i]!, q);
  }
  return results;
}

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
// TODO: Add Financial Modeling Prep (FMP) as Yahoo Finance fallback.
//
// FMP API docs: https://site.financialmodelingprep.com/developer/docs
// Auth: API key required — env var FMP_API_KEY
// Free tier: 250 requests/day (paid tiers for higher volume)
//
// Endpoint mapping (Yahoo → FMP):
//   Quote:      /stable/quote?symbol=AAPL           (batch: comma-separated)
//   Indices:    /stable/quote?symbol=^GSPC           (^GSPC, ^DJI, ^IXIC supported)
//   Commodities:/stable/quote?symbol=GCUSD           (gold=GCUSD, oil=CLUSD, etc.)
//   Forex:      /stable/batch-forex-quotes            (JPY/USD pairs)
//   Crypto:     /stable/batch-crypto-quotes           (BTC, ETH, etc.)
//   Sparkline:  /stable/historical-price-eod/light?symbol=AAPL  (daily close)
//   Intraday:   /stable/historical-chart/1min?symbol=AAPL
//
// Symbol mapping needed:
//   ^GSPC → ^GSPC (same), ^VIX → ^VIX (same)
//   GC=F → GCUSD, CL=F → CLUSD, NG=F → NGUSD, SI=F → SIUSD, HG=F → HGUSD
//   JPY=X → JPYUSD (forex pair format differs)
//   BTC-USD → BTCUSD
//
// Implementation plan:
//   1. Add FMP_API_KEY to SUPPORTED_SECRET_KEYS in main.rs + settings UI
//   2. Create fetchFMPQuote() here returning same shape as fetchYahooQuote()
//   3. fetchYahooQuote() tries Yahoo first → on 429/failure, tries FMP if key exists
//   4. economic/_shared.ts fetchJSON() same fallback for Yahoo chart URLs
//   5. get-macro-signals.ts needs chart data (1y range) — use /stable/historical-price-eod/light
// ========================================================================

export async function fetchYahooQuote(
  symbol: string,
): Promise<{ price: number; change: number; sparkline: number[] } | null> {
  try {
    await yahooGate();
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': CHROME_UA,
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
