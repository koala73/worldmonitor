import type {
  GetUsInterestRatesResponse,
  UsInterestRateObservation,
  UsInterestRateSeries,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

export const RATES_CANONICAL_KEY = 'economic:us-interest-rates:v1';
export const RATES_ACTIVATION_KEY = 'seed-activated:economic:us-interest-rates';
export const RATES_DECADES = [1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020, 2030] as const;

export const RATE_SERIES = [
  { id: 'fedFundsEffective', wireId: 'fed_funds_effective', fredId: 'DFF', redisSuffix: 'fed-funds-effective' },
  { id: 'fedFundsTargetLower', wireId: 'fed_funds_target_lower', fredId: 'DFEDTARL', redisSuffix: 'fed-funds-target-lower' },
  { id: 'fedFundsTargetUpper', wireId: 'fed_funds_target_upper', fredId: 'DFEDTARU', redisSuffix: 'fed-funds-target-upper' },
  { id: 'treasuryOneMonth', wireId: 'treasury_one_month', fredId: 'DGS1MO', redisSuffix: 'treasury-one-month' },
  { id: 'treasuryThreeMonth', wireId: 'treasury_three_month', fredId: 'DGS3MO', redisSuffix: 'treasury-three-month' },
  { id: 'treasurySixMonth', wireId: 'treasury_six_month', fredId: 'DGS6MO', redisSuffix: 'treasury-six-month' },
  { id: 'treasuryOneYear', wireId: 'treasury_one_year', fredId: 'DGS1', redisSuffix: 'treasury-one-year' },
  { id: 'treasuryTwoYear', wireId: 'treasury_two_year', fredId: 'DGS2', redisSuffix: 'treasury-two-year' },
  { id: 'treasuryFiveYear', wireId: 'treasury_five_year', fredId: 'DGS5', redisSuffix: 'treasury-five-year' },
  { id: 'treasuryTenYear', wireId: 'treasury_ten_year', fredId: 'DGS10', redisSuffix: 'treasury-ten-year' },
  { id: 'treasuryThirtyYear', wireId: 'treasury_thirty_year', fredId: 'DGS30', redisSuffix: 'treasury-thirty-year' },
  { id: 'sofr', wireId: 'sofr', fredId: 'SOFR', redisSuffix: 'sofr' },
] as const;

export type RateSeriesId = (typeof RATE_SERIES)[number]['id'];

export interface RatePoint {
  date: string;
  value: number;
}

export type RateSnapshot = Partial<Record<RateSeriesId, RatePoint>>;
export type RateHistories = Partial<Record<RateSeriesId, RatePoint[]>>;

const SERIES_IDS = new Set<string>(RATE_SERIES.map((series) => series.id));

export function rateSeriesDecadeKey(id: RateSeriesId, decade: number): string {
  const series = RATE_SERIES.find((item) => item.id === id);
  return `${RATES_CANONICAL_KEY}:${series?.redisSuffix ?? id}:${decade}`;
}

export function rateDateMs(isoDate: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return undefined;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(ms) ? ms : undefined;
}

export function toRateObservation(point: RatePoint | undefined): UsInterestRateObservation | undefined {
  if (!point || !Number.isFinite(point.value)) return undefined;
  const date = rateDateMs(point.date);
  if (date == null) return undefined;
  return { date, percent: point.value };
}

function seriesId(value: string): RateSeriesId | undefined {
  return SERIES_IDS.has(value) ? value as RateSeriesId : undefined;
}

export function normalizeRatePoints(points: RatePoint[] | undefined): RatePoint[] {
  const byDate = new Map<string, number>();
  for (const point of points ?? []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(point?.date ?? '') || !Number.isFinite(point.value)) continue;
    byDate.set(point.date, point.value);
  }
  return [...byDate.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([date, value]) => ({ date, value }));
}

export function latestRatePoint(points: RatePoint[] | undefined): RatePoint | undefined {
  const normalized = normalizeRatePoints(points);
  return normalized.length > 0 ? normalized[normalized.length - 1] : undefined;
}

function wireSeries(id: string, points: UsInterestRateObservation[]): UsInterestRateSeries | undefined {
  if (points.length === 0) return undefined;
  return { id, points };
}

export function buildUsInterestRates(
  snapshot: RateSnapshot | undefined,
  histories: RateHistories | undefined,
  history: boolean,
): GetUsInterestRatesResponse {
  const series: UsInterestRateSeries[] = [];
  for (const item of RATE_SERIES) {
    const snapshotPoint = snapshot?.[item.id];
    const historyPoints = histories?.[item.id] ?? [];
    const source = history
      ? normalizeRatePoints(snapshotPoint ? [...historyPoints, snapshotPoint] : historyPoints)
      : [snapshotPoint ?? latestRatePoint(historyPoints)].filter((point): point is RatePoint => point != null);
    const points = source
      .map((point) => toRateObservation(point))
      .filter((point): point is UsInterestRateObservation => point != null);
    const row = wireSeries(item.wireId, points);
    if (row) series.push(row);
  }
  if (series.length === 0) return { series: [], unavailable: true };
  return { series, unavailable: false };
}

export function pointsFromShard(value: unknown): RatePoint[] {
  if (!value || typeof value !== 'object' || !('points' in value)) return [];
  const points = (value as { points?: unknown }).points;
  if (!Array.isArray(points)) return [];
  return points.flatMap((point) => {
    if (!point || typeof point !== 'object') return [];
    const date = 'date' in point ? String(point.date) : '';
    const raw = 'value' in point ? Number(point.value) : Number.NaN;
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(raw) ? [{ date, value: raw }] : [];
  });
}

export function snapshotFromSeed(value: unknown): RateSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const snapshot: RateSnapshot = {};
  for (const [key, point] of Object.entries(value)) {
    const id = seriesId(key);
    if (!id || !point || typeof point !== 'object') continue;
    const date = 'date' in point ? String(point.date) : '';
    const raw = 'value' in point ? Number(point.value) : Number.NaN;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(raw)) continue;
    snapshot[id] = { date, value: raw };
  }
  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

export function mergeRateHistories(shards: Iterable<[string, RatePoint[]]>): RateHistories {
  const grouped: RateHistories = {};
  for (const [key, points] of shards) {
    const match = /^economic:us-interest-rates:v1:([a-z0-9-]+):\d{4}$/.exec(key);
    const series = RATE_SERIES.find((item) => item.redisSuffix === match?.[1]);
    if (!series) continue;
    grouped[series.id] = [...(grouped[series.id] ?? []), ...points];
  }
  for (const series of RATE_SERIES) {
    if (grouped[series.id]) grouped[series.id] = normalizeRatePoints(grouped[series.id]);
  }
  return grouped;
}
