/**
 * Server-only Massive (formerly Polygon) stock-data adapter.
 *
 * The API key is deliberately read only from the server environment. This
 * module returns the provider's actual timestamps and never upgrades a feed to
 * REALTIME_LICENSED unless the deployer has separately confirmed the plan's
 * display and redistribution entitlement.
 */

import type {
  DataProvenance,
  ProviderStatus,
  StockBar,
  StockNewsItem,
  StockQuote,
  StockSearchResult,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { cachedFetchJson } from '../../../_shared/redis';
import {
  assertNoSuspiciousFlatline,
  assertStockBarSeriesIntegrity,
  buildMarketCacheKey,
  normalizeStockInterval,
  normalizeStockSymbol,
  StockContractRequestError,
} from './stock-data-contract';
import { resolveUsEquityMarketState } from './market-calendar';

const MASSIVE_API_BASE = 'https://api.massive.com';
const MASSIVE_REST_DOCS = 'https://massive.com/docs/rest/stocks';
const MASSIVE_BARS_DOCS = 'https://massive.com/docs/rest/stocks/aggregates/custom-bars';
const MASSIVE_NEWS_DOCS = 'https://massive.com/docs/rest/stocks/news';
const REQUEST_TIMEOUT_MS = 8_000;
const BARS_CACHE_SECONDS = 30;

export type MassiveStockProviderConfig = {
  apiKey?: string | null;
  /**
   * Must be backed by the purchaser's actual Massive plan/contract. A key by
   * itself cannot make a delayed or historical endpoint "real time".
   */
  realtimeDisplayAndRedistributionConfirmed?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export type MassiveBarsRequest = {
  symbol: string;
  interval: string;
  range: string;
  startUtc: number;
  endUtc: number;
};

export type MassiveBarsResult = {
  symbol: string;
  interval: string;
  bars: StockBar[];
  marketClosed: boolean;
  provenance: DataProvenance;
};

type MassiveAggregate = { t?: number; o?: number; h?: number; l?: number; c?: number; v?: number; vw?: number; n?: number };
type MassiveBarsPayload = { status?: string; ticker?: string; adjusted?: boolean; request_id?: string; results?: MassiveAggregate[] };
type MassiveBarsCache = { payload: MassiveBarsPayload; fetchedAt: number };
type MassiveSnapshotPayload = {
  ticker?: {
    ticker?: string;
    todaysChange?: number;
    todaysChangePerc?: number;
    updated?: number;
    day?: { c?: number };
    min?: { c?: number };
  };
};
type MassiveSearchPayload = { request_id?: string; results?: Array<{ ticker?: string; name?: string; primary_exchange?: string; currency_name?: string; market?: string }> };
type MassiveNewsPayload = { request_id?: string; results?: Array<{ id?: string; title?: string; publisher?: { name?: string; homepage_url?: string }; article_url?: string; published_utc?: string; tickers?: string[] }> };

function configuredApiKey(config: MassiveStockProviderConfig): string | null {
  const key = config.apiKey === undefined ? process.env.MASSIVE_API_KEY : config.apiKey;
  const trimmed = String(key ?? '').trim();
  return trimmed || null;
}

function realtimeEntitlement(config: MassiveStockProviderConfig): boolean {
  return config.realtimeDisplayAndRedistributionConfirmed === undefined
    ? process.env.MASSIVE_REALTIME_DISPLAY_AND_REDISTRIBUTION_CONFIRMED === 'true'
    : config.realtimeDisplayAndRedistributionConfirmed;
}

function nowMs(config: MassiveStockProviderConfig): number {
  return config.now?.() ?? Date.now();
}

function stockFetch(config: MassiveStockProviderConfig): typeof fetch {
  return config.fetchImpl ?? fetch;
}

function isoDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function isIntradayInterval(interval: string): boolean {
  return interval.endsWith('m');
}

function intervalShape(interval: string): { multiplier: number; timespan: 'minute' | 'day' | 'week' } {
  const normalized = normalizeStockInterval(interval);
  if (normalized.endsWith('m')) return { multiplier: Number.parseInt(normalized, 10), timespan: 'minute' };
  if (normalized.endsWith('d')) return { multiplier: Number.parseInt(normalized, 10), timespan: 'day' };
  return { multiplier: 1, timespan: 'week' };
}

function rangeStart(now: number, range: string): number {
  const daysByRange: Record<string, number> = {
    '1D': 2, '5D': 8, '1M': 35, '3M': 100, '1Y': 370, '5Y': 1830, MAX: 9_000,
  };
  const days = daysByRange[String(range ?? '').trim().toUpperCase()] ?? 35;
  return now - (days * 24 * 60 * 60 * 1000);
}

/** Convert explicit timestamps or the requested product range into a bounded API window. */
export function resolveMassiveBarWindow(request: MassiveBarsRequest, now = Date.now()): { from: string; to: string; cacheWindow: string } {
  const start = request.startUtc > 0 ? request.startUtc : rangeStart(now, request.range);
  const end = request.endUtc > 0 ? request.endUtc : now;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    throw new StockContractRequestError('stock bar range is invalid');
  }
  const range = String(request.range ?? '').trim().toUpperCase() || 'CUSTOM';
  return {
    from: isoDate(start),
    to: isoDate(end),
    cacheWindow: `${range}_${start}_${end}`,
  };
}

function sourceId(prefix: string, requestId: string | undefined, symbol: string): string {
  const id = String(requestId ?? '').trim();
  return id ? `${prefix}:${symbol}:${id}` : `${prefix}:${symbol}`;
}

function providerStatusFor(
  config: MassiveStockProviderConfig,
  interval: string,
  marketClosed: boolean,
): ProviderStatus {
  if (marketClosed) return 'PROVIDER_STATUS_MARKET_CLOSED';
  if (!isIntradayInterval(interval)) return 'PROVIDER_STATUS_END_OF_DAY';
  return realtimeEntitlement(config)
    ? 'PROVIDER_STATUS_REALTIME_LICENSED'
    : 'PROVIDER_STATUS_DELAYED_UNVERIFIED';
}

function licenseNote(config: MassiveStockProviderConfig, interval: string): string {
  if (!isIntradayInterval(interval)) {
    return 'This response contains provider-sourced historical/end-of-day bars; it is not labelled real time.';
  }
  return realtimeEntitlement(config)
    ? 'Deployment operator confirmed its Massive plan permits this real-time display and redistribution use.'
    : 'Massive key is configured, but real-time display and redistribution entitlement has not been confirmed; do not treat this as real time.';
}

function provenance(
  config: MassiveStockProviderConfig,
  input: {
    capability: string;
    symbol: string;
    interval: string;
    sourceUrl: string;
    sourceRequestId?: string;
    observedAt: number;
    fetchedAt?: number;
    marketClosed: boolean;
    isFallback?: boolean;
    fallbackReason?: string;
  },
): DataProvenance {
  const fetchedAt = input.fetchedAt ?? nowMs(config);
  const effectiveStatus = providerStatusFor(config, input.interval, input.marketClosed);
  return {
    provider: 'massive',
    providerStatus: effectiveStatus,
    sourceUrl: input.sourceUrl,
    sourceId: sourceId(input.capability, input.sourceRequestId, input.symbol),
    observedAt: input.observedAt,
    fetchedAt,
    asOf: input.observedAt,
    delaySeconds: effectiveStatus === 'PROVIDER_STATUS_REALTIME_LICENSED' ? 0 : -1,
    freshnessSeconds: input.observedAt > 0 ? Math.max(0, Math.floor((fetchedAt - input.observedAt) / 1000)) : -1,
    isFallback: input.isFallback ?? false,
    fallbackReason: input.fallbackReason ?? '',
    licenseNote: licenseNote(config, input.interval),
  };
}

async function requestJson<T extends object>(config: MassiveStockProviderConfig, path: string): Promise<T> {
  const apiKey = configuredApiKey(config);
  if (!apiKey) throw new StockContractRequestError('MASSIVE_API_KEY is not configured');
  const url = new URL(path, MASSIVE_API_BASE);
  url.searchParams.set('apiKey', apiKey);
  const response = await stockFetch(config)(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'worldmonitor-market/1.0' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Massive HTTP ${response.status}`);
  return await response.json() as T;
}

function aggregateBar(symbol: string, interval: string, aggregate: MassiveAggregate, adjusted: boolean): StockBar {
  if (![aggregate.t, aggregate.o, aggregate.h, aggregate.l, aggregate.c, aggregate.v].every(Number.isFinite)) {
    throw new StockContractRequestError(`Massive returned an incomplete OHLCV bar for ${symbol}`);
  }
  const timestampUtc = aggregate.t as number;
  const calendar = resolveUsEquityMarketState(new Date(timestampUtc));
  return {
    symbol,
    interval,
    timestampUtc,
    tradingDate: calendar.tradingDate,
    open: aggregate.o as number,
    high: aggregate.h as number,
    low: aggregate.l as number,
    close: aggregate.c as number,
    volume: aggregate.v as number,
    vwap: Number.isFinite(aggregate.vw) ? aggregate.vw as number : 0,
    transactions: Number.isFinite(aggregate.n) ? aggregate.n as number : 0,
    adjusted,
    session: calendar.session,
    currency: 'USD',
    exchange: 'US',
  };
}

export function massiveProviderConfigured(config: MassiveStockProviderConfig = {}): boolean {
  return configuredApiKey(config) !== null;
}

export async function getMassiveStockBars(
  request: MassiveBarsRequest,
  config: MassiveStockProviderConfig = {},
): Promise<MassiveBarsResult> {
  const symbol = normalizeStockSymbol(request.symbol);
  const interval = normalizeStockInterval(request.interval);
  const apiKey = configuredApiKey(config);
  if (!apiKey) throw new StockContractRequestError('MASSIVE_API_KEY is not configured');
  const { multiplier, timespan } = intervalShape(interval);
  const now = nowMs(config);
  const window = resolveMassiveBarWindow({ ...request, symbol, interval }, now);
  const cacheKey = buildMarketCacheKey('massive', symbol, interval, window.cacheWindow);

  const cached = await cachedFetchJson<MassiveBarsCache>(
    cacheKey,
    BARS_CACHE_SECONDS,
    async () => ({
      payload: await requestJson<MassiveBarsPayload>(
        config,
        `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${multiplier}/${timespan}/${window.from}/${window.to}?adjusted=true&sort=asc&limit=50000`,
      ),
      fetchedAt: nowMs(config),
    }),
    15,
    { timeoutMs: REQUEST_TIMEOUT_MS + 500, cacheFetcherErrors: false },
  );
  if (!cached) throw new Error(`Massive returned no aggregate payload for ${symbol}`);
  const payload = cached.payload;
  if (normalizeStockSymbol(payload.ticker ?? '') !== symbol) {
    throw new StockContractRequestError(`Massive returned ${payload.ticker ?? 'an empty ticker'} for requested ${symbol}`);
  }
  const bars = (payload.results ?? []).map(row => aggregateBar(symbol, interval, row, payload.adjusted === true));
  assertStockBarSeriesIntegrity(symbol, bars);
  assertNoSuspiciousFlatline(symbol, bars);
  const lastTimestamp = bars.length > 0 ? bars[bars.length - 1]!.timestampUtc : 0;
  const marketState = resolveUsEquityMarketState(new Date(now));
  return {
    symbol,
    interval,
    bars,
    marketClosed: marketState.marketClosed,
    provenance: provenance(config, {
      capability: 'stock-bars',
      symbol,
      interval,
      sourceUrl: MASSIVE_BARS_DOCS,
      sourceRequestId: payload.request_id,
      observedAt: lastTimestamp,
      fetchedAt: cached.fetchedAt,
      marketClosed: marketState.marketClosed,
    }),
  };
}

export async function getMassiveStockQuote(symbolInput: string, config: MassiveStockProviderConfig = {}): Promise<{ symbol: string; quote: StockQuote; provenance: DataProvenance }> {
  const symbol = normalizeStockSymbol(symbolInput);
  const payload = await requestJson<MassiveSnapshotPayload>(config, `/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol)}`);
  const ticker = payload.ticker;
  if (!ticker || normalizeStockSymbol(ticker.ticker ?? '') !== symbol || !Number.isFinite(ticker.day?.c)) {
    throw new StockContractRequestError(`Massive returned no valid quote for requested ${symbol}`);
  }
  const observedAt = Number.isFinite(ticker.updated) ? ticker.updated as number : 0;
  const state = resolveUsEquityMarketState(new Date(nowMs(config)));
  return {
    symbol,
    quote: {
      symbol,
      price: ticker.day?.c as number,
      change: Number.isFinite(ticker.todaysChange) ? ticker.todaysChange as number : 0,
      changePercent: Number.isFinite(ticker.todaysChangePerc) ? ticker.todaysChangePerc as number : 0,
      currency: 'USD',
      exchange: 'US',
      session: state.session,
    },
    provenance: provenance(config, {
      capability: 'stock-quote', symbol, interval: '1m', sourceUrl: MASSIVE_REST_DOCS,
      observedAt, marketClosed: state.marketClosed,
    }),
  };
}

export async function searchMassiveStocks(queryInput: string, limit: number, config: MassiveStockProviderConfig = {}): Promise<{ results: StockSearchResult[]; provenance: DataProvenance }> {
  const query = String(queryInput ?? '').trim();
  const payload = await requestJson<MassiveSearchPayload>(config, `/v3/reference/tickers?search=${encodeURIComponent(query)}&market=stocks&active=true&limit=${Math.min(Math.max(1, limit || 10), 50)}`);
  const results = (payload.results ?? []).flatMap((row): StockSearchResult[] => {
    try {
      const symbol = normalizeStockSymbol(row.ticker ?? '');
      return [{ symbol, name: String(row.name ?? symbol), exchange: String(row.primary_exchange ?? ''), currency: String(row.currency_name ?? 'USD') }];
    } catch {
      return [];
    }
  });
  return {
    results,
    provenance: provenance(config, {
      capability: 'stock-search', symbol: query.toUpperCase(), interval: '1d', sourceUrl: MASSIVE_REST_DOCS,
      sourceRequestId: payload.request_id, observedAt: 0, marketClosed: false,
    }),
  };
}

export async function getMassiveStockNews(symbolInput: string, limit: number, config: MassiveStockProviderConfig = {}): Promise<{ symbol: string; items: StockNewsItem[]; provenance: DataProvenance }> {
  const symbol = normalizeStockSymbol(symbolInput);
  const payload = await requestJson<MassiveNewsPayload>(config, `/v2/reference/news?ticker=${encodeURIComponent(symbol)}&limit=${Math.min(Math.max(1, limit || 20), 100)}&order=desc&sort=published_utc`);
  const items = (payload.results ?? []).flatMap((row): StockNewsItem[] => {
    const publishedAtUtc = Date.parse(row.published_utc ?? '');
    if (!row.id || !row.title || !row.article_url || !Number.isFinite(publishedAtUtc)) return [];
    if (Array.isArray(row.tickers) && !row.tickers.map(value => String(value).toUpperCase()).includes(symbol)) return [];
    return [{ id: row.id, symbol, title: row.title, source: row.publisher?.name ?? 'Massive publisher', sourceUrl: row.article_url, publishedAtUtc }];
  });
  const observedAt = Math.max(0, ...items.map(item => item.publishedAtUtc));
  return {
    symbol,
    items,
    provenance: provenance(config, {
      capability: 'stock-news', symbol, interval: '1d', sourceUrl: MASSIVE_NEWS_DOCS,
      sourceRequestId: payload.request_id, observedAt, marketClosed: false,
    }),
  };
}
