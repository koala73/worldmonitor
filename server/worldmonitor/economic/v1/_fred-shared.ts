import type { FredSeries } from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

export const FRED_KEY_PREFIX = 'economic:fred:v1';

export function fredSeedKey(seriesId: string): string {
  return `${FRED_KEY_PREFIX}:${seriesId}:0`;
}

export function normalizeFredLimit(limit: number): number {
  return limit > 0 ? Math.min(limit, 1000) : 120;
}

export function applyFredObservationLimit(series: FredSeries, limit: number): FredSeries {
  if (limit > 0 && series.observations.length > limit) {
    return { ...series, observations: series.observations.slice(-limit) };
  }
  return series;
}
