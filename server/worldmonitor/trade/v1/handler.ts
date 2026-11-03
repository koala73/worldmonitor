import type { TradeServiceHandler } from '../../../../src/generated/server/worldmonitor/trade/v1/service_server';

import { getTradeRestrictions } from './get-trade-restrictions';
import { getTariffTrends } from './get-tariff-trends';
import { getBilateralTariff } from './get-bilateral-tariff';
import { getUsImportDuty } from './get-us-import-duty';
import { getTradeFlows } from './get-trade-flows';
import { getTradeBarriers } from './get-trade-barriers';
import { getCustomsRevenue } from './get-customs-revenue';
import { listComtradeFlows } from './list-comtrade-flows';

export const tradeHandler: TradeServiceHandler = {
  getTradeRestrictions,
  getTariffTrends,
  getBilateralTariff,
  getUsImportDuty,
  getTradeFlows,
  getTradeBarriers,
  getCustomsRevenue,
  listComtradeFlows,
};
