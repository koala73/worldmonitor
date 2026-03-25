import type {
  ListConsumerPriceCategoriesRequest,
  ListConsumerPriceCategoriesResponse,
} from '../../../../src/generated/server/worldmonitor/consumer_prices/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const DEFAULT_MARKET = 'ae';
const DEFAULT_RANGE = '30d';
const VALID_RANGES = new Set(['7d', '30d', '90d', '180d']);

export async function listConsumerPriceCategories(
  _ctx: unknown,
  req: ListConsumerPriceCategoriesRequest,
): Promise<ListConsumerPriceCategoriesResponse> {
  const market = req.marketCode || DEFAULT_MARKET;
  const range = VALID_RANGES.has(req.range ?? '') ? req.range! : DEFAULT_RANGE;
  const key = `consumer-prices:categories:${market}:${range}`;

  const EMPTY: ListConsumerPriceCategoriesResponse = {
    marketCode: market,
    asOf: '0',
    range,
    categories: [],
    upstreamUnavailable: true,
  };

  try {
    const result = await getCachedJson(key, true) as ListConsumerPriceCategoriesResponse | null;
    return result ?? EMPTY;
  } catch {
    return EMPTY;
  }
}
