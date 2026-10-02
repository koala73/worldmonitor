import {
  ApiError,
  type ListStoredStockBacktestsRequest,
  type ListStoredStockBacktestsResponse,
  type MarketServiceHandler,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { STOCK_ANALYSIS_PRO_LIMIT } from '../../../../src/services/stock-analysis-targets';
import { parseStringArray } from './_shared';
import { getStoredStockBacktestSnapshots } from './premium-stock-store';

const DEFAULT_EVAL_WINDOW_DAYS = 10;

export const listStoredStockBacktests: MarketServiceHandler['listStoredStockBacktests'] = async (
  _ctx,
  req: ListStoredStockBacktestsRequest,
): Promise<ListStoredStockBacktestsResponse> => {
  const symbols = parseStringArray(req.symbols);
  // Same contract as stored analysis history: reject an oversized list instead
  // of returning the first 8 and letting the client treat the rest as stale.
  if (symbols.length > STOCK_ANALYSIS_PRO_LIMIT) {
    throw new ApiError(400, `symbols must contain at most ${STOCK_ANALYSIS_PRO_LIMIT} item(s)`, '');
  }
  const evalWindowDays = Math.max(3, Math.min(30, req.evalWindowDays || DEFAULT_EVAL_WINDOW_DAYS));
  const items = await getStoredStockBacktestSnapshots(symbols, evalWindowDays);
  return { items };
};
