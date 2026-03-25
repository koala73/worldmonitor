import type {
  ListStoredStockBacktestsRequest,
  ListStoredStockBacktestsResponse,
  MarketServiceHandler,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { parseStringArray } from './_shared';
import { getStoredStockBacktestSnapshots } from './premium-stock-store';

const DEFAULT_EVAL_WINDOW_DAYS = 10;

export const listStoredStockBacktests: MarketServiceHandler['listStoredStockBacktests'] = async (
  _ctx,
  req: ListStoredStockBacktestsRequest,
): Promise<ListStoredStockBacktestsResponse> => {
  const symbols = parseStringArray(req.symbols).slice(0, 8);
  const evalWindowDays = Math.max(3, Math.min(30, req.evalWindowDays || DEFAULT_EVAL_WINDOW_DAYS));
  const items = await getStoredStockBacktestSnapshots(symbols, evalWindowDays);
  return { items };
};
