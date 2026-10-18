import type {
  GetConsumerPriceBasketSeriesRequest,
  GetConsumerPriceBasketSeriesResponse,
} from '../../../../src/generated/server/worldmonitor/consumer_prices/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

import { resolveConsumerPriceSelection } from './_selection';
const DEFAULT_RANGE = '30d';

const VALID_RANGES = new Set(['7d', '30d', '90d']);

export async function getConsumerPriceBasketSeries(
  _ctx: unknown,
  req: GetConsumerPriceBasketSeriesRequest,
): Promise<GetConsumerPriceBasketSeriesResponse> {
  const { market, basket } = resolveConsumerPriceSelection(req.marketCode, req.basketSlug);
  const range = VALID_RANGES.has(req.range ?? '') ? req.range! : DEFAULT_RANGE;

  const key = `consumer-prices:basket-series:${market}:${basket}:${range}`;

  const EMPTY: GetConsumerPriceBasketSeriesResponse = {
    marketCode: market,
    basketSlug: basket,
    asOf: '0',
    currencyCode: 'AED',
    range,
    essentialsSeries: [],
    valueSeries: [],
    upstreamUnavailable: true,
  };

  try {
    const result = await getCachedJson(key, true) as GetConsumerPriceBasketSeriesResponse | null;
    return result ?? EMPTY;
  } catch {
    return EMPTY;
  }
}
