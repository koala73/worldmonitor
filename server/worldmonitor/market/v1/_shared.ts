/**
 * Shared helpers, types, and constants for the market service handler RPCs.
 */
import { CHROME_UA, finnhubGate, yahooGate } from '../../../_shared/constants';
import { getRelayBaseUrl, getRelayHeaders } from '../../../_shared/relay';
export { getRelayBaseUrl, getRelayHeaders };
import cryptoConfig from '../../../../shared/crypto.json';
import stablecoinConfig from '../../../../shared/stablecoins.json';
export { parseStringArray } from '../../../_shared/parse-string-array';

// ========================================================================
// Constants
// ========================================================================

export const UPSTREAM_TIMEOUT_MS = 10_000;

export function sanitizeSymbol(raw: string): string {
  return raw.trim().replace(/\s+/g, '').slice(0, 32).toUpperCase();
}

export async function fetchYahooQuotesBatch(
  symbols: string[],
): Promise<{ results: Map<string, { price: number; change: number; sparkline: number[] }>; rateLimited: boolean }> {
  const results = new Map<string, { price: number; change: number; sparkline: number[] }>();
  let rateLimitHits = 0;
  let consecutiveFails = 0;
  for (let i = 0; i < symbols.length; i++) {
    const q = await fetchYahooQuote(symbols[i]!);
    if (q) {
      results.set(symbols[i]!, q);
      consecutiveFails = 0;
    } else {
      rateLimitHits++;
      consecutiveFails++;
    }
    if (consecutiveFails >= 5) break;
  }
  return { results, rateLimited: rateLimitHits > symbols.length / 2 };
}

// Yahoo-only symbols: indices, futures, and forex pairs not on Finnhub free tier
export const YAHOO_ONLY_SYMBOLS = new Set([
  '^GSPC', '^DJI', '^IXIC', '^VIX',
  'GC=F', 'CL=F', 'NG=F', 'SI=F', 'HG=F',
  'EURUSD=X', 'GBPUSD=X', 'AUDUSD=X',
  'USDJPY=X', 'USDCNY=X', 'USDINR=X', 'USDCHF=X', 'USDCAD=X', 'USDTRY=X',
]);

export const CRYPTO_META: Record<string, { name: string; symbol: string }> = cryptoConfig.meta;

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
  // Extended fields (present from both CoinGecko and CoinPaprika fallback)
  price_change_percentage_7d_in_currency?: number;
  market_cap?: number;
  total_volume?: number;
  symbol?: string;
  name?: string;
  image?: string;
}

// ========================================================================
// Alpha Vantage fetchers
// ========================================================================

// Physical commodity function names for Alpha Vantage (no futures notation needed)
export const AV_PHYSICAL_COMMODITY_MAP: Record<string, string> = {
  'CL=F': 'WTI',
  'BZ=F': 'BRENT',
  'NG=F': 'NATURAL_GAS',
  'HG=F': 'COPPER',
  'ALI=F': 'ALUMINUM',
  'GC=F': 'GOLD',
  'SI=F': 'SILVER',
};

export async function fetchAlphaVantageQuotesBatch(
  symbols: string[],
  apiKey: string,
): Promise<Map<string, { price: number; change: number; sparkline: number[] }>> {
  const results = new Map<string, { price: number; change: number; sparkline: number[] }>();
  const BATCH = 100;
  const AV_BATCH_DELAY_MS = 500;
  for (let i = 0; i < symbols.length; i += BATCH) {
    if (i > 0) await new Promise<void>(r => setTimeout(r, AV_BATCH_DELAY_MS));
    const chunk = symbols.slice(i, i + BATCH);
    const url = `https://www.alphavantage.co/query?function=REALTIME_BULK_QUOTES&symbol=${encodeURIComponent(chunk.join(','))}&apikey=${encodeURIComponent(apiKey)}`;
    let resp: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) await new Promise<void>(r => setTimeout(r, 1000));
        resp = await fetch(url, {
          headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        break;
      } catch (err) {
        console.warn(`[AV] Bulk quotes fetch error (attempt ${attempt + 1}):`, (err as Error).message);
      }
    }
    if (!resp) continue;
    if (!resp.ok) {
      console.warn(`[AV] Bulk quotes HTTP ${resp.status}`);
      continue;
    }
    try {
      const json = await resp.json() as { data?: Array<{ symbol: string; price: string; 'previous close': string; 'change percent': string }>; Information?: string };
      if (json.Information) {
        const remaining = symbols.length - i - chunk.length;
        console.warn(`[AV] Rate limit hit${remaining > 0 ? ` — dropping ${remaining} remaining symbols` : ''}: ${json.Information.slice(0, 80)}`);
        break;
      }
      if (!Array.isArray(json.data)) continue;
      for (const item of json.data) {
        const price = parseFloat(item.price);
        const prevClose = parseFloat(item['previous close']);
        const changePct = Number.isFinite(prevClose) && prevClose > 0
          ? ((price - prevClose) / prevClose) * 100
          : parseFloat((item['change percent'] || '0').replace('%', ''));
        if (Number.isFinite(price) && price > 0) {
          results.set(item.symbol, { price, change: Number.isFinite(changePct) ? changePct : 0, sparkline: [] });
        }
      }
    } catch (err) {
      console.warn(`[AV] Bulk quotes parse error:`, (err as Error).message);
    }
  }
  return results;
}

export async function fetchAlphaVantagePhysicalCommodity(
  yahooSymbol: string,
  apiKey: string,
): Promise<{ price: number; change: number; sparkline: number[] } | null> {
  const fn = AV_PHYSICAL_COMMODITY_MAP[yahooSymbol];
  if (!fn) return null;
  const url = `https://www.alphavantage.co/query?function=${fn}&interval=daily&apikey=${encodeURIComponent(apiKey)}`;
  let resp: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt > 0) await new Promise<void>(r => setTimeout(r, 1000));
      resp = await fetch(url, {
        headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      break;
    } catch (err) {
      console.warn(`[AV] ${fn} fetch error (attempt ${attempt + 1}):`, (err as Error).message);
    }
  }
  if (!resp) return null;
  if (!resp.ok) {
    console.warn(`[AV] ${fn} HTTP ${resp.status}`);
    return null;
  }
  try {
    const json = await resp.json() as { data?: Array<{ date: string; value: string }>; Information?: string };
    if (json.Information) {
      console.warn(`[AV] Rate limit hit: ${json.Information.slice(0, 100)}`);
      return null;
    }
    const data = json.data;
    if (!Array.isArray(data) || data.length < 2) return null;
    const latest = parseFloat(data[0]!.value);
    const prev = parseFloat(data[1]!.value);
    if (!Number.isFinite(latest) || latest <= 0) return null;
    const change = Number.isFinite(prev) && prev > 0 ? ((latest - prev) / prev) * 100 : 0;
    // Build sparkline from last 7 daily closes (oldest → newest)
    const sparkline = data.slice(0, 7).map(d => parseFloat(d.value)).filter(Number.isFinite).reverse();
    return { price: latest, change, sparkline };
  } catch (err) {
    console.warn(`[AV] ${fn} parse error:`, (err as Error).message);
    return null;
  }
}

// ========================================================================
// Finnhub quote fetcher
// ========================================================================

export async function fetchFinnhubQuote(
  symbol: string,
  apiKey: string,
): Promise<{ symbol: string; price: number; changePercent: number } | null> {
  try {
    await finnhubGate();
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}`;
    const resp = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA, 'X-Finnhub-Token': apiKey },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn(`[Finnhub] ${symbol} HTTP ${resp.status}`);
      return null;
    }

    const data = await resp.json() as { c: number; d: number; dp: number; h: number; l: number; o: number; pc: number; t: number };
    if (data.c === 0 && data.h === 0 && data.l === 0) {
      console.warn(`[Finnhub] ${symbol} returned zeros (market closed or invalid)`);
      return null;
    }

    return { symbol, price: data.c, changePercent: data.dp };
  } catch (err) {
    console.warn(`[Finnhub] ${symbol} error:`, (err as Error).message);
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

function parseYahooChartResponse(data: YahooChartResponse): { price: number; change: number; sparkline: number[] } | null {
  const result = data.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta) return null;

  const price = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose || meta.previousClose || price;
  const change = ((price - prevClose) / prevClose) * 100;

  const closes = result.indicators?.quote?.[0]?.close;
  const sparkline = closes?.filter((v): v is number => v != null) || [];

  return { price, change, sparkline };
}

export async function fetchYahooQuote(
  symbol: string,
): Promise<{ price: number; change: number; sparkline: number[] } | null> {
  // Try direct Yahoo first
  try {
    await yahooGate();
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (resp.ok) {
      const data: YahooChartResponse = await resp.json();
      const parsed = parseYahooChartResponse(data);
      if (parsed) return parsed;
    } else {
      console.warn(`[Yahoo] ${symbol} direct HTTP ${resp.status}`);
    }
  } catch (err) {
    console.warn(`[Yahoo] ${symbol} direct error:`, (err as Error).message);
  }

  // Fallback: Railway relay (different IP, not rate-limited by Yahoo)
  const relayBase = getRelayBaseUrl();
  if (!relayBase) {
    console.warn(`[Yahoo] ${symbol} relay skipped: WS_RELAY_URL not set`);
    return null;
  }
  try {
    const relayUrl = `${relayBase}/yahoo-chart?symbol=${encodeURIComponent(symbol)}`;
    const resp = await fetch(relayUrl, {
      headers: getRelayHeaders(),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn(`[Yahoo] ${symbol} relay HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
      return null;
    }
    const data: YahooChartResponse = await resp.json();
    return parseYahooChartResponse(data);
  } catch (err) {
    console.warn(`[Yahoo] ${symbol} relay error:`, (err as Error).message);
    return null;
  }
}

// ========================================================================
// CoinGecko fetcher
// ========================================================================

export async function fetchCoinGeckoMarkets(
  ids: string[],
): Promise<CoinGeckoMarketItem[]> {
  const apiKey = process.env.COINGECKO_API_KEY;
  const baseUrl = apiKey
    ? 'https://pro-api.coingecko.com/api/v3'
    : 'https://api.coingecko.com/api/v3';
  const url = `${baseUrl}/coins/markets?vs_currency=usd&ids=${ids.join(',')}&order=market_cap_desc&sparkline=true&price_change_percentage=24h`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': CHROME_UA,
  };
  if (apiKey) headers['x-cg-pro-api-key'] = apiKey;

  const resp = await fetch(url, {
    headers,
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

// ========================================================================
// CoinPaprika fallback fetcher
// ========================================================================

// CoinGecko ID → CoinPaprika ID mapping (shared ids + stablecoin-specific)
const COINPAPRIKA_ID_MAP: Record<string, string> = {
  ...cryptoConfig.coinpaprika,
  ...stablecoinConfig.coinpaprika,
};

interface CoinPaprikaTicker {
  id: string;
  name: string;
  symbol: string;
  quotes: {
    USD: {
      price: number;
      volume_24h: number;
      market_cap: number;
      percent_change_24h: number;
      percent_change_7d: number;
    };
  };
}

export async function fetchCoinPaprikaMarkets(
  geckoIds: string[],
): Promise<CoinGeckoMarketItem[]> {
  const paprikaIds = geckoIds.map(id => COINPAPRIKA_ID_MAP[id]).filter(Boolean);
  if (paprikaIds.length === 0) throw new Error('No CoinPaprika ID mapping for requested coins');

  const resp = await fetch('https://api.coinpaprika.com/v1/tickers?quotes=USD', {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`CoinPaprika HTTP ${resp.status}`);

  const allTickers: CoinPaprikaTicker[] = await resp.json();
  const paprikaSet = new Set(paprikaIds);
  const matched = allTickers.filter(t => paprikaSet.has(t.id));

  const reverseMap = new Map(Object.entries(COINPAPRIKA_ID_MAP).map(([g, p]) => [p, g]));

  return matched.map(t => {
    const q = t.quotes.USD;
    return {
      id: reverseMap.get(t.id) || t.id,
      current_price: q.price,
      price_change_percentage_24h: q.percent_change_24h,
      price_change_percentage_7d_in_currency: q.percent_change_7d,
      market_cap: q.market_cap,
      total_volume: q.volume_24h,
      symbol: t.symbol.toLowerCase(),
      name: t.name,
      image: '',
      sparkline_in_7d: undefined,
    };
  });
}

// ========================================================================
// Unified crypto market fetcher: CoinGecko → CoinPaprika fallback
// ========================================================================

export async function fetchCryptoMarkets(
  ids: string[],
): Promise<CoinGeckoMarketItem[]> {
  try {
    return await fetchCoinGeckoMarkets(ids);
  } catch (err) {
    console.warn(`[CoinGecko] Failed, falling back to CoinPaprika:`, (err as Error).message);
    return fetchCoinPaprikaMarkets(ids);
  }
}
