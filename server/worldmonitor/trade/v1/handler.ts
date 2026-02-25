import type { TradeServiceHandler } from '../../../../src/generated/server/worldmonitor/trade/v1/service_server';

import { getTradeRestrictions } from './get-trade-restrictions';
import { getTariffTrends } from './get-tariff-trends';
import { getTradeFlows } from './get-trade-flows';
import { getTradeBarriers } from './get-trade-barriers';

export const tradeHandler: TradeServiceHandler = {
  getTradeRestrictions,
  getTariffTrends,
  getTradeFlows,
  getTradeBarriers,
};
