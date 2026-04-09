import type {
  ListRetailerPriceSpreadsRequest,
  ListRetailerPriceSpreadsResponse,
} from '../../../../src/generated/server/worldmonitor/consumer_prices/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const DEFAULT_MARKET = 'ae';
const DEFAULT_BASKET = 'essentials-ae';

export async function listRetailerPriceSpreads(
  _ctx: unknown,
  req: ListRetailerPriceSpreadsRequest,
): Promise<ListRetailerPriceSpreadsResponse> {
  const market = req.marketCode || DEFAULT_MARKET;
  const basket = req.basketSlug || DEFAULT_BASKET;
  const key = `consumer-prices:retailer-spread:${market}:${basket}`;

  const EMPTY: ListRetailerPriceSpreadsResponse = {
    marketCode: market,
    asOf: '0',
    basketSlug: basket,
    currencyCode: 'AED',
    retailers: [],
    spreadPct: 0,
    upstreamUnavailable: true,
  };

  try {
    const result = await getCachedJson(key, true) as ListRetailerPriceSpreadsResponse | null;
    return result ?? EMPTY;
  } catch {
    return EMPTY;
  }
}
