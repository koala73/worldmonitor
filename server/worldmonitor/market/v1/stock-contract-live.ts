/**
 * Phase 3 stock contract handlers.
 *
 * Massive is the only primary OHLC source. Finnhub/Alpha Vantage are retained
 * only as an explicitly-labelled quote fallback; they never manufacture a
 * candle series when the primary provider is unavailable.
 */

import type {
  DataProvenance,
  GetStockQuoteResponse,
  MarketServiceHandler,
  StockQuote,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { AlphaVantageQuoteProvider, FinnhubQuoteProvider } from './_quote-provider';
import {
  getMassiveStockBars,
  getMassiveStockNews,
  getMassiveStockQuote,
  massiveProviderConfigured,
  searchMassiveStocks,
  type MassiveStockProviderConfig,
} from './massive-stock-provider';
import { resolveUsEquityMarketState } from './market-calendar';
import {
  assertSearchQuery,
  assertValidTimeRange,
  normalizeStockInterval,
  normalizeStockSymbol,
} from './stock-data-contract';
import * as disabled from './stock-contract-disabled';

export type StockQuoteFallback = (symbol: string) => Promise<{ quote: StockQuote; provenance: DataProvenance } | null>;

export type StockContractLiveOptions = {
  massive?: MassiveStockProviderConfig;
  fallbackQuote?: StockQuoteFallback;
};

function unavailableProvenance(capability: string, symbol: string, reason: string, now = Date.now()): DataProvenance {
  return {
    provider: 'massive',
    providerStatus: 'PROVIDER_STATUS_UNAVAILABLE',
    sourceUrl: 'https://massive.com/docs/rest/stocks',
    sourceId: `${capability}:${symbol}`,
    observedAt: 0,
    fetchedAt: now,
    asOf: 0,
    delaySeconds: -1,
    freshnessSeconds: -1,
    isFallback: false,
    fallbackReason: reason,
    licenseNote: 'No upstream market value was returned after the provider failure.',
  };
}

function configuredFallbackKey(name: 'FINNHUB_API_KEY' | 'ALPHA_VANTAGE_API_KEY'): string | null {
  const key = String(process.env[name] ?? '').trim();
  return key || null;
}

/**
 * Preserve the existing authorized fallback chain for a *quote only*.
 * Its plan/latency is not inferred, so it can never report REALTIME_LICENSED.
 */
export async function fetchConfiguredQuoteFallback(symbolInput: string): Promise<{ quote: StockQuote; provenance: DataProvenance } | null> {
  const symbol = normalizeStockSymbol(symbolInput);
  const candidates = [
    { provider: 'finnhub', sourceUrl: 'https://finnhub.io/docs/api/quote', key: configuredFallbackKey('FINNHUB_API_KEY'), make: (key: string) => new FinnhubQuoteProvider(key) },
    { provider: 'alpha-vantage', sourceUrl: 'https://www.alphavantage.co/documentation/#latestprice', key: configuredFallbackKey('ALPHA_VANTAGE_API_KEY'), make: (key: string) => new AlphaVantageQuoteProvider(key) },
  ];
  for (const candidate of candidates) {
    if (!candidate.key) continue;
    const outcome = await candidate.make(candidate.key).fetchQuote(symbol);
    if (outcome.status !== 'ok') continue;
    const state = resolveUsEquityMarketState();
    const fetchedAt = Date.now();
    return {
      quote: {
        symbol,
        price: outcome.quote.price,
        change: 0,
        changePercent: outcome.quote.change,
        currency: 'USD',
        exchange: 'US',
        session: state.session,
      },
      provenance: {
        provider: candidate.provider,
        providerStatus: state.marketClosed ? 'PROVIDER_STATUS_MARKET_CLOSED' : 'PROVIDER_STATUS_DELAYED_UNVERIFIED',
        sourceUrl: candidate.sourceUrl,
        sourceId: `stock-quote:${candidate.provider}:${symbol}`,
        observedAt: 0,
        fetchedAt,
        asOf: 0,
        delaySeconds: -1,
        freshnessSeconds: -1,
        isFallback: true,
        fallbackReason: 'Massive primary quote is not configured or was unavailable; this response is a non-real-time-labelled quote fallback.',
        licenseNote: 'Fallback provider plan, exchange coverage and redistribution entitlement have not been promoted to a real-time claim.',
      },
    };
  }
  return null;
}

function hasPrimary(options: StockContractLiveOptions): boolean {
  return massiveProviderConfigured(options.massive);
}

function isNotConfiguredError(error: unknown): boolean {
  return error instanceof Error && /MASSIVE_API_KEY is not configured/.test(error.message);
}

export function createStockContractLiveHandlers(options: StockContractLiveOptions = {}) {
  const massive = options.massive ?? {};
  const fallbackQuote = options.fallbackQuote ?? fetchConfiguredQuoteFallback;

  const searchStocks: MarketServiceHandler['searchStocks'] = async (_ctx, req) => {
    const query = assertSearchQuery(req.query);
    if (!hasPrimary({ massive })) return disabled.searchStocks(_ctx, req);
    try {
      return await searchMassiveStocks(query, req.limit, massive);
    } catch (error) {
      if (isNotConfiguredError(error)) return disabled.searchStocks(_ctx, req);
      return { results: [], provenance: unavailableProvenance('stock-search', query.toUpperCase(), 'Massive stock search failed.') };
    }
  };

  const getStockBars: MarketServiceHandler['getStockBars'] = async (_ctx, req) => {
    const symbol = normalizeStockSymbol(req.symbol);
    const interval = normalizeStockInterval(req.interval);
    assertValidTimeRange(req.startUtc, req.endUtc);
    if (!hasPrimary({ massive })) {
      const result = await disabled.getStockBars(_ctx, { ...req, symbol, interval });
      return { ...result, marketClosed: resolveUsEquityMarketState().marketClosed };
    }
    try {
      return await getMassiveStockBars({ symbol, interval, range: req.range, startUtc: req.startUtc, endUtc: req.endUtc }, massive);
    } catch (error) {
      if (isNotConfiguredError(error)) return disabled.getStockBars(_ctx, { ...req, symbol, interval });
      return {
        symbol,
        interval,
        bars: [],
        marketClosed: resolveUsEquityMarketState().marketClosed,
        provenance: unavailableProvenance('stock-bars', symbol, 'Massive OHLC request failed; no fallback candle series is invented.'),
      };
    }
  };

  const getStockQuote: MarketServiceHandler['getStockQuote'] = async (_ctx, req): Promise<GetStockQuoteResponse> => {
    const symbol = normalizeStockSymbol(req.symbol);
    if (hasPrimary({ massive })) {
      try {
        return await getMassiveStockQuote(symbol, massive);
      } catch (error) {
        if (!isNotConfiguredError(error)) {
          const fallback = await fallbackQuote(symbol);
          if (fallback) return { symbol, ...fallback };
          return { symbol, provenance: unavailableProvenance('stock-quote', symbol, 'Massive quote failed and no quote fallback returned data.') };
        }
      }
    }
    const fallback = await fallbackQuote(symbol);
    if (fallback) return { symbol, ...fallback };
    return disabled.getStockQuote(_ctx, { ...req, symbol });
  };

  const listStockNews: MarketServiceHandler['listStockNews'] = async (_ctx, req) => {
    const symbol = normalizeStockSymbol(req.symbol);
    if (!hasPrimary({ massive })) return disabled.listStockNews(_ctx, { ...req, symbol });
    try {
      return await getMassiveStockNews(symbol, req.limit, massive);
    } catch (error) {
      if (isNotConfiguredError(error)) return disabled.listStockNews(_ctx, { ...req, symbol });
      return { symbol, items: [], provenance: unavailableProvenance('stock-news', symbol, 'Massive company-news request failed.') };
    }
  };

  const getStockEventTimeline: MarketServiceHandler['getStockEventTimeline'] = async (_ctx, req) => {
    const symbol = normalizeStockSymbol(req.symbol);
    assertValidTimeRange(req.startUtc, req.endUtc);
    if (!hasPrimary({ massive })) return disabled.getStockEventTimeline(_ctx, { ...req, symbol });
    try {
      const news = await getMassiveStockNews(symbol, 100, massive);
      return { symbol, events: [], provenance: { ...news.provenance, sourceId: `stock-event-timeline:${symbol}` } };
    } catch (error) {
      if (isNotConfiguredError(error)) return disabled.getStockEventTimeline(_ctx, { ...req, symbol });
      return { symbol, events: [], provenance: unavailableProvenance('stock-event-timeline', symbol, 'Massive news request failed; no derived events were created.') };
    }
  };

  const analyzeStockRange: MarketServiceHandler['analyzeStockRange'] = async (_ctx, req) => {
    const symbol = normalizeStockSymbol(req.symbol);
    assertValidTimeRange(req.startUtc, req.endUtc);
    if (!hasPrimary({ massive })) return disabled.analyzeStockRange(_ctx, { ...req, symbol });
    try {
      const bars = await getMassiveStockBars({ symbol, interval: '1d', range: 'CUSTOM', startUtc: req.startUtc, endUtc: req.endUtc }, massive);
      const firstBar = bars.bars[0];
      const lastBar = bars.bars[bars.bars.length - 1];
      const metricsAvailable = Boolean(firstBar && lastBar && firstBar.close !== 0);
      const realizedReturnPercent = metricsAvailable
        ? ((lastBar!.close - firstBar!.close) / firstBar!.close) * 100
        : 0;
      return {
        analysis: {
          available: metricsAvailable,
          reason: metricsAvailable
            ? 'Validated price and volume metrics are available for this selected range. They are not a causal explanation of the move.'
            : 'Provider bars did not contain enough validated values for range metrics.',
          symbol,
          rangeStartUtc: req.startUtc,
          rangeEndUtc: req.endUtc,
          metricsAvailable,
          startClose: firstBar?.close ?? 0,
          endClose: lastBar?.close ?? 0,
          realizedReturnPercent,
          totalVolume: bars.bars.reduce((sum, bar) => sum + bar.volume, 0),
          validatedBarCount: bars.bars.length,
          causalNote: 'The metrics are observed price/volume facts. News alignment, sentiment and temporal correlation do not prove that an event caused the return.',
        },
        provenance: { ...bars.provenance, sourceId: `stock-range-analysis:${symbol}` },
      };
    } catch (error) {
      if (isNotConfiguredError(error)) return disabled.analyzeStockRange(_ctx, { ...req, symbol });
      return {
        analysis: {
          available: false, reason: 'No provider bar series could be verified for this range.', symbol, rangeStartUtc: req.startUtc, rangeEndUtc: req.endUtc,
          metricsAvailable: false, startClose: 0, endClose: 0, realizedReturnPercent: 0, totalVolume: 0, validatedBarCount: 0,
          causalNote: 'No causal claim is made when the source price series is unavailable.',
        },
        provenance: unavailableProvenance('stock-range-analysis', symbol, 'Massive range request failed.'),
      };
    }
  };

  return {
    searchStocks,
    getStockBars,
    getStockQuote,
    listStockNews,
    getStockEventTimeline,
    analyzeStockRange,
    getStockForecast: disabled.getStockForecast,
    findSimilarStockEvents: disabled.findSimilarStockEvents,
  } satisfies Pick<MarketServiceHandler,
    'searchStocks' | 'getStockBars' | 'getStockQuote' | 'listStockNews' |
    'getStockEventTimeline' | 'analyzeStockRange' | 'getStockForecast' | 'findSimilarStockEvents'>;
}

const defaultHandlers = createStockContractLiveHandlers();

export const searchStocks = defaultHandlers.searchStocks;
export const getStockBars = defaultHandlers.getStockBars;
export const getStockQuote = defaultHandlers.getStockQuote;
export const listStockNews = defaultHandlers.listStockNews;
export const getStockEventTimeline = defaultHandlers.getStockEventTimeline;
export const analyzeStockRange = defaultHandlers.analyzeStockRange;
export const getStockForecast = defaultHandlers.getStockForecast;
export const findSimilarStockEvents = defaultHandlers.findSimilarStockEvents;
