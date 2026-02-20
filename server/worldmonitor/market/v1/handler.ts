/**
 * Market service handler -- thin composition of per-RPC modules.
 *
 * RPCs:
 *   - ListMarketQuotes      (Finnhub + Yahoo Finance for stocks/indices)
 *   - ListCryptoQuotes      (CoinGecko markets API)
 *   - ListCommodityQuotes   (Yahoo Finance for commodity futures)
 *   - GetSectorSummary      (Finnhub for sector ETFs)
 *   - ListStablecoinMarkets (CoinGecko stablecoin peg health)
 *   - ListEtfFlows          (Yahoo Finance BTC spot ETF flow estimates)
 *   - GetCountryStockIndex  (Yahoo Finance national stock indices)
 */

import type { MarketServiceHandler } from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { listMarketQuotes } from './list-market-quotes';
import { listCryptoQuotes } from './list-crypto-quotes';
import { listCommodityQuotes } from './list-commodity-quotes';
import { getSectorSummary } from './get-sector-summary';
import { listStablecoinMarkets } from './list-stablecoin-markets';
import { listEtfFlows } from './list-etf-flows';
import { getCountryStockIndex } from './get-country-stock-index';

export const marketHandler: MarketServiceHandler = {
  listMarketQuotes,
  listCryptoQuotes,
  listCommodityQuotes,
  getSectorSummary,
  listStablecoinMarkets,
  listEtfFlows,
  getCountryStockIndex,
};
