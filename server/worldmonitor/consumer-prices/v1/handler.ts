import type { ConsumerPricesServiceHandler } from '../../../../src/generated/server/worldmonitor/consumer_prices/v1/service_server';

import { getConsumerPriceOverview } from './get-consumer-price-overview';
import { getConsumerPriceBasketSeries } from './get-consumer-price-basket-series';
import { listConsumerPriceCategories } from './list-consumer-price-categories';
import { listConsumerPriceMovers } from './list-consumer-price-movers';
import { listRetailerPriceSpreads } from './list-retailer-price-spreads';
import { getConsumerPriceFreshness } from './get-consumer-price-freshness';

export const consumerPricesHandler: ConsumerPricesServiceHandler = {
  getConsumerPriceOverview,
  getConsumerPriceBasketSeries,
  listConsumerPriceCategories,
  listConsumerPriceMovers,
  listRetailerPriceSpreads,
  getConsumerPriceFreshness,
};
