import type {
  GetConsumerPriceOverviewRequest,
  GetConsumerPriceOverviewResponse,
} from '../../../../src/generated/server/worldmonitor/consumer_prices/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const DEFAULT_MARKET = 'ae';

const EMPTY: GetConsumerPriceOverviewResponse = {
  marketCode: DEFAULT_MARKET,
  asOf: '0',
  currencyCode: 'AED',
  essentialsIndex: 0,
  valueBasketIndex: 0,
  wowPct: 0,
  momPct: 0,
  retailerSpreadPct: 0,
  coveragePct: 0,
  freshnessLagMin: 0,
  topCategories: [],
  upstreamUnavailable: true,
};

export async function getConsumerPriceOverview(
  _ctx: unknown,
  req: GetConsumerPriceOverviewRequest,
): Promise<GetConsumerPriceOverviewResponse> {
  const market = req.marketCode || DEFAULT_MARKET;
  const key = `consumer-prices:overview:${market}`;

  try {
    const result = await getCachedJson(key, true) as GetConsumerPriceOverviewResponse | null;
    return result ?? { ...EMPTY, marketCode: market };
  } catch {
    return { ...EMPTY, marketCode: market };
  }
}
