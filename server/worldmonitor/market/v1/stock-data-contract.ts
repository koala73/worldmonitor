/**
 * Phase 2 stock-data contract primitives.
 *
 * This module deliberately does not synthesize a price, bar, news item or
 * forecast. Until a contract-backed adapter exists, every stock endpoint
 * reports NOT_CONFIGURED with complete provenance instead of a misleading
 * successful-looking payload.
 */

import type {
  DataProvenance,
  ProviderStatus,
  StockBar,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';

const STOCK_SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,14}$/;
const INTERVAL_PATTERN = /^(?:1|5|15|30|60)m$|^(?:1|5)d$|^1w$/;

export class StockContractRequestError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'StockContractRequestError';
  }
}

/** Normalize only symbols this product can unambiguously cache and request. */
export function normalizeStockSymbol(raw: string): string {
  const symbol = String(raw ?? '').trim().toUpperCase();
  if (!symbol) throw new StockContractRequestError('symbol is required');
  if (!STOCK_SYMBOL_PATTERN.test(symbol)) {
    throw new StockContractRequestError('symbol must be a valid equity ticker');
  }
  return symbol;
}

export function normalizeStockInterval(raw: string): string {
  const interval = String(raw ?? '').trim().toLowerCase() || '1d';
  if (!INTERVAL_PATTERN.test(interval)) {
    throw new StockContractRequestError('interval must be one of 1m, 5m, 15m, 30m, 60m, 1d, 5d, or 1w');
  }
  return interval;
}

export function assertValidTimeRange(startUtc: number, endUtc: number): void {
  if (!Number.isFinite(startUtc) || !Number.isFinite(endUtc) || startUtc < 0 || endUtc < 0) {
    throw new StockContractRequestError('start_utc and end_utc must be non-negative timestamps');
  }
  if (startUtc > 0 && endUtc > 0 && startUtc > endUtc) {
    throw new StockContractRequestError('start_utc must be less than or equal to end_utc');
  }
}

/**
 * Every market cache key names its provider, requested symbol, interval and
 * requested window. Omitting any component is a correctness bug because it can
 * serve one company's data as another's.
 */
export function buildMarketCacheKey(
  provider: string,
  rawSymbol: string,
  rawInterval: string,
  range: string,
): string {
  const providerId = String(provider ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(providerId)) {
    throw new StockContractRequestError('provider must be a stable identifier');
  }
  const symbol = normalizeStockSymbol(rawSymbol);
  const interval = normalizeStockInterval(rawInterval);
  const window = String(range ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9:_-]{1,64}$/.test(window)) {
    throw new StockContractRequestError('range must be a stable requested window identifier');
  }
  return `market:bars:v1:${providerId}:${symbol}:${interval}:${window}`;
}

/** Reject malformed, cross-symbol, duplicate or non-OHLC-compliant bars. */
export function assertStockBarSeriesIntegrity(requestedSymbol: string, bars: readonly StockBar[]): void {
  const symbol = normalizeStockSymbol(requestedSymbol);
  let previousTimestamp = -1;

  for (const bar of bars) {
    if (bar.symbol !== symbol) {
      throw new StockContractRequestError(`provider returned ${bar.symbol || 'an empty symbol'} for requested ${symbol}`);
    }
    if (!Number.isFinite(bar.timestampUtc) || bar.timestampUtc <= previousTimestamp) {
      throw new StockContractRequestError(`bars for ${symbol} must have strictly increasing timestamps`);
    }
    if (![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)) {
      throw new StockContractRequestError(`bars for ${symbol} must contain finite OHLCV values`);
    }
    if (bar.low > bar.open || bar.low > bar.close || bar.high < bar.open || bar.high < bar.close) {
      throw new StockContractRequestError(`bars for ${symbol} violate the OHLC invariant`);
    }
    if (bar.volume < 0) {
      throw new StockContractRequestError(`bars for ${symbol} cannot have negative volume`);
    }
    previousTimestamp = bar.timestampUtc;
  }
}

export function notConfiguredProvenance(capability: string, now = Date.now()): DataProvenance {
  const providerStatus: ProviderStatus = 'PROVIDER_STATUS_NOT_CONFIGURED';
  return {
    provider: 'none',
    providerStatus,
    sourceUrl: '',
    sourceId: `market:${capability}`,
    observedAt: 0,
    fetchedAt: now,
    asOf: 0,
    delaySeconds: -1,
    freshnessSeconds: -1,
    isFallback: false,
    fallbackReason: 'No contract-backed market-data Provider is configured for this capability.',
    licenseNote: 'No quote, OHLC bar, news, event, analysis, forecast, or inferred market data was returned.',
  };
}

export function assertSearchQuery(raw: string): string {
  const query = String(raw ?? '').trim();
  if (!query) throw new StockContractRequestError('query is required');
  if (query.length > 100 || /[\u0000-\u001f\u007f]/.test(query)) {
    throw new StockContractRequestError('query is invalid');
  }
  return query;
}
