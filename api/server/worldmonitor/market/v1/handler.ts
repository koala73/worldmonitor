/**
 * Market service handler -- implements the generated MarketServiceHandler
 * interface with 6 RPCs:
 *   - ListMarketQuotes      (Finnhub + Yahoo Finance for stocks/indices)
 *   - ListCryptoQuotes      (CoinGecko markets API)
 *   - ListCommodityQuotes   (Yahoo Finance for commodity futures)
 *   - GetSectorSummary      (Finnhub for sector ETFs)
 *   - ListStablecoinMarkets (CoinGecko stablecoin peg health)
 *   - ListEtfFlows          (Yahoo Finance BTC spot ETF flow estimates)
 *
 * Consolidates legacy edge functions:
 *   api/finnhub.js
 *   api/yahoo-finance.js
 *   api/coingecko.js
 *   api/stablecoin-markets.js
 *   api/etf-flows.js
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
  ListStablecoinMarketsRequest,
  ListStablecoinMarketsResponse,
  ListEtfFlowsRequest,
  ListEtfFlowsResponse,
  GetCountryStockIndexRequest,
  GetCountryStockIndexResponse,
  MarketQuote,
  CryptoQuote,
  CommodityQuote,
  SectorPerformance,
  Stablecoin,
  EtfFlow,
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
// Stablecoin fetcher (CoinGecko)
// ========================================================================

const DEFAULT_STABLECOIN_IDS = 'tether,usd-coin,dai,first-digital-usd,ethena-usde';

let stablecoinCache: ListStablecoinMarketsResponse | null = null;
let stablecoinCacheTimestamp = 0;
const STABLECOIN_CACHE_TTL = 120_000; // 2 minutes

interface CoinGeckoStablecoinItem {
  id: string;
  symbol: string;
  name: string;
  current_price: number;
  market_cap: number;
  total_volume: number;
  price_change_percentage_24h: number;
  price_change_percentage_7d_in_currency?: number;
  image: string;
}

async function handleListStablecoinMarkets(req: ListStablecoinMarketsRequest): Promise<ListStablecoinMarketsResponse> {
  const now = Date.now();
  if (stablecoinCache && now - stablecoinCacheTimestamp < STABLECOIN_CACHE_TTL) {
    return stablecoinCache;
  }

  const coins = req.coins.length > 0
    ? req.coins.filter(c => /^[a-z0-9-]+$/.test(c)).join(',')
    : DEFAULT_STABLECOIN_IDS;

  try {
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${coins}&order=market_cap_desc&sparkline=false&price_change_percentage=7d`;
    const resp = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    if (resp.status === 429 && stablecoinCache) return stablecoinCache;
    if (!resp.ok) throw new Error(`CoinGecko HTTP ${resp.status}`);

    const data = (await resp.json()) as CoinGeckoStablecoinItem[];

    const stablecoins: Stablecoin[] = data.map(coin => {
      const price = coin.current_price || 0;
      const deviation = Math.abs(price - 1.0);
      let pegStatus: string;
      if (deviation <= 0.005) pegStatus = 'ON PEG';
      else if (deviation <= 0.01) pegStatus = 'SLIGHT DEPEG';
      else pegStatus = 'DEPEGGED';

      return {
        id: coin.id,
        symbol: (coin.symbol || '').toUpperCase(),
        name: coin.name,
        price,
        deviation: +(deviation * 100).toFixed(3),
        pegStatus,
        marketCap: coin.market_cap || 0,
        volume24h: coin.total_volume || 0,
        change24h: coin.price_change_percentage_24h || 0,
        change7d: coin.price_change_percentage_7d_in_currency || 0,
        image: coin.image || '',
      };
    });

    const totalMarketCap = stablecoins.reduce((sum, c) => sum + c.marketCap, 0);
    const totalVolume24h = stablecoins.reduce((sum, c) => sum + c.volume24h, 0);
    const depeggedCount = stablecoins.filter(c => c.pegStatus === 'DEPEGGED').length;

    const result: ListStablecoinMarketsResponse = {
      timestamp: new Date().toISOString(),
      summary: {
        totalMarketCap,
        totalVolume24h,
        coinCount: stablecoins.length,
        depeggedCount,
        healthStatus: depeggedCount === 0 ? 'HEALTHY' : depeggedCount === 1 ? 'CAUTION' : 'WARNING',
      },
      stablecoins,
    };

    stablecoinCache = result;
    stablecoinCacheTimestamp = now;
    return result;
  } catch {
    if (stablecoinCache) return stablecoinCache;
    return {
      timestamp: new Date().toISOString(),
      summary: {
        totalMarketCap: 0,
        totalVolume24h: 0,
        coinCount: 0,
        depeggedCount: 0,
        healthStatus: 'UNAVAILABLE',
      },
      stablecoins: [],
    };
  }
}

// ========================================================================
// ETF Flows fetcher (Yahoo Finance)
// ========================================================================

const ETF_LIST = [
  { ticker: 'IBIT', issuer: 'BlackRock' },
  { ticker: 'FBTC', issuer: 'Fidelity' },
  { ticker: 'ARKB', issuer: 'ARK/21Shares' },
  { ticker: 'BITB', issuer: 'Bitwise' },
  { ticker: 'GBTC', issuer: 'Grayscale' },
  { ticker: 'HODL', issuer: 'VanEck' },
  { ticker: 'BRRR', issuer: 'Valkyrie' },
  { ticker: 'EZBC', issuer: 'Franklin' },
  { ticker: 'BTCO', issuer: 'Invesco' },
  { ticker: 'BTCW', issuer: 'WisdomTree' },
];

let etfCache: ListEtfFlowsResponse | null = null;
let etfCacheTimestamp = 0;
const ETF_CACHE_TTL = 900_000; // 15 minutes

async function fetchEtfChart(ticker: string): Promise<YahooChartResponse | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=5d&interval=1d`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as YahooChartResponse;
  } catch {
    return null;
  }
}

function parseEtfChartData(chart: YahooChartResponse, ticker: string, issuer: string): EtfFlow | null {
  try {
    const result = chart?.chart?.result?.[0];
    if (!result) return null;

    const quote = result.indicators?.quote?.[0];
    const closes = (quote as { close?: (number | null)[] })?.close || [];
    const volumes = (quote as { volume?: (number | null)[] })?.volume || [];

    const validCloses = closes.filter((p): p is number => p != null);
    const validVolumes = volumes.filter((v): v is number => v != null);

    if (validCloses.length < 2) return null;

    const latestPrice = validCloses[validCloses.length - 1];
    const prevPrice = validCloses[validCloses.length - 2];
    const priceChange = prevPrice ? ((latestPrice - prevPrice) / prevPrice * 100) : 0;

    const latestVolume = validVolumes.length > 0 ? validVolumes[validVolumes.length - 1] : 0;
    const avgVolume = validVolumes.length > 1
      ? validVolumes.slice(0, -1).reduce((a, b) => a + b, 0) / (validVolumes.length - 1)
      : latestVolume;

    const volumeRatio = avgVolume > 0 ? latestVolume / avgVolume : 1;
    const direction = priceChange > 0.1 ? 'inflow' : priceChange < -0.1 ? 'outflow' : 'neutral';
    const estFlowMagnitude = latestVolume * latestPrice * (priceChange > 0 ? 1 : -1) * 0.1;

    return {
      ticker,
      issuer,
      price: +latestPrice.toFixed(2),
      priceChange: +priceChange.toFixed(2),
      volume: latestVolume,
      avgVolume: Math.round(avgVolume),
      volumeRatio: +volumeRatio.toFixed(2),
      direction,
      estFlow: Math.round(estFlowMagnitude),
    };
  } catch {
    return null;
  }
}

async function handleListEtfFlows(): Promise<ListEtfFlowsResponse> {
  const now = Date.now();
  if (etfCache && now - etfCacheTimestamp < ETF_CACHE_TTL) {
    return etfCache;
  }

  try {
    const charts = await Promise.allSettled(
      ETF_LIST.map(etf => fetchEtfChart(etf.ticker)),
    );

    const etfs: EtfFlow[] = [];
    for (let i = 0; i < ETF_LIST.length; i++) {
      const chart = charts[i].status === 'fulfilled' ? charts[i].value : null;
      if (chart) {
        const parsed = parseEtfChartData(chart, ETF_LIST[i].ticker, ETF_LIST[i].issuer);
        if (parsed) etfs.push(parsed);
      }
    }

    const totalVolume = etfs.reduce((sum, e) => sum + e.volume, 0);
    const totalEstFlow = etfs.reduce((sum, e) => sum + e.estFlow, 0);
    const inflowCount = etfs.filter(e => e.direction === 'inflow').length;
    const outflowCount = etfs.filter(e => e.direction === 'outflow').length;

    etfs.sort((a, b) => b.volume - a.volume);

    const result: ListEtfFlowsResponse = {
      timestamp: new Date().toISOString(),
      summary: {
        etfCount: etfs.length,
        totalVolume,
        totalEstFlow,
        netDirection: totalEstFlow > 0 ? 'NET INFLOW' : totalEstFlow < 0 ? 'NET OUTFLOW' : 'NEUTRAL',
        inflowCount,
        outflowCount,
      },
      etfs,
    };

    etfCache = result;
    etfCacheTimestamp = now;
    return result;
  } catch {
    if (etfCache) return etfCache;
    return {
      timestamp: new Date().toISOString(),
      summary: {
        etfCount: 0,
        totalVolume: 0,
        totalEstFlow: 0,
        netDirection: 'UNAVAILABLE',
        inflowCount: 0,
        outflowCount: 0,
      },
      etfs: [],
    };
  }
}

// ========================================================================
// Country stock index (Yahoo Finance)
// ========================================================================

const COUNTRY_INDEX: Record<string, { symbol: string; name: string }> = {
  US: { symbol: '^GSPC', name: 'S&P 500' },
  GB: { symbol: '^FTSE', name: 'FTSE 100' },
  DE: { symbol: '^GDAXI', name: 'DAX' },
  FR: { symbol: '^FCHI', name: 'CAC 40' },
  JP: { symbol: '^N225', name: 'Nikkei 225' },
  CN: { symbol: '000001.SS', name: 'SSE Composite' },
  HK: { symbol: '^HSI', name: 'Hang Seng' },
  IN: { symbol: '^BSESN', name: 'BSE Sensex' },
  KR: { symbol: '^KS11', name: 'KOSPI' },
  TW: { symbol: '^TWII', name: 'TAIEX' },
  AU: { symbol: '^AXJO', name: 'ASX 200' },
  BR: { symbol: '^BVSP', name: 'Bovespa' },
  CA: { symbol: '^GSPTSE', name: 'TSX Composite' },
  MX: { symbol: '^MXX', name: 'IPC Mexico' },
  AR: { symbol: '^MERV', name: 'MERVAL' },
  RU: { symbol: 'IMOEX.ME', name: 'MOEX' },
  ZA: { symbol: '^J203.JO', name: 'JSE All Share' },
  SA: { symbol: '^TASI.SR', name: 'Tadawul' },
  AE: { symbol: 'DFMGI.AE', name: 'DFM General' },
  IL: { symbol: '^TA125.TA', name: 'TA-125' },
  TR: { symbol: 'XU100.IS', name: 'BIST 100' },
  PL: { symbol: '^WIG20', name: 'WIG 20' },
  NL: { symbol: '^AEX', name: 'AEX' },
  CH: { symbol: '^SSMI', name: 'SMI' },
  ES: { symbol: '^IBEX', name: 'IBEX 35' },
  IT: { symbol: 'FTSEMIB.MI', name: 'FTSE MIB' },
  SE: { symbol: '^OMX', name: 'OMX Stockholm 30' },
  NO: { symbol: '^OSEAX', name: 'Oslo All Share' },
  SG: { symbol: '^STI', name: 'STI' },
  TH: { symbol: '^SET.BK', name: 'SET' },
  MY: { symbol: '^KLSE', name: 'KLCI' },
  ID: { symbol: '^JKSE', name: 'Jakarta Composite' },
  PH: { symbol: 'PSEI.PS', name: 'PSEi' },
  NZ: { symbol: '^NZ50', name: 'NZX 50' },
  EG: { symbol: '^EGX30.CA', name: 'EGX 30' },
  CL: { symbol: '^IPSA', name: 'IPSA' },
  PE: { symbol: '^SPBLPGPT', name: 'S&P Lima' },
  AT: { symbol: '^ATX', name: 'ATX' },
  BE: { symbol: '^BFX', name: 'BEL 20' },
  FI: { symbol: '^OMXH25', name: 'OMX Helsinki 25' },
  DK: { symbol: '^OMXC25', name: 'OMX Copenhagen 25' },
  IE: { symbol: '^ISEQ', name: 'ISEQ Overall' },
  PT: { symbol: '^PSI20', name: 'PSI 20' },
  CZ: { symbol: '^PX', name: 'PX Prague' },
  HU: { symbol: '^BUX', name: 'BUX' },
};

let stockIndexCache: Record<string, { data: GetCountryStockIndexResponse; ts: number }> = {};
const STOCK_INDEX_CACHE_TTL = 3_600_000; // 1 hour

async function handleGetCountryStockIndex(req: GetCountryStockIndexRequest): Promise<GetCountryStockIndexResponse> {
  const code = (req.countryCode || '').toUpperCase();
  const notAvailable: GetCountryStockIndexResponse = {
    available: false, code, symbol: '', indexName: '', price: 0, weekChangePercent: 0, currency: '', fetchedAt: '',
  };

  if (!code) return notAvailable;

  const index = COUNTRY_INDEX[code];
  if (!index) return notAvailable;

  const cached = stockIndexCache[code];
  if (cached && Date.now() - cached.ts < STOCK_INDEX_CACHE_TTL) return cached.data;

  try {
    const encodedSymbol = encodeURIComponent(index.symbol);
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodedSymbol}?range=1mo&interval=1d`;

    const res = await fetch(yahooUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    if (!res.ok) return notAvailable;

    const data: YahooChartResponse = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return notAvailable;

    const allCloses = result.indicators?.quote?.[0]?.close?.filter((v): v is number => v != null);
    if (!allCloses || allCloses.length < 2) return notAvailable;

    const closes = allCloses.slice(-6);
    const latest = closes[closes.length - 1];
    const oldest = closes[0];
    const weekChange = ((latest - oldest) / oldest) * 100;
    const meta = result.meta || {};

    const payload: GetCountryStockIndexResponse = {
      available: true,
      code,
      symbol: index.symbol,
      indexName: index.name,
      price: +latest.toFixed(2),
      weekChangePercent: +weekChange.toFixed(2),
      currency: (meta as { currency?: string }).currency || 'USD',
      fetchedAt: new Date().toISOString(),
    };

    stockIndexCache[code] = { data: payload, ts: Date.now() };
    return payload;
  } catch {
    return notAvailable;
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

  async listStablecoinMarkets(
    _ctx: ServerContext,
    req: ListStablecoinMarketsRequest,
  ): Promise<ListStablecoinMarketsResponse> {
    return handleListStablecoinMarkets(req);
  },

  async listEtfFlows(
    _ctx: ServerContext,
    _req: ListEtfFlowsRequest,
  ): Promise<ListEtfFlowsResponse> {
    return handleListEtfFlows();
  },

  async getCountryStockIndex(
    _ctx: ServerContext,
    req: GetCountryStockIndexRequest,
  ): Promise<GetCountryStockIndexResponse> {
    return handleGetCountryStockIndex(req);
  },
};
