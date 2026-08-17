import type {
  ResilienceServiceHandler,
  ServerContext,
  GetFoodStocksRequest,
  GetFoodStocksResponse,
} from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';
import {
  FOOD_STOCKS_CANONICAL_KEY,
  FOOD_STOCKS_WORLD_KEY,
  flattenSnapshot,
  normalizeFoodStocksCommodity,
  normalizeFoodStocksCountry,
} from './_food-stocks-query';

const EMPTY: GetFoodStocksResponse = {
  records: [],
  fetchedAt: '',
  unavailable: true,
  calorieWeightedStocksToUse: 0,
};

export { normalizeFoodStocksCommodity, normalizeFoodStocksCountry };


export const getFoodStocks: ResilienceServiceHandler['getFoodStocks'] = async (
  ctx: ServerContext,
  req: GetFoodStocksRequest,
): Promise<GetFoodStocksResponse> => {
  const countryCode = normalizeFoodStocksCountry(req.countryCode ?? '');
  if (countryCode === null) {
    throw new ValidationError([{
      field: 'countryCode',
      description: 'countryCode must be a 2-letter ISO 3166-1 alpha-2 code or WORLD',
    }]);
  }
  const commodity = normalizeFoodStocksCommodity(req.commodity ?? '');
  if (commodity === null) {
    throw new ValidationError([{
      field: 'commodity',
      description: 'commodity must be one of wheat, corn, rice, soybeans, barley, palmOil',
    }]);
  }

  try {
    const snapshot = await getCachedJson(FOOD_STOCKS_CANONICAL_KEY, true) as Record<string, unknown> | null;
    if (!snapshot || typeof snapshot !== 'object') {
      return markNoStoreFallbackResponse(ctx.request, EMPTY);
    }

    const records = flattenSnapshot(
      snapshot,
      countryCode || undefined,
      commodity || undefined,
    ).map((row) => ({
      countryCode: row.countryCode === FOOD_STOCKS_WORLD_KEY ? 'WORLD' : row.countryCode,
      commodity: row.commodity,
      marketingYear: row.marketingYear,
      stocksToUse: row.stocksToUse,
      hasStocksToUse: row.hasStocksToUse,
      endingStocksTmt: row.endingStocksTmt,
      hasEndingStocks: row.hasEndingStocks,
      totalUseTmt: row.totalUseTmt,
      productionTmt: row.productionTmt,
      consumptionTmt: row.consumptionTmt,
      importsTmt: row.importsTmt,
      exportsTmt: row.exportsTmt,
      unit: row.unit,
      source: row.source,
    }));

    // `unavailable` means "the seed is missing or unreadable", per the proto.
    // The snapshot loaded, so an empty result is a confirmed zero regardless of
    // whether a filter was applied — returning unavailable:true for the
    // unfiltered case contradicted the field's documented meaning and made a
    // healthy-but-empty snapshot look like an outage.
    if (records.length === 0) {
      return {
        records: [],
        fetchedAt: typeof snapshot.fetchedAt === 'string' ? snapshot.fetchedAt : '',
        unavailable: false,
        calorieWeightedStocksToUse: 0,
      };
    }

    const countryEntry = countryCode
      ? (snapshot[countryCode] as { aggregate?: { calorieWeightedStocksToUse?: number | null } } | undefined)
      : undefined;
    const calorie = countryEntry?.aggregate?.calorieWeightedStocksToUse;

    return {
      records,
      fetchedAt: typeof snapshot.fetchedAt === 'string' ? snapshot.fetchedAt : '',
      unavailable: false,
      calorieWeightedStocksToUse: Number.isFinite(calorie) ? Number(calorie) : 0,
    };
  } catch {
    return markNoStoreFallbackResponse(ctx.request, EMPTY);
  }
};
