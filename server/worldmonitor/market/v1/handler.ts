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
 *   - ListGulfQuotes        (Yahoo Finance GCC indices, currencies, oil)
 */

import type { MarketServiceHandler } from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { listMarketQuotes } from './list-market-quotes';
import { listCryptoQuotes } from './list-crypto-quotes';
import { listCommodityQuotes } from './list-commodity-quotes';
import { getSectorSummary } from './get-sector-summary';
import { listStablecoinMarkets } from './list-stablecoin-markets';
import { listEtfFlows } from './list-etf-flows';
import { getCountryStockIndex } from './get-country-stock-index';
import { listGulfQuotes } from './list-gulf-quotes';
import { analyzeStock } from './analyze-stock';
import { getStockAnalysisHistory } from './get-stock-analysis-history';
import { backtestStock } from './backtest-stock';
import { listStoredStockBacktests } from './list-stored-stock-backtests';
import { listCryptoSectors } from './list-crypto-sectors';
import { listDefiTokens } from './list-defi-tokens';
import { listAiTokens } from './list-ai-tokens';
import { listOtherTokens } from './list-other-tokens';
import { getFearGreedIndex } from './get-fear-greed-index';
import { listEarningsCalendar } from './list-earnings-calendar';
import { getCotPositioning } from './get-cot-positioning';
import { getInsiderTransactions } from './get-insider-transactions';
import { getMarketBreadthHistory } from './get-market-breadth-history';
import { getGoldIntelligence } from './get-gold-intelligence';
import { getHyperliquidFlow } from './get-hyperliquid-flow';

export const marketHandler: MarketServiceHandler = {
  listMarketQuotes,
  listCryptoQuotes,
  listCommodityQuotes,
  getSectorSummary,
  listStablecoinMarkets,
  listEtfFlows,
  getCountryStockIndex,
  listGulfQuotes,
  analyzeStock,
  getStockAnalysisHistory,
  backtestStock,
  listStoredStockBacktests,
  listCryptoSectors,
  listDefiTokens,
  listAiTokens,
  listOtherTokens,
  getFearGreedIndex,
  listEarningsCalendar,
  getCotPositioning,
  getInsiderTransactions,
  getMarketBreadthHistory,
  getGoldIntelligence,
  getHyperliquidFlow,
};
