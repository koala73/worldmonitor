import { getRpcBaseUrl } from '@/services/rpc-client';
import {
  ConsumerPricesServiceClient,
  type GetConsumerPriceOverviewResponse,
  type GetConsumerPriceBasketSeriesResponse,
  type ListConsumerPriceCategoriesResponse,
  type ListConsumerPriceMoversResponse,
  type ListRetailerPriceSpreadsResponse,
  type GetConsumerPriceFreshnessResponse,
  type CategorySnapshot,
  type PriceMover,
  type RetailerSpread,
  type BasketPoint,
  type RetailerFreshnessInfo,
} from '@/generated/client/worldmonitor/consumer_prices/v1/service_client';
import { createCircuitBreaker } from '@/utils';
import { getHydratedData } from '@/services/bootstrap';

export type {
  GetConsumerPriceOverviewResponse,
  GetConsumerPriceBasketSeriesResponse,
  ListConsumerPriceCategoriesResponse,
  ListConsumerPriceMoversResponse,
  ListRetailerPriceSpreadsResponse,
  GetConsumerPriceFreshnessResponse,
  CategorySnapshot,
  PriceMover,
  RetailerSpread,
  BasketPoint,
  RetailerFreshnessInfo,
};

export const DEFAULT_MARKET = 'all';
export const DEFAULT_BASKET = 'essentials-ae';

export const MARKETS: Array<{ code: string; label: string }> = [
  { code: 'all', label: '🌍 All' },
  { code: 'ae', label: '🇦🇪 UAE' },
  { code: 'au', label: '🇦🇺 AU' },
  { code: 'br', label: '🇧🇷 BR' },
  { code: 'gb', label: '🇬🇧 UK' },
  { code: 'in', label: '🇮🇳 IN' },
  { code: 'sa', label: '🇸🇦 SA' },
  { code: 'sg', label: '🇸🇬 SG' },
  { code: 'us', label: '🇺🇸 US' },
];

export const SINGLE_MARKETS = MARKETS.filter((m) => m.code !== 'all');

const client = new ConsumerPricesServiceClient(getRpcBaseUrl(), {
  fetch: (...args) => globalThis.fetch(...args),
});

const overviewBreaker = createCircuitBreaker<GetConsumerPriceOverviewResponse>({
  name: 'Consumer Prices Overview',
  cacheTtlMs: 30 * 60 * 1000,
  persistCache: true,
});
const seriesBreaker = createCircuitBreaker<GetConsumerPriceBasketSeriesResponse>({
  name: 'Consumer Prices Series',
  cacheTtlMs: 60 * 60 * 1000,
  persistCache: true,
});
const categoriesBreaker = createCircuitBreaker<ListConsumerPriceCategoriesResponse>({
  name: 'Consumer Prices Categories',
  cacheTtlMs: 30 * 60 * 1000,
  persistCache: true,
});
const moversBreaker = createCircuitBreaker<ListConsumerPriceMoversResponse>({
  name: 'Consumer Prices Movers',
  cacheTtlMs: 30 * 60 * 1000,
  persistCache: true,
});
const spreadBreaker = createCircuitBreaker<ListRetailerPriceSpreadsResponse>({
  name: 'Consumer Prices Spread',
  cacheTtlMs: 30 * 60 * 1000,
  persistCache: true,
});
const freshnessBreaker = createCircuitBreaker<GetConsumerPriceFreshnessResponse>({
  name: 'Consumer Prices Freshness',
  cacheTtlMs: 10 * 60 * 1000,
  persistCache: true,
});

const emptyOverview: GetConsumerPriceOverviewResponse = {
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

const emptySeries: GetConsumerPriceBasketSeriesResponse = {
  marketCode: DEFAULT_MARKET,
  basketSlug: DEFAULT_BASKET,
  asOf: '0',
  currencyCode: 'AED',
  range: '30d',
  essentialsSeries: [],
  valueSeries: [],
  upstreamUnavailable: true,
};

const emptyCategories: ListConsumerPriceCategoriesResponse = {
  marketCode: DEFAULT_MARKET,
  asOf: '0',
  range: '30d',
  categories: [],
  upstreamUnavailable: true,
};

const emptyMovers: ListConsumerPriceMoversResponse = {
  marketCode: DEFAULT_MARKET,
  asOf: '0',
  range: '30d',
  risers: [],
  fallers: [],
  upstreamUnavailable: true,
};

const emptySpread: ListRetailerPriceSpreadsResponse = {
  marketCode: DEFAULT_MARKET,
  asOf: '0',
  basketSlug: DEFAULT_BASKET,
  currencyCode: 'AED',
  retailers: [],
  spreadPct: 0,
  upstreamUnavailable: true,
};

const emptyFreshness: GetConsumerPriceFreshnessResponse = {
  marketCode: DEFAULT_MARKET,
  asOf: '0',
  retailers: [],
  overallFreshnessMin: 0,
  stalledCount: 0,
  upstreamUnavailable: true,
};

export async function fetchConsumerPriceOverview(
  marketCode = DEFAULT_MARKET,
  basketSlug = DEFAULT_BASKET,
): Promise<GetConsumerPriceOverviewResponse> {
  // Bootstrap hydration only valid for the default market
  if (marketCode === DEFAULT_MARKET) {
    const hydrated = getHydratedData('consumerPricesOverview') as GetConsumerPriceOverviewResponse | undefined;
    if (hydrated?.asOf && !hydrated.upstreamUnavailable) return hydrated;
  }

  try {
    return await overviewBreaker.execute(
      () => client.getConsumerPriceOverview({ marketCode, basketSlug }),
      emptyOverview,
      { cacheKey: `${marketCode}:${basketSlug}` },
    );
  } catch {
    return emptyOverview;
  }
}

export async function fetchConsumerPriceBasketSeries(
  marketCode = DEFAULT_MARKET,
  basketSlug = DEFAULT_BASKET,
  range = '30d',
): Promise<GetConsumerPriceBasketSeriesResponse> {
  try {
    return await seriesBreaker.execute(
      () => client.getConsumerPriceBasketSeries({ marketCode, basketSlug, range }),
      emptySeries,
      { cacheKey: `${marketCode}:${basketSlug}:${range}` },
    );
  } catch {
    return { ...emptySeries, range };
  }
}

export async function fetchConsumerPriceCategories(
  marketCode = DEFAULT_MARKET,
  basketSlug = DEFAULT_BASKET,
  range = '30d',
): Promise<ListConsumerPriceCategoriesResponse> {
  if (marketCode === DEFAULT_MARKET) {
    const hydrated = getHydratedData('consumerPricesCategories') as ListConsumerPriceCategoriesResponse | undefined;
    if (hydrated?.categories?.length) return hydrated;
  }

  try {
    return await categoriesBreaker.execute(
      () => client.listConsumerPriceCategories({ marketCode, basketSlug, range }),
      emptyCategories,
      { cacheKey: `${marketCode}:${basketSlug}:${range}` },
    );
  } catch {
    return emptyCategories;
  }
}

export async function fetchConsumerPriceMovers(
  marketCode = DEFAULT_MARKET,
  range = '30d',
  categorySlug?: string,
): Promise<ListConsumerPriceMoversResponse> {
  if (marketCode === DEFAULT_MARKET) {
    const hydrated = getHydratedData('consumerPricesMovers') as ListConsumerPriceMoversResponse | undefined;
    if (hydrated?.risers?.length || hydrated?.fallers?.length) return hydrated;
  }

  try {
    return await moversBreaker.execute(
      () => client.listConsumerPriceMovers({ marketCode, range, categorySlug: categorySlug ?? '', limit: 10 }),
      emptyMovers,
      { cacheKey: `${marketCode}:${range}:${categorySlug ?? ''}` },
    );
  } catch {
    return emptyMovers;
  }
}

export async function fetchRetailerPriceSpreads(
  marketCode = DEFAULT_MARKET,
  basketSlug = DEFAULT_BASKET,
): Promise<ListRetailerPriceSpreadsResponse> {
  if (marketCode === DEFAULT_MARKET) {
    const hydrated = getHydratedData('consumerPricesSpread') as ListRetailerPriceSpreadsResponse | undefined;
    if (hydrated?.retailers?.length) return hydrated;
  }

  try {
    return await spreadBreaker.execute(
      () => client.listRetailerPriceSpreads({ marketCode, basketSlug }),
      emptySpread,
      { cacheKey: `${marketCode}:${basketSlug}` },
    );
  } catch {
    return emptySpread;
  }
}

export async function fetchConsumerPriceFreshness(
  marketCode = DEFAULT_MARKET,
): Promise<GetConsumerPriceFreshnessResponse> {
  try {
    return await freshnessBreaker.execute(
      () => client.getConsumerPriceFreshness({ marketCode }),
      emptyFreshness,
      { cacheKey: marketCode },
    );
  } catch {
    return emptyFreshness;
  }
}

export async function fetchAllMarketsOverview(): Promise<GetConsumerPriceOverviewResponse[]> {
  return Promise.all(
    SINGLE_MARKETS.map((m) => fetchConsumerPriceOverview(m.code, `essentials-${m.code}`)),
  );
}
