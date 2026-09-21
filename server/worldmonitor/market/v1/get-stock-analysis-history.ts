import {
  ApiError,
  type GetStockAnalysisHistoryRequest,
  type GetStockAnalysisHistoryResponse,
  type MarketServiceHandler,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { STOCK_ANALYSIS_PRO_LIMIT } from '../../../../src/services/stock-analysis-targets';
import { parseStringArray } from './_shared';
import { getStoredStockAnalysisHistory } from './premium-stock-store';

const DEFAULT_LIMIT_PER_SYMBOL = 4;
const MAX_LIMIT_PER_SYMBOL = 32;

export const getStockAnalysisHistory: MarketServiceHandler['getStockAnalysisHistory'] = async (
  _ctx,
  req: GetStockAnalysisHistoryRequest,
): Promise<GetStockAnalysisHistoryResponse> => {
  const symbols = parseStringArray(req.symbols);
  // Pro watchlists hold up to STOCK_ANALYSIS_PRO_LIMIT symbols. Slicing here
  // used to drop the rest and look like a successful, complete history (#8353).
  if (symbols.length > STOCK_ANALYSIS_PRO_LIMIT) {
    throw new ApiError(400, `symbols must contain at most ${STOCK_ANALYSIS_PRO_LIMIT} item(s)`, '');
  }
  const limitPerSymbol = Math.max(1, Math.min(MAX_LIMIT_PER_SYMBOL, req.limitPerSymbol || DEFAULT_LIMIT_PER_SYMBOL));
  const history = await getStoredStockAnalysisHistory(symbols, !!req.includeNews, limitPerSymbol);

  return {
    items: Object.entries(history)
      .filter(([, snapshots]) => snapshots.length > 0)
      .map(([symbol, snapshots]) => ({
        symbol,
        snapshots,
      })),
  };
};
