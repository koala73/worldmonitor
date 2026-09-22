import type {
  GetUsInterestRatesRequest,
  GetUsInterestRatesResponse,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson, getCachedJsonBatch } from '../../../_shared/redis';
import {
  RATE_SERIES,
  RATES_CANONICAL_KEY,
  RATES_DECADES,
  type RateHistories,
  type RateSeriesId,
  buildUsInterestRates,
  mergeRateHistories,
  pointsFromShard,
  rateSeriesDecadeKey,
  snapshotFromSeed,
} from './us-interest-rates';

const UNAVAILABLE: GetUsInterestRatesResponse = { series: [], unavailable: true };

async function readHistories(): Promise<RateHistories> {
  const keys = RATE_SERIES.flatMap((series) => (
    RATES_DECADES.map((decade) => rateSeriesDecadeKey(series.id, decade))
  ));
  const shards = await getCachedJsonBatch(keys, true);
  const pairs: Array<[string, ReturnType<typeof pointsFromShard>]> = [];
  for (const [key, value] of shards.entries()) {
    pairs.push([key, pointsFromShard(value)]);
  }
  return mergeRateHistories(pairs);
}

function hasHistoryPoints(histories: RateHistories): boolean {
  return Object.values(histories).some((points) => points.length > 0);
}

export async function getUsInterestRates(
  _ctx: ServerContext,
  req: GetUsInterestRatesRequest,
): Promise<GetUsInterestRatesResponse> {
  try {
    const snapshot = snapshotFromSeed(await getCachedJson(RATES_CANONICAL_KEY, true));
    if (req.history !== true) {
      if (!snapshot) return UNAVAILABLE;
      return buildUsInterestRates(snapshot, undefined, false);
    }
    const histories = await readHistories();
    // Pipeline timeout/HTTP error returns an empty Map without throwing. Merging
    // the snapshot into that empty history would emit latest-only points with
    // unavailable=false, which the daily gateway cache can store as "full history".
    if (!hasHistoryPoints(histories)) return UNAVAILABLE;
    return buildUsInterestRates(snapshot, histories, true);
  } catch {
    return UNAVAILABLE;
  }
}

export function rateSeriesIds(): RateSeriesId[] {
  return RATE_SERIES.map((series) => series.id);
}
