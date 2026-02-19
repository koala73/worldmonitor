/**
 * Market service handler -- implements the generated MarketServiceHandler
 * interface with 4 RPCs:
 *   - ListMarketQuotes   (Finnhub + Yahoo Finance for stocks/indices)
 *   - ListCryptoQuotes   (CoinGecko markets API)
 *   - ListCommodityQuotes (Yahoo Finance for commodity futures)
 *   - GetSectorSummary   (Finnhub for sector ETFs)
 *
 * Consolidates legacy edge functions:
 *   api/finnhub.js
 *   api/yahoo-finance.js
 *   api/coingecko.js
 *
 * All RPCs have graceful degradation: return empty on upstream failure.
 */

declare const process: { env: Record<string, string | undefined> };

import type {
  MarketServiceHandler,
  ServerContext,
  ListMarketQuotesRequest,
  ListMarketQuotesResponse,
  ListCryptoQuotesRequest,
  ListCryptoQuotesResponse,
  ListCommodityQuotesRequest,
  ListCommodityQuotesResponse,
  GetSectorSummaryRequest,
  GetSectorSummaryResponse,
  MarketQuote,
  CryptoQuote,
  CommodityQuote,
  SectorPerformance,
} from '../../../../../src/generated/server/worldmonitor/market/v1/service_server';

// ========================================================================
// Constants
// ========================================================================

const UPSTREAM_TIMEOUT_MS = 10_000;

// Yahoo-only symbols: indices and futures not on Finnhub free tier
const YAHOO_ONLY_SYMBOLS = new Set([
  '^GSPC', '^DJI', '^IXIC', '^VIX',
  'GC=F', 'CL=F', 'NG=F', 'SI=F', 'HG=F',
]);

// Known crypto IDs and their metadata
const CRYPTO_META: Record<string, { name: string; symbol: string }> = {
  bitcoin: { name: 'Bitcoin', symbol: 'BTC' },
  ethereum: { name: 'Ethereum', symbol: 'ETH' },
  solana: { name: 'Solana', symbol: 'SOL' },
};

// ========================================================================
// Finnhub quote fetcher
// ========================================================================

async function fetchFinnhubQuote(
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

interface YahooChartResponse {
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

async function fetchYahooQuote(
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

interface CoinGeckoMarketItem {
  id: string;
  current_price: number;
  price_change_percentage_24h: number;
  sparkline_in_7d?: { price: number[] };
}

async function fetchCoinGeckoMarkets(
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

// ========================================================================
// Handler export
// ========================================================================

export const marketHandler: MarketServiceHandler = {
  async listMarketQuotes(
    _ctx: ServerContext,
    req: ListMarketQuotesRequest,
  ): Promise<ListMarketQuotesResponse> {
    try {
      const apiKey = process.env.FINNHUB_API_KEY;
      const symbols = req.symbols;
      if (!symbols.length) return { quotes: [] };

      const finnhubSymbols = symbols.filter((s) => !YAHOO_ONLY_SYMBOLS.has(s));
      const yahooSymbols = symbols.filter((s) => YAHOO_ONLY_SYMBOLS.has(s));

      const quotes: MarketQuote[] = [];

      // Fetch Finnhub quotes (only if API key is set)
      if (finnhubSymbols.length > 0 && apiKey) {
        const results = await Promise.all(
          finnhubSymbols.map((s) => fetchFinnhubQuote(s, apiKey)),
        );
        for (const r of results) {
          if (r) {
            quotes.push({
              symbol: r.symbol,
              name: r.symbol,
              display: r.symbol,
              price: r.price,
              change: r.changePercent,
              sparkline: [],
            });
          }
        }
      }

      // Fetch Yahoo Finance quotes for indices/futures
      if (yahooSymbols.length > 0) {
        const results = await Promise.all(
          yahooSymbols.map(async (s) => {
            const yahoo = await fetchYahooQuote(s);
            if (!yahoo) return null;
            return {
              symbol: s,
              name: s,
              display: s,
              price: yahoo.price,
              change: yahoo.change,
              sparkline: yahoo.sparkline,
            } satisfies MarketQuote;
          }),
        );
        for (const r of results) {
          if (r) quotes.push(r);
        }
      }

      return { quotes };
    } catch {
      return { quotes: [] };
    }
  },

  async listCryptoQuotes(
    _ctx: ServerContext,
    req: ListCryptoQuotesRequest,
  ): Promise<ListCryptoQuotesResponse> {
    try {
      const ids = req.ids.length > 0 ? req.ids : Object.keys(CRYPTO_META);
      const items = await fetchCoinGeckoMarkets(ids);

      const byId = new Map(items.map((c) => [c.id, c]));
      const quotes: CryptoQuote[] = [];

      for (const id of ids) {
        const coin = byId.get(id);
        const meta = CRYPTO_META[id];
        const prices = coin?.sparkline_in_7d?.price;
        const sparkline = prices && prices.length > 24 ? prices.slice(-48) : (prices || []);

        quotes.push({
          name: meta?.name || id,
          symbol: meta?.symbol || id.toUpperCase(),
          price: coin?.current_price ?? 0,
          change: coin?.price_change_percentage_24h ?? 0,
          sparkline,
        });
      }

      return { quotes };
    } catch {
      return { quotes: [] };
    }
  },

  async listCommodityQuotes(
    _ctx: ServerContext,
    req: ListCommodityQuotesRequest,
  ): Promise<ListCommodityQuotesResponse> {
    try {
      const symbols = req.symbols;
      if (!symbols.length) return { quotes: [] };

      const results = await Promise.all(
        symbols.map(async (s) => {
          const yahoo = await fetchYahooQuote(s);
          if (!yahoo) return null;
          return {
            symbol: s,
            name: s,
            display: s,
            price: yahoo.price,
            change: yahoo.change,
            sparkline: yahoo.sparkline,
          } satisfies CommodityQuote;
        }),
      );

      return { quotes: results.filter((r): r is CommodityQuote => r !== null) };
    } catch {
      return { quotes: [] };
    }
  },

  async getSectorSummary(
    _ctx: ServerContext,
    req: GetSectorSummaryRequest,
  ): Promise<GetSectorSummaryResponse> {
    try {
      const apiKey = process.env.FINNHUB_API_KEY;
      if (!apiKey) return { sectors: [] };

      // Sector ETF symbols
      const sectorSymbols = ['XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLI', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC', 'SMH'];
      const results = await Promise.all(
        sectorSymbols.map((s) => fetchFinnhubQuote(s, apiKey)),
      );

      const sectors: SectorPerformance[] = [];
      for (const r of results) {
        if (r) {
          sectors.push({
            symbol: r.symbol,
            name: r.symbol,
            change: r.changePercent,
          });
        }
      }

      return { sectors };
    } catch {
      return { sectors: [] };
    }
  },
};
