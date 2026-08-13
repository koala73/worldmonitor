export interface TimeSeriesPoint {
  timestamp: string;
  value: number;
}

export interface MarketCorrelationSeries {
  symbol: string;
  label: string;
  points: TimeSeriesPoint[];
}

export interface MarketCorrelationPayload {
  updatedAt: string;
  range: string;
  interval: string;
  series: MarketCorrelationSeries[];
  failures?: Array<{ symbol: string; reason: string }>;
}

function isTimeSeriesPoint(value: unknown): value is TimeSeriesPoint {
  if (!value || typeof value !== 'object') return false;
  const point = value as Partial<TimeSeriesPoint>;
  return typeof point.timestamp === 'string' && Number.isFinite(point.value);
}

export function isMarketCorrelationPayload(value: unknown): value is MarketCorrelationPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<MarketCorrelationPayload>;
  if (
    typeof payload.updatedAt !== 'string'
    || typeof payload.range !== 'string'
    || typeof payload.interval !== 'string'
    || !Array.isArray(payload.series)
  ) return false;

  return payload.series.every((series) => Boolean(series)
    && typeof series === 'object'
    && typeof series.symbol === 'string'
    && typeof series.label === 'string'
    && Array.isArray(series.points)
    && series.points.every(isTimeSeriesPoint));
}

export interface ConfidenceInterval {
  low: number;
  high: number;
}

export type CorrelationRelationship =
  | 'insufficient-data'
  | 'none'
  | 'weak-positive'
  | 'weak-negative'
  | 'moderate-positive'
  | 'moderate-negative'
  | 'strong-positive'
  | 'strong-negative';

export interface LeadLagSummary {
  relationship: 'news-leads' | 'market-leads' | 'neither';
  hours: number;
  coefficient: number | null;
  sampleSize: number;
  confidenceInterval: ConfidenceInterval | null;
}

export interface NewsMarketCorrelationResult {
  coefficient: number | null;
  sampleSize: number;
  confidenceInterval: ConfidenceInterval | null;
  relationship: CorrelationRelationship;
  leadLag: LeadLagSummary;
  alignedPoints: Array<{
    timestamp: string;
    newsValue: number;
    marketPrice: number;
    marketReturn: number;
  }>;
}

export interface CorrelationOptions {
  windowHours: number;
  maxLagHours?: number;
  bucketMs?: number;
}

const DEFAULT_BUCKET_MS = 60 * 60 * 1000;
const MIN_SAMPLE_SIZE = 4;
const MIN_LAG_SAMPLE_SIZE = 8;

export function parseSeriesTimestamp(value: string): number {
  const compact = value.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})$/);
  if (compact) {
    return Date.UTC(
      Number(compact[1]),
      Number(compact[2]) - 1,
      Number(compact[3]),
      Number(compact[4]),
      Number(compact[5]),
      Number(compact[6]),
    );
  }
  return Date.parse(value);
}

function bucketAverage(points: TimeSeriesPoint[], bucketMs: number, cutoffMs: number): Map<number, number> {
  const grouped = new Map<number, { total: number; count: number }>();
  for (const point of points) {
    const timestampMs = parseSeriesTimestamp(point.timestamp);
    if (!Number.isFinite(timestampMs) || timestampMs < cutoffMs || !Number.isFinite(point.value)) continue;
    const bucket = Math.floor(timestampMs / bucketMs) * bucketMs;
    const current = grouped.get(bucket) ?? { total: 0, count: 0 };
    current.total += point.value;
    current.count += 1;
    grouped.set(bucket, current);
  }
  return new Map([...grouped].map(([bucket, value]) => [bucket, value.total / value.count]));
}

function bucketLatest(points: TimeSeriesPoint[], bucketMs: number, cutoffMs: number): Map<number, number> {
  const grouped = new Map<number, { timestampMs: number; value: number }>();
  for (const point of points) {
    const timestampMs = parseSeriesTimestamp(point.timestamp);
    if (!Number.isFinite(timestampMs) || timestampMs < cutoffMs || !Number.isFinite(point.value) || point.value <= 0) continue;
    const bucket = Math.floor(timestampMs / bucketMs) * bucketMs;
    const current = grouped.get(bucket);
    if (!current || timestampMs >= current.timestampMs) grouped.set(bucket, { timestampMs, value: point.value });
  }
  return new Map([...grouped].map(([bucket, value]) => [bucket, value.value]));
}

function pearson(left: number[], right: number[]): number | null {
  const n = Math.min(left.length, right.length);
  if (n < MIN_SAMPLE_SIZE) return null;
  const meanLeft = left.slice(0, n).reduce((sum, value) => sum + value, 0) / n;
  const meanRight = right.slice(0, n).reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let leftSquares = 0;
  let rightSquares = 0;
  for (let i = 0; i < n; i += 1) {
    const leftDelta = left[i]! - meanLeft;
    const rightDelta = right[i]! - meanRight;
    numerator += leftDelta * rightDelta;
    leftSquares += leftDelta * leftDelta;
    rightSquares += rightDelta * rightDelta;
  }
  const denominator = Math.sqrt(leftSquares * rightSquares);
  return denominator > 0 ? Math.max(-1, Math.min(1, numerator / denominator)) : null;
}

function fisherConfidenceInterval(coefficient: number | null, sampleSize: number): ConfidenceInterval | null {
  if (coefficient === null || sampleSize <= 3) return null;
  const bounded = Math.max(-0.999999, Math.min(0.999999, coefficient));
  const z = Math.atanh(bounded);
  const margin = 1.96 / Math.sqrt(sampleSize - 3);
  return {
    low: Math.max(-1, Math.tanh(z - margin)),
    high: Math.min(1, Math.tanh(z + margin)),
  };
}

function classifyRelationship(
  coefficient: number | null,
  confidenceInterval: ConfidenceInterval | null,
): CorrelationRelationship {
  if (coefficient === null || confidenceInterval === null) return 'insufficient-data';
  if (confidenceInterval.low <= 0 && confidenceInterval.high >= 0) return 'none';
  const direction = coefficient >= 0 ? 'positive' : 'negative';
  const magnitude = Math.abs(coefficient);
  if (magnitude < 0.2) return `weak-${direction}`;
  if (magnitude < 0.5) return `moderate-${direction}`;
  return `strong-${direction}`;
}

function maxTimestamp(points: TimeSeriesPoint[]): number {
  let maximum = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    const parsed = parseSeriesTimestamp(point.timestamp);
    if (Number.isFinite(parsed)) maximum = Math.max(maximum, parsed);
  }
  return maximum;
}

export function analyzeNewsMarketCorrelation(
  newsPoints: TimeSeriesPoint[],
  marketPoints: TimeSeriesPoint[],
  options: CorrelationOptions,
): NewsMarketCorrelationResult {
  const bucketMs = options.bucketMs ?? DEFAULT_BUCKET_MS;
  const maxLagHours = Math.max(0, Math.floor(options.maxLagHours ?? 6));
  const latestTimestamp = Math.max(maxTimestamp(newsPoints), maxTimestamp(marketPoints));
  const cutoffMs = Number.isFinite(latestTimestamp)
    ? latestTimestamp - Math.max(1, options.windowHours) * 60 * 60 * 1000
    : Number.POSITIVE_INFINITY;
  const news = bucketAverage(newsPoints, bucketMs, cutoffMs);
  const market = bucketLatest(marketPoints, bucketMs, cutoffMs);
  const marketEntries = [...market.entries()].sort(([left], [right]) => left - right);
  const returns = new Map<number, number>();

  for (let i = 1; i < marketEntries.length; i += 1) {
    const [previousTime, previousPrice] = marketEntries[i - 1]!;
    const [time, price] = marketEntries[i]!;
    if (time - previousTime !== bucketMs || previousPrice <= 0) continue;
    returns.set(time, (price - previousPrice) / previousPrice);
  }

  const alignedPoints: NewsMarketCorrelationResult['alignedPoints'] = [];
  for (const [timestampMs, marketReturn] of returns) {
    const newsValue = news.get(timestampMs);
    const marketPrice = market.get(timestampMs);
    if (newsValue === undefined || marketPrice === undefined) continue;
    alignedPoints.push({
      timestamp: new Date(timestampMs).toISOString(),
      newsValue,
      marketPrice,
      marketReturn,
    });
  }

  const coefficient = pearson(
    alignedPoints.map((point) => point.newsValue),
    alignedPoints.map((point) => point.marketReturn),
  );
  const confidenceInterval = fisherConfidenceInterval(coefficient, alignedPoints.length);

  let bestLag: LeadLagSummary = {
    relationship: 'neither',
    hours: 0,
    coefficient: null,
    sampleSize: 0,
    confidenceInterval: null,
  };
  let bestMagnitude = -1;

  for (let lagHours = -maxLagHours; lagHours <= maxLagHours; lagHours += 1) {
    const lagMs = lagHours * 60 * 60 * 1000;
    const left: number[] = [];
    const right: number[] = [];
    for (const [newsTime, newsValue] of news) {
      const marketReturn = returns.get(newsTime + lagMs);
      if (marketReturn === undefined) continue;
      left.push(newsValue);
      right.push(marketReturn);
    }
    const lagCoefficient = pearson(left, right);
    const magnitude = lagCoefficient === null ? -1 : Math.abs(lagCoefficient);
    if (magnitude > bestMagnitude) {
      bestMagnitude = magnitude;
      bestLag = {
        relationship: 'neither',
        hours: Math.abs(lagHours),
        coefficient: lagCoefficient,
        sampleSize: Math.min(left.length, right.length),
        confidenceInterval: fisherConfidenceInterval(lagCoefficient, Math.min(left.length, right.length)),
      };
      if (lagHours > 0) bestLag.relationship = 'news-leads';
      if (lagHours < 0) bestLag.relationship = 'market-leads';
    }
  }

  const lagClear = bestLag.sampleSize >= MIN_LAG_SAMPLE_SIZE
    && bestLag.coefficient !== null
    && Math.abs(bestLag.coefficient) >= 0.2
    && bestLag.confidenceInterval !== null
    && !(bestLag.confidenceInterval.low <= 0 && bestLag.confidenceInterval.high >= 0)
    && bestLag.hours > 0
    && bestMagnitude >= Math.abs(coefficient ?? 0) + 0.05;
  if (!lagClear || bestLag.hours === 0) {
    bestLag = { ...bestLag, relationship: 'neither', hours: 0 };
  }

  return {
    coefficient,
    sampleSize: alignedPoints.length,
    confidenceInterval,
    relationship: classifyRelationship(coefficient, confidenceInterval),
    leadLag: bestLag,
    alignedPoints,
  };
}
