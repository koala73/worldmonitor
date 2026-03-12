import type {
  GetStockAnalysisHistoryRequest,
  GetStockAnalysisHistoryResponse,
  MarketServiceHandler,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { parseStringArray } from './_shared';
import { getStoredStockAnalysisHistory } from './premium-stock-store';

const DEFAULT_LIMIT_PER_SYMBOL = 4;
const MAX_LIMIT_PER_SYMBOL = 32;

export const getStockAnalysisHistory: MarketServiceHandler['getStockAnalysisHistory'] = async (
  _ctx,
  req: GetStockAnalysisHistoryRequest,
): Promise<GetStockAnalysisHistoryResponse> => {
  const symbols = parseStringArray(req.symbols).slice(0, 8);
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
