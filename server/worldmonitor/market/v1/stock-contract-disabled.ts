/**
 * Honest disabled-state implementations for the Phase 2 stock RPC contract.
 *
 * These endpoints intentionally return no bars, prices, news, timeline events,
 * analysis, forecast or similar-event claims. Phase 3 replaces this module's
 * no-data implementation with authorized adapters while preserving the same
 * request validation and provenance envelope.
 */

import type {
  AnalyzeStockRangeResponse,
  FindSimilarStockEventsResponse,
  GetStockBarsResponse,
  GetStockEventTimelineResponse,
  GetStockForecastResponse,
  GetStockQuoteResponse,
  ListStockNewsResponse,
  MarketServiceHandler,
  SearchStocksResponse,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import {
  assertSearchQuery,
  assertValidTimeRange,
  normalizeStockInterval,
  normalizeStockSymbol,
  notConfiguredProvenance,
} from './stock-data-contract';

export const searchStocks: MarketServiceHandler['searchStocks'] = async (_ctx, req): Promise<SearchStocksResponse> => {
  assertSearchQuery(req.query);
  return { results: [], provenance: notConfiguredProvenance('stock-search') };
};

export const getStockBars: MarketServiceHandler['getStockBars'] = async (_ctx, req): Promise<GetStockBarsResponse> => {
  const symbol = normalizeStockSymbol(req.symbol);
  const interval = normalizeStockInterval(req.interval);
  assertValidTimeRange(req.startUtc, req.endUtc);
  return {
    symbol,
    interval,
    bars: [],
    marketClosed: false,
    provenance: notConfiguredProvenance('stock-bars'),
  };
};

export const getStockQuote: MarketServiceHandler['getStockQuote'] = async (_ctx, req): Promise<GetStockQuoteResponse> => {
  const symbol = normalizeStockSymbol(req.symbol);
  return { symbol, provenance: notConfiguredProvenance('stock-quote') };
};

export const listStockNews: MarketServiceHandler['listStockNews'] = async (_ctx, req): Promise<ListStockNewsResponse> => {
  const symbol = normalizeStockSymbol(req.symbol);
  return { symbol, items: [], provenance: notConfiguredProvenance('stock-news') };
};

export const getStockEventTimeline: MarketServiceHandler['getStockEventTimeline'] = async (_ctx, req): Promise<GetStockEventTimelineResponse> => {
  const symbol = normalizeStockSymbol(req.symbol);
  assertValidTimeRange(req.startUtc, req.endUtc);
  return { symbol, events: [], provenance: notConfiguredProvenance('stock-event-timeline') };
};

export const analyzeStockRange: MarketServiceHandler['analyzeStockRange'] = async (_ctx, req): Promise<AnalyzeStockRangeResponse> => {
  const symbol = normalizeStockSymbol(req.symbol);
  assertValidTimeRange(req.startUtc, req.endUtc);
  return {
    analysis: {
      available: false,
      reason: 'No contract-backed historical bars are configured for range analysis.',
      symbol,
      rangeStartUtc: req.startUtc,
      rangeEndUtc: req.endUtc,
      metricsAvailable: false,
      startClose: 0,
      endClose: 0,
      realizedReturnPercent: 0,
      totalVolume: 0,
      validatedBarCount: 0,
      causalNote: 'No causal claim is made when no validated source price series is available.',
    },
    provenance: notConfiguredProvenance('stock-range-analysis'),
  };
};

export const getStockForecast: MarketServiceHandler['getStockForecast'] = async (_ctx, req): Promise<GetStockForecastResponse> => {
  const symbol = normalizeStockSymbol(req.symbol);
  const horizon = String(req.horizon ?? '').trim().toUpperCase() || 'UNSPECIFIED';
  return {
    forecast: {
      available: false,
      reason: 'No versioned forecast model is configured for this symbol.',
      symbol,
      horizon,
      modelVersion: '',
    },
    provenance: notConfiguredProvenance('stock-forecast'),
  };
};

export const findSimilarStockEvents: MarketServiceHandler['findSimilarStockEvents'] = async (_ctx, req): Promise<FindSimilarStockEventsResponse> => {
  const symbol = normalizeStockSymbol(req.symbol);
  return { symbol, events: [], provenance: notConfiguredProvenance('similar-stock-events') };
};
