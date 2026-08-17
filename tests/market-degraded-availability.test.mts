import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FINNHUB_CONFIG_MESSAGE,
  resolveSectorHeatmapAvailability,
  resolveStockMarketAvailability,
} from '../src/services/market-availability.ts';

describe('degraded market availability', () => {
  it('keeps partial Yahoo-backed markets usable when Finnhub is not configured', () => {
    const stocks = resolveStockMarketAvailability({
      stockCount: 2,
      finnhubSkipped: true,
      rateLimited: false,
    });
    const heatmap = resolveSectorHeatmapAvailability({
      sectorCount: 0,
      finnhubSkipped: true,
    });

    assert.equal(stocks.finnhubStatus, 'error');
    assert.equal(stocks.marketsConfigError, null);
    assert.equal(stocks.skipCommodityFetch, false);
    assert.equal(heatmap.configError, FINNHUB_CONFIG_MESSAGE);
  });

  it('shows the Markets configuration error only when no stock rows remain', () => {
    const stocks = resolveStockMarketAvailability({
      stockCount: 0,
      finnhubSkipped: true,
      rateLimited: false,
    });

    assert.equal(stocks.marketsConfigError, FINNHUB_CONFIG_MESSAGE);
  });

  it('keeps rate limiting distinct from missing Finnhub configuration', () => {
    const stocks = resolveStockMarketAvailability({
      stockCount: 0,
      finnhubSkipped: true,
      rateLimited: true,
    });

    assert.equal(stocks.finnhubStatus, null);
    assert.equal(stocks.marketsConfigError, null);
    assert.notEqual(stocks.rateLimitError, null);
    assert.equal(stocks.skipCommodityFetch, true);
  });
});
